from __future__ import annotations

import gzip
import hashlib
import heapq
import math
import platform
import subprocess
import sys
import threading
from collections.abc import Iterable
from dataclasses import dataclass
from itertools import dropwhile
from pathlib import Path
from types import TracebackType
from typing import BinaryIO, Literal, Self
from xml.etree import ElementTree as ET

import sumolib
import traci
from pydantic import BaseModel, ConfigDict, Field
from sumolib.miscutils import getFreeSocketPort
from traci import constants as tc
from traci.connection import Connection

from cityshift.contracts import ActivityAnchor, AnchorAccess, EntityTrack, PersonEvent, TravelClass
from cityshift.transport.hazards import edges_within
from cityshift.transport.runner import classify_vehicle, sample
from cityshift.transport.sumo_env import binary
from cityshift.transport.sumo_xml import PEDESTRIAN_SPEED_MPS, POPULATION_TYPES, write_routes, write_sumocfg

SAMPLE_VARS = [tc.VAR_POSITION, tc.VAR_ANGLE, tc.VAR_SPEED]
EXEMPT_TRAVEL_TIME_S = 1e7
CHECKPOINT_OPTIONS = (
    "save-state.rng", "save-state.transportables", "save-state.precision", "step-length",
    "pedestrian.model", "thread-rngs", "threads", "device.rerouting.threads",
)
RUNTIME_FILES = ("population.rou.xml", "population.sumocfg", "sumo.log", "tripinfo.xml", "vehroutes.xml")


def _sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class _CheckpointTrip(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    resident_id: str = Field(min_length=1)
    entity_id: str = Field(min_length=1)
    destination_id: str = Field(min_length=1)
    travel_class: TravelClass
    destination: AnchorAccess
    departed: bool


class _CheckpointHazard(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    edges: list[str]
    classes: list[str]
    until_s: int = Field(ge=1)


class _Checkpoint(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    version: Literal["population-mobility-1"]
    native_state_profile: Literal["sumo-1.27.1-striping-v1"]
    run_id: str
    net_file: str
    network_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    state_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    seed: int
    horizon_s: int = Field(ge=1)
    t: int = Field(ge=0)
    sequence: int = Field(ge=0)
    teleports: int = Field(ge=0)
    sumo_version: str
    traci_version: int
    platform: str
    runtime_options: dict[str, str]
    output_dirs: list[str] = Field(min_length=1)
    active: dict[str, _CheckpointTrip]
    residents: dict[str, str]
    tracks: dict[str, EntityTrack]
    events: list[PersonEvent]
    hazards: dict[str, _CheckpointHazard] = Field(default_factory=dict)
    blocked: dict[str, list[str]] = Field(default_factory=dict)
    replan: list[str] = Field(default_factory=list)
    held: list[str] = Field(default_factory=list)


@dataclass(frozen=True)
class MobilityOutcome:
    resident_id: str
    entity_id: str
    destination_id: str
    t: int
    status: Literal["arrived", "failed"]
    reason: str = ""


class _WalkLinks:
    """Which sidewalks meet at each junction, through its walking areas and crossings, as SUMO's walkers see it."""

    def __init__(self, net: sumolib.net.Net) -> None:
        parent: dict[tuple[str, str], tuple[str, str]] = {}

        def find(key: tuple[str, str]) -> tuple[str, str]:
            while parent.setdefault(key, key) != key:
                parent[key] = parent[parent[key]]
                key = parent[key]
            return key

        pedestrian_areas = {edge.getID() for edge in net.getEdges() if edge.getFunction() in {"walkingarea", "crossing"}}
        paved = set()
        for node in net.getNodes():
            for connection in node.getConnections():
                a, b = connection.getFrom().getID(), connection.getTo().getID()
                if a in pedestrian_areas or b in pedestrian_areas:
                    paved.add(node.getID())
                    left, right = find((node.getID(), a)), find((node.getID(), b))
                    if left != right:
                        parent[left] = right
        walkable = [edge for edge in net.getEdges() if not edge.isSpecial() and edge.allows("pedestrian")]
        for edge in walkable:
            for node in (edge.getFromNode().getID(), edge.getToNode().getID()):
                if node not in paved:
                    # Without walking areas SUMO lets a walker pass between any of the junction's walkable streets.
                    left, right = find((node, edge.getID())), find((node, ""))
                    if left != right:
                        parent[left] = right
        self.ends: dict[tuple[str, str], tuple[str, str]] = {}
        self.members: dict[tuple[str, str], list[tuple[str, str]]] = {}
        for edge in walkable:
            here, there = edge.getFromNode().getID(), edge.getToNode().getID()
            for node, other in ((here, there), (there, here)):
                if (node, edge.getID()) in parent:
                    root = find((node, edge.getID()))
                    self.ends[(node, edge.getID())] = root
                    self.members.setdefault(root, []).append((edge.getID(), other))
        for members in self.members.values():
            members.sort()


@dataclass(frozen=True)
class HazardFootprint:
    """An active hazard: streets within `radius_m` of its centre are closed to `classes` until `until_s`."""

    hazard_id: str
    lon: float
    lat: float
    radius_m: float
    classes: frozenset[str]
    until_s: int


@dataclass(frozen=True)
class RouteNotice:
    """A trip a closure changed: `diverted` onto a detour to the same destination, `blocked` with no detour, or
    `cleared` once nothing closed lies ahead of a blocked trip any more."""

    resident_id: str
    entity_id: str
    previous_entity_id: str | None
    status: Literal["diverted", "blocked", "cleared"]
    hazard_ids: tuple[str, ...]


@dataclass(frozen=True)
class _Hazard:
    edges: frozenset[str]
    classes: frozenset[str]
    until_s: int


@dataclass(frozen=True)
class _Route:
    origin: AnchorAccess
    destination: AnchorAccess
    edges: tuple[str, ...]
    duration_s: float
    distance_m: float


@dataclass
class _Trip:
    resident_id: str
    entity_id: str
    destination_id: str
    travel_class: TravelClass
    destination: AnchorAccess
    departed: bool = False


class PopulationMobility:
    def __init__(self, net_file: Path, run_dir: Path, run_id: str, seed: int, horizon_s: int):
        if horizon_s < 1:
            raise ValueError("horizon_s must be positive")
        self.net_file = Path(net_file).resolve()
        self._network_sha256 = _sha256(self.net_file)
        self.run_dir = Path(run_dir).resolve()
        self.output_dir = self.run_dir
        self._output_dirs: list[str] = []
        self._restored = False
        self.run_id = run_id
        self.seed = seed
        self.horizon_s = horizon_s
        self.net = sumolib.net.readNet(str(self.net_file), withInternal=True)
        if not self.net.hasGeoProj():
            raise ValueError("Population mobility requires a geographic network projection")
        self.t = 0
        self.tracks: dict[str, EntityTrack] = {}
        self.events: list[PersonEvent] = []
        self.teleports = 0
        self._conn: Connection | None = None
        self._process: subprocess.Popen | None = None
        self._log: BinaryIO | None = None
        self._owner: int | None = None
        self._closed = False
        self._sequence = 0
        self._active: dict[str, _Trip] = {}
        self._residents: dict[str, str] = {}
        self._hazards: dict[str, _Hazard] = {}
        self._street_closures: dict[str, frozenset[str]] = {}
        self._lane_closures: dict[str, frozenset[str]] = {}
        self._blocked_walk: frozenset[str] = frozenset()
        self._walk_trees: dict[tuple[str, float], tuple] = {}
        self._lane_disallowed: dict[str, tuple[str, ...]] = {}
        self._blocked: dict[str, tuple[str, ...]] = {}
        self._replan: set[str] = set()
        self._held: set[str] = set()
        self._exempt: set[str] = set()
        self._notices: list[RouteNotice] = []
        self._walk_links: _WalkLinks | None = None

    def open(self) -> Self:
        if self._closed:
            raise RuntimeError("Population mobility is closed")
        if self._conn is not None:
            self._require_open()
            return self
        self.run_dir.mkdir(parents=True, exist_ok=True)
        if any((self.run_dir / name).exists() for name in RUNTIME_FILES):
            continuation_root = self.run_dir / "mobility-continuations"
            continuation_root.mkdir(exist_ok=True)
            index = 1
            while True:
                candidate = continuation_root / f"{index:06d}"
                try:
                    candidate.mkdir()
                except FileExistsError:
                    index += 1
                else:
                    self.output_dir = candidate
                    break
        self._output_dirs = [str(self.output_dir)]
        routes = self.output_dir / "population.rou.xml"
        cfg = self.output_dir / "population.sumocfg"
        self._owner = threading.get_ident()
        self._log = (self.output_dir / "sumo.log").open("xb")
        try:
            write_routes(routes, [], [], [])
            route_tree = ET.parse(routes)
            for vtype in route_tree.findall("vType"):
                if vtype.get("id") == POPULATION_TYPES["pedestrian"]:
                    vtype.attrib.pop("maxSpeed", None)
                    vtype.set("desiredMaxSpeed", str(PEDESTRIAN_SPEED_MPS))
            route_tree.write(routes, encoding="utf-8", xml_declaration=True)
            write_sumocfg(cfg, self.net_file, routes, [], self.horizon_s, self.seed, self.output_dir / "tripinfo.xml")
            port = getFreeSocketPort()
            self._process = subprocess.Popen(
                [
                    binary("sumo"), "-c", str(cfg), "--remote-port", str(port), "--start",
                    "--ignore-route-errors", "false", "--save-state.rng", "true",
                    "--save-state.transportables", "true", "--save-state.precision", "17",
                ],
                stdout=self._log, stderr=subprocess.STDOUT,
            )
            self._conn = traci.connect(port, host="127.0.0.1", proc=self._process, numRetries=200, waitBetweenRetries=0.1)
            self._conn.getVersion()
        except Exception:
            self.close()
            raise
        return self

    def close(self) -> None:
        conn, self._conn = self._conn, None
        self._closed = True
        try:
            if conn is not None:
                conn.close(wait=False)
        except (traci.TraCIException, traci.FatalTraCIError, OSError):
            pass
        finally:
            if self._process is not None:
                try:
                    self._process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self._process.terminate()
                    try:
                        self._process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        self._process.kill()
                        self._process.wait()
                self._process = None
            if self._log is not None:
                self._log.close()
                self._log = None

    def __enter__(self) -> Self:
        return self.open()

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, traceback: TracebackType | None,
    ) -> None:
        self.close()

    def _require_open(self) -> Connection:
        if self._conn is None:
            raise RuntimeError("Population mobility is not open or has been closed")
        if threading.get_ident() != self._owner:
            raise RuntimeError("Population mobility must be used by its single owner thread")
        return self._conn

    def save_checkpoint(self, path: Path) -> dict:
        conn = self._require_open()
        if conn.simulation.getTime() != self.t:
            raise ValueError("Adapter and SUMO time must agree at the checkpoint boundary")
        if self._notices:
            raise ValueError("Route notices must reach the society before a checkpoint")
        path = Path(path).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb"):
            pass
        conn.simulation.saveState(str(path))
        self._complete_native_state(path)
        traci_version, sumo_version = conn.getVersion()
        saved = _Checkpoint(
            version="population-mobility-1", native_state_profile="sumo-1.27.1-striping-v1",
            run_id=self.run_id, net_file=str(self.net_file),
            network_sha256=self._network_sha256, state_sha256=_sha256(path),
            seed=self.seed, horizon_s=self.horizon_s, t=self.t, sequence=self._sequence,
            teleports=self.teleports, sumo_version=sumo_version, traci_version=traci_version,
            platform=f"{sys.platform}-{platform.machine()}-{sys.byteorder}",
            runtime_options={option: conn.simulation.getOption(option) for option in CHECKPOINT_OPTIONS},
            output_dirs=list(self._output_dirs),
            active={entity_id: _CheckpointTrip(
                resident_id=trip.resident_id, entity_id=trip.entity_id, destination_id=trip.destination_id,
                travel_class=trip.travel_class, destination=trip.destination.model_copy(), departed=trip.departed,
            ) for entity_id, trip in self._active.items()},
            residents=dict(self._residents), tracks=self.tracks, events=self.events,
            hazards={hid: _CheckpointHazard(edges=sorted(h.edges), classes=sorted(h.classes), until_s=h.until_s)
                     for hid, h in self._hazards.items()},
            blocked={eid: list(ids) for eid, ids in self._blocked.items()}, replan=sorted(self._replan),
            held=sorted(self._held),
        )
        rejoining = self._validate_checkpoint(path, saved)
        self._validate_checkpoint_bodies(saved, rejoining)
        return saved.model_dump(mode="json")

    def restore_checkpoint(self, path: Path, metadata: dict) -> None:
        conn = self._require_open()
        if (
            self._restored or self.t != 0 or self._sequence or self._active or self._residents
            or self.tracks or self.events or self.teleports or self._hazards or conn.simulation.getTime() != 0
            or conn.vehicle.getLoadedIDList() or conn.person.getIDList()
            or conn.simulation.getMinExpectedNumber() != 0
        ):
            raise ValueError("Checkpoint restore requires a pristine, fresh adapter")
        saved = _Checkpoint.model_validate(metadata, strict=True)
        path = Path(path).resolve()
        rejoining = self._validate_checkpoint(path, saved)
        try:
            conn.simulation.loadState(str(path))
            if conn.simulation.getTime() != saved.t:
                raise ValueError("Restored SUMO time does not match checkpoint time")
            self._validate_checkpoint_bodies(saved, rejoining)
            for entity_id, trip in saved.active.items():
                if trip.departed:
                    domain = conn.person if trip.travel_class == "pedestrian" else conn.vehicle
                    domain.subscribe(entity_id, SAMPLE_VARS)
        except BaseException:
            self.close()
            raise
        self.t = saved.t
        self._sequence = saved.sequence
        self.teleports = saved.teleports
        self._active = {entity_id: _Trip(
            trip.resident_id, trip.entity_id, trip.destination_id, trip.travel_class,
            trip.destination.model_copy(), trip.departed,
        ) for entity_id, trip in saved.active.items()}
        self._residents = dict(saved.residents)
        self.tracks = dict(saved.tracks)
        self.events = list(saved.events)
        self._output_dirs = list(dict.fromkeys([*saved.output_dirs, str(self.output_dir)]))
        # SUMO state files do not carry lane permissions: closures are reapplied before the next step.
        self._hazards = {hid: _Hazard(frozenset(h.edges), frozenset(h.classes), h.until_s) for hid, h in saved.hazards.items()}
        self._blocked = {eid: tuple(ids) for eid, ids in saved.blocked.items()}
        self._replan = set(saved.replan)
        self._held = set(saved.held)
        self._apply_closures()
        self._restored = True

    def _complete_native_state(self, path: Path) -> None:
        conn = self._require_open()
        with gzip.open(path, "rb") if path.suffix == ".gz" else path.open("rb") as stream:
            tree = ET.parse(stream, parser=ET.XMLParser(target=ET.TreeBuilder(insert_comments=True)))
        if tree.getroot().get("version") != "1.27.1":
            raise ValueError("Checkpoint native-state completion requires the verified SUMO 1.27.1 format")
        changed = False
        for vehicle in tree.findall("vehicle"):
            trip = self._active.get(vehicle.attrib["id"])
            if trip is None or trip.travel_class == "pedestrian":
                raise ValueError("Native checkpoint contains an unowned vehicle")
            if not trip.departed and "departSpeed" not in vehicle.attrib:
                vehicle.set("departSpeed", "0")
                changed = True
        for person in tree.findall("./transportables[@type='person']/person"):
            entity_id = person.attrib["id"]
            trip = self._active.get(entity_id)
            if trip is None or trip.travel_class != "pedestrian":
                raise ValueError("Native checkpoint contains an unowned person")
            stages = [conn.person.getStage(entity_id, index)
                      for index in range(conn.person.getRemainingStages(entity_id))]
            walks = person.findall("walk")
            if len(walks) != 1 or not stages or stages[-1].type != tc.STAGE_WALKING:
                raise ValueError("Native checkpoint does not contain the adapter's walking plan")
            walking = stages[-1]
            if tuple(walks[0].get("edges", "").split()) != tuple(walking.edges):
                raise ValueError("Native checkpoint walking route disagrees with TraCI")
            for element, attribute, value in (
                (person, "departPos", walking.departPos), (walks[0], "arrivalPos", walking.arrivalPos),
            ):
                if not math.isfinite(value) or value < 0:
                    raise ValueError("Native walking position is invalid at the checkpoint boundary")
                if attribute not in element.attrib:
                    element.set(attribute, repr(value))
                    changed = True
                elif not math.isclose(float(element.attrib[attribute]), value, abs_tol=1e-6):
                    raise ValueError("Native checkpoint walking positions disagree with TraCI")
            if trip.departed:
                fields = person.attrib["state"].split()
                if len(fields) < 6 or fields[1] != "1":
                    raise ValueError("Unknown SUMO walking-state layout")
                lane_index = 6 + max(0, int(fields[5]))
                if len(fields) != lane_index + 16 or fields[lane_index] != conn.person.getLaneID(entity_id):
                    raise ValueError("SUMO walking-state lane disagrees with TraCI")
                for index, value in (
                    (lane_index + 1, conn.person.getLanePosition(entity_id)),
                    (lane_index + 4, conn.person.getSpeed(entity_id)),
                ):
                    if not math.isclose(float(fields[index]), value, rel_tol=1e-5, abs_tol=1e-5):
                        raise ValueError("SUMO walking-state measurement disagrees with TraCI")
                    fields[index] = repr(value)
                person.set("state", " ".join(fields))
                changed = True
        if changed:
            with gzip.open(path, "wb") if path.suffix == ".gz" else path.open("wb") as output:
                tree.write(output, encoding="utf-8", xml_declaration=True)

    def _validate_checkpoint(self, path: Path, saved: _Checkpoint) -> set[str]:
        """Validate a saved state; returns the vehicles SUMO holds off the road while they rejoin it from parking."""
        conn = self._require_open()
        if saved.run_id != self.run_id or saved.seed != self.seed or saved.horizon_s != self.horizon_s:
            raise ValueError("Checkpoint run_id, seed and horizon must match the adapter")
        if saved.network_sha256 != self._network_sha256 or _sha256(self.net_file) != self._network_sha256:
            raise ValueError("Checkpoint network digest does not match the loaded network")
        if saved.t > self.horizon_s:
            raise ValueError("Checkpoint time exceeds the simulation horizon")
        if (saved.traci_version, saved.sumo_version) != conn.getVersion():
            raise ValueError("Checkpoint SUMO/TraCI version does not match this process")
        if saved.platform != f"{sys.platform}-{platform.machine()}-{sys.byteorder}":
            raise ValueError("Checkpoint RNG platform does not match this process")
        options = {option: conn.simulation.getOption(option) for option in CHECKPOINT_OPTIONS}
        if saved.runtime_options != options or any(
            options[option] != "true" for option in ("save-state.rng", "save-state.transportables")
        ):
            raise ValueError("Checkpoint SUMO runtime/RNG options do not match")
        owners = {trip.resident_id: entity_id for entity_id, trip in saved.active.items()}
        if len(owners) != len(saved.active) or saved.residents != owners:
            raise ValueError("Checkpoint active body/resident ownership maps disagree")
        prefix = f"body_{self.run_id}_"
        for entity_id, track in saved.tracks.items():
            suffix = entity_id.removeprefix(prefix)
            if (
                not entity_id.startswith(prefix) or not suffix.isdecimal()
                or not 1 <= int(suffix) <= saved.sequence or entity_id != f"{prefix}{int(suffix):06d}"
            ):
                raise ValueError("Checkpoint body identity and sequence disagree")
            if (
                track.entity_id != entity_id or not track.resident_id or track.vehicle_class not in POPULATION_TYPES
                or track.kind != classify_vehicle(track.vehicle_class)
            ):
                raise ValueError("Checkpoint track class or resident ownership is invalid")
            previous = -1.0
            for row in track.samples:
                if (
                    len(row) != 5 or any(not math.isfinite(value) for value in row)
                    or not previous < row[0] <= saved.t or row[0] < 0 or row[0] != int(row[0])
                ):
                    raise ValueError("Checkpoint trajectory has invalid or future samples")
                previous = row[0]
            if any(index < 0 or index > len(track.samples) for index in track.breaks):
                raise ValueError("Checkpoint trajectory break is outside its samples")
        for entity_id, trip in saved.active.items():
            active_track = saved.tracks.get(entity_id)
            if (
                trip.entity_id != entity_id or active_track is None or active_track.resident_id != trip.resident_id
                or active_track.vehicle_class != trip.travel_class or (not trip.departed and active_track.samples)
            ):
                raise ValueError("Checkpoint active body class or resident ownership disagrees with its track")
            access = trip.destination
            if not self.net.hasEdge(access.edge_id):
                raise ValueError("Checkpoint destination edge does not exist in the network")
            edge = self.net.getEdge(access.edge_id)
            lanes = edge.getLanes()
            if edge.isSpecial() or access.lane_index >= len(lanes):
                raise ValueError("Checkpoint destination lane does not exist in the network")
            lane = lanes[access.lane_index]
            if not lane.allows(trip.travel_class) or access.position_m > lane.getLength():
                raise ValueError("Checkpoint destination permission or position is invalid")
        for hazard in saved.hazards.values():
            if any(not self.net.hasEdge(eid) or self.net.getEdge(eid).isSpecial() for eid in hazard.edges):
                raise ValueError("Checkpoint hazard closes an unknown street")
            if set(hazard.classes) - set(POPULATION_TYPES):
                raise ValueError("Checkpoint hazard closes an unknown travel class")
        if (set(saved.blocked) | set(saved.replan)) - set(saved.active) or set(saved.held) - set(saved.blocked) or any(
            set(ids) - set(saved.hazards) for ids in saved.blocked.values()
        ):
            raise ValueError("Checkpoint route closures reference unknown bodies or hazards")
        residents = {track.resident_id for track in saved.tracks.values()}
        previous_t = -1
        for event in saved.events:
            if (
                event.person_id not in residents or not previous_t <= event.t <= saved.t or event.t < 0
                or event.event not in {"depart", "arrive", "unroutable"}
            ):
                raise ValueError("Checkpoint event history has invalid ownership or time")
            if event.vehicle_id is not None:
                event_track = saved.tracks.get(event.vehicle_id)
                if event_track is None or event_track.resident_id != event.person_id or event_track.kind == "person":
                    raise ValueError("Checkpoint vehicle event ownership is invalid")
            previous_t = event.t
        if _sha256(path) != saved.state_sha256:
            raise ValueError("Checkpoint SUMO state digest does not match metadata")
        try:
            with gzip.open(path, "rb") if path.suffix == ".gz" else path.open("rb") as stream:
                root = ET.parse(stream).getroot()
        except (ET.ParseError, OSError) as error:
            raise ValueError("Checkpoint is not a readable SUMO state file") from error
        if root.tag != "snapshot" or root.get("type") != "micro":
            raise ValueError("Checkpoint is not a microscopic SUMO state")
        try:
            state_t = float(root.attrib["time"])
        except (KeyError, ValueError) as error:
            raise ValueError("Checkpoint SUMO state has no valid time") from error
        if state_t != saved.t:
            raise ValueError("Checkpoint SUMO state time does not match metadata")
        if saved.sumo_version != f"SUMO {root.get('version')}":
            raise ValueError("Checkpoint SUMO state version does not match metadata")
        if root.find("rngState") is None or not root.findall("rngState/rngLane"):
            raise ValueError("Checkpoint lacks native SUMO RNG state")
        native = root.findall("vehicle") + root.findall("./transportables[@type='person']/person")
        native_ids = [node.get("id") for node in native]
        if len(set(native_ids)) != len(native_ids) or set(native_ids) != set(saved.active):
            raise ValueError("Checkpoint SUMO bodies disagree with adapter ownership")
        vclasses = {node.get("id"): node.get("vClass", "passenger") for node in root.findall("vType")}
        routes = {node.get("id"): node.get("edges", "").split() for node in root.findall("route")}
        for node in native:
            trip = saved.active[node.attrib["id"]]
            if (
                (node.tag == "person") != (trip.travel_class == "pedestrian")
                or vclasses.get(node.get("type")) != trip.travel_class
            ):
                raise ValueError("Checkpoint native SUMO person/vehicle class disagrees with its owner")
            if node.tag == "person":
                walks = node.findall("walk")
                if not walks:
                    raise ValueError("Checkpoint person has no saved walking stage")
                last = walks[-1]
                edges = last.get("edges", "").split()
            else:
                last = node
                edges = routes.get(node.get("route"), [])
            try:
                arrival_pos = float(last.attrib["arrivalPos"])
            except (KeyError, ValueError) as error:
                raise ValueError("Checkpoint SUMO body has no declared arrival position") from error
            if not edges or edges[-1] != trip.destination.edge_id or not math.isclose(
                arrival_pos, trip.destination.position_m, abs_tol=1e-6,
            ):
                raise ValueError("Checkpoint SUMO route does not end at the declared destination")
            if node.tag == "vehicle" and node.get("arrivalLane") != str(trip.destination.lane_index):
                raise ValueError("Checkpoint SUMO arrival lane does not match its declared destination")
        # A vehicle whose parked hold has ended waits off the road for a gap; SUMO saves and restores that queue.
        return {node.attrib["id"] for node in root.findall("vehicleTransfer")
                if node.get("parking") and node.get("id") in saved.active and saved.active[node.attrib["id"]].departed
                and saved.active[node.attrib["id"]].travel_class != "pedestrian"}

    def _validate_checkpoint_bodies(self, saved: _Checkpoint, rejoining: set[str]) -> None:
        conn = self._require_open()
        vehicles = {entity_id for entity_id, trip in saved.active.items() if trip.travel_class != "pedestrian"}
        persons = set(saved.active) - vehicles
        if set(conn.vehicle.getLoadedIDList()) != vehicles or not set(conn.person.getIDList()) <= persons:
            raise ValueError("SUMO bodies disagree with checkpoint resident ownership")
        on_road = set(conn.vehicle.getIDList())
        for entity_id, trip in saved.active.items():
            try:
                if trip.travel_class == "pedestrian":
                    vclass = conn.vehicletype.getVehicleClass(conn.person.getTypeID(entity_id))
                    remaining = conn.person.getRemainingStages(entity_id)
                    if remaining < 1:
                        raise ValueError("Checkpoint person lost its walking stages")
                    current = conn.person.getStage(entity_id)
                    final = conn.person.getStage(entity_id, remaining - 1)
                    if (
                        (current.type == tc.STAGE_WALKING) != trip.departed
                        or final.type != tc.STAGE_WALKING or not final.edges
                        or final.edges[-1] != trip.destination.edge_id
                        or not math.isclose(final.arrivalPos, trip.destination.position_m, abs_tol=1e-6)
                    ):
                        raise ValueError("SUMO walking stages or departure disagree with checkpoint")
                else:
                    vclass = conn.vehicle.getVehicleClass(entity_id)
                    route = conn.vehicle.getRoute(entity_id)
                    present = entity_id in on_road or (entity_id in rejoining and not conn.vehicle.getRoadID(entity_id))
                    if present != trip.departed or not route or route[-1] != trip.destination.edge_id:
                        raise ValueError("SUMO vehicle route or departure disagrees with checkpoint")
            except traci.TraCIException as error:
                raise ValueError("SUMO body is missing from the checkpoint state") from error
            if vclass != trip.travel_class:
                raise ValueError("SUMO body class disagrees with checkpoint resident ownership")

    def _access(self, anchor: ActivityAnchor, travel_class: TravelClass, endpoint: str) -> AnchorAccess:
        conn = self._require_open()
        access = anchor.access.get(travel_class)
        if access is None:
            raise ValueError(f"{endpoint} anchor {anchor.anchor_id} has no {travel_class} access")
        if not self.net.hasEdge(access.edge_id):
            raise ValueError(f"{endpoint} access edge {access.edge_id} does not exist")
        edge = self.net.getEdge(access.edge_id)
        if edge.isSpecial():
            raise ValueError(f"{endpoint} access edge must be a normal network edge")
        lanes = edge.getLanes()
        if not 0 <= access.lane_index < len(lanes):
            raise ValueError(f"{endpoint} access lane {access.lane_index} does not exist")
        lane = lanes[access.lane_index]
        allowed = conn.lane.getAllowed(lane.getID())
        disallowed = conn.lane.getDisallowed(lane.getID())
        if (
            not lane.allows(travel_class)
            or (allowed and travel_class not in allowed)
            or travel_class in disallowed
        ):
            raise ValueError(f"{endpoint} lane permission does not allow {travel_class}")
        if not math.isfinite(access.position_m) or not 0 <= access.position_m <= lane.getLength():
            raise ValueError(f"{endpoint} position is outside access lane {lane.getID()}")
        if travel_class == "pedestrian" and access.lane_index != next(
            index for index, candidate in enumerate(lanes) if candidate.allows("pedestrian")
        ):
            raise ValueError(f"{endpoint} lane is not the SUMO pedestrian access lane")
        return access.model_copy()

    def _route(self, origin: ActivityAnchor, destination: ActivityAnchor, travel_class: TravelClass) -> _Route:
        conn = self._require_open()
        if travel_class not in POPULATION_TYPES:
            raise ValueError(f"Unsupported travel class {travel_class}")
        for endpoint, anchor in (("origin", origin), ("destination", destination)):
            access = anchor.access.get(travel_class)
            # A walker may always leave a closed footprint; nothing may enter one.
            if access is not None and (endpoint == "destination" or travel_class != "pedestrian"):
                self._require_open_street(access.edge_id, travel_class, endpoint)
        source = self._access(origin, travel_class, "origin")
        target = self._access(destination, travel_class, "destination")
        walk_speed = PEDESTRIAN_SPEED_MPS
        try:
            if travel_class == "pedestrian":
                stages = conn.simulation.findIntermodalRoute(
                    source.edge_id, target.edge_id, modes="", pType=POPULATION_TYPES[travel_class],
                    depart=self.t, departPos=source.position_m, arrivalPos=target.position_m,
                    speed=walk_speed, walkFactor=1.0,
                )
                if len(stages) != 1 or stages[0].type != tc.STAGE_WALKING:
                    raise ValueError("No pedestrian route between the declared access positions")
                stage = stages[0]
            else:
                stage = conn.simulation.findRoute(
                    source.edge_id, target.edge_id, vType=POPULATION_TYPES[travel_class],
                    depart=self.t, departPos=source.position_m, arrivalPos=target.position_m,
                )
        except traci.TraCIException as error:
            raise ValueError(f"No {travel_class} route: {error}") from error
        edges = tuple(stage.edges)
        closed = self._closed_to(travel_class)
        # A closed street stays open to SUMO while a resident vehicle is still on it; no new trip may use it.
        if (not edges and closed) or (travel_class != "pedestrian" and closed & set(edges[1:])):
            raise ValueError(f"No {travel_class} route around the streets closed by a hazard")
        if not edges or edges[0] != source.edge_id or edges[-1] != target.edge_id:
            raise ValueError(f"No {travel_class} route between the declared access positions")
        if travel_class == "pedestrian" and self._blocked_walk & set(edges[1:]):
            detour = self._walk_path(source.edge_id, source.position_m, target.edge_id, target.position_m)
            if detour is None:
                raise ValueError("No pedestrian route around the closed hazard footprint")
            return _Route(source, target, *detour)
        if any(not self.net.hasEdge(eid) or not self.net.getEdge(eid).allows(travel_class) for eid in edges):
            raise ValueError(f"Route edge permission does not allow {travel_class}")
        duration, distance = float(stage.travelTime), float(stage.length)
        if travel_class == "pedestrian":
            if len(edges) == 1:
                distance = abs(target.position_m - source.position_m)
                duration = distance / walk_speed
            else:
                distance = duration * walk_speed
        if not all(math.isfinite(value) and value >= 0 for value in (duration, distance)):
            raise ValueError(f"SUMO returned an invalid {travel_class} route estimate")
        return _Route(source, target, edges, duration, distance)

    def estimate_trip(self, origin: ActivityAnchor, destination: ActivityAnchor, travel_class: TravelClass) -> dict:
        self._require_open()
        result: dict = {
            "target_id": destination.anchor_id, "travel_class": travel_class, "reachable": False,
            "duration_s": None, "distance_m": None, "reason": "",
        }
        try:
            route = self._route(origin, destination, travel_class)
        except ValueError as error:
            result["reason"] = str(error)
        else:
            result.update(reachable=True, duration_s=route.duration_s, distance_m=route.distance_m)
        return result

    def start_trip(
        self, resident_id: str, origin: ActivityAnchor, destination: ActivityAnchor, travel_class: TravelClass,
    ) -> str:
        self._require_open()
        if self.t >= self.horizon_s:
            raise ValueError("Cannot start a trip at or beyond the simulation horizon")
        if not resident_id:
            raise ValueError("A resident ID is required")
        if resident_id in self._residents:
            raise ValueError(f"Resident {resident_id} already has an active mobility body")
        route = self._route(origin, destination, travel_class)
        trip = _Trip(resident_id, self._next_entity_id(), destination.anchor_id, travel_class, route.destination)
        self._add_body(trip, route.edges, route.origin.position_m, route.origin.lane_index)
        self._own(trip)
        return trip.entity_id

    def set_hazards(self, hazards: Iterable[HazardFootprint]) -> None:
        """Close the streets of every active footprint and move trips whose remaining route crosses a closure.

        Call it before every step: bodies that were crossing a junction when a closure began are decided here once
        they reach a street. Changed trips are reported through `take_notices`.
        """
        self._require_open()
        active = {hazard.hazard_id: hazard for hazard in hazards if hazard.until_s > self.t}
        if set(active) == set(self._hazards) and all(h.until_s > self.t for h in self._hazards.values()):
            if self._street_closures:
                self._close_lanes()
            for entity_id in sorted(self._blocked):
                blocked = self._active.get(entity_id)
                if blocked is not None and blocked.travel_class == "pedestrian" and entity_id not in self._replan:
                    self._recheck_walker(blocked)
            for entity_id in sorted(self._replan):
                waiting = self._active.get(entity_id)
                if waiting is None:
                    self._replan.discard(entity_id)
                else:
                    self._avoid_closures(waiting)
            return
        closures = {}
        for hazard_id, hazard in sorted(active.items()):
            known = self._hazards.get(hazard_id)
            if known is None:
                x, y = self.net.convertLonLat2XY(hazard.lon, hazard.lat)
                known = _Hazard(frozenset(edges_within(self.net, x, y, hazard.radius_m)), frozenset(hazard.classes), hazard.until_s)
            closures[hazard_id] = known
        self._hazards = closures
        self._apply_closures()
        for trip in sorted(self._active.values(), key=lambda item: item.entity_id):
            self._avoid_closures(trip)

    def take_notices(self) -> list[RouteNotice]:
        notices, self._notices = self._notices, []
        return notices

    def trip_status(self, resident_id: str) -> dict | None:
        """What a travelling resident can tell about its own trip: destination, last measured position, closures."""
        entity_id = self._residents.get(resident_id)
        if entity_id is None:
            return None
        trip = self._active[entity_id]
        samples = self.tracks[entity_id].samples
        position = [samples[-1][1], samples[-1][2]] if samples and all(map(math.isfinite, samples[-1][1:3])) else None
        return {"destination_id": trip.destination_id, "travel_class": trip.travel_class, "position": position,
                "route": "blocked" if entity_id in self._blocked else "clear",
                "blocked_by": list(self._blocked.get(entity_id, ()))}

    def trip_ready(self, resident_id: str) -> bool:
        """Whether a travelling resident's body is on a street now, so a new destination can start from it."""
        entity_id = self._residents.get(resident_id)
        if entity_id is None or not self._active[entity_id].departed:
            return False
        conn = self._require_open()
        domain = conn.person if self._active[entity_id].travel_class == "pedestrian" else conn.vehicle
        road = domain.getRoadID(entity_id)
        return bool(road) and not road.startswith(":")

    def estimate_redirect(self, resident_id: str, destination: ActivityAnchor) -> dict:
        """Estimate a new destination for a travelling resident, from where its body is now and in the same class."""
        result: dict = {"target_id": destination.anchor_id, "reachable": False, "duration_s": None,
                        "distance_m": None, "reason": ""}
        try:
            _, edges, duration, distance, _, _ = self._redirect_route(resident_id, destination)
        except ValueError as error:
            result["reason"] = str(error)
        else:
            result.update(reachable=bool(edges), duration_s=duration, distance_m=distance)
        return result

    def redirect_trip(self, resident_id: str, destination: ActivityAnchor) -> str:
        """Send a travelling resident to a new destination from where it is: a new body continues from that spot."""
        trip, edges, _, _, position, lane_index = self._redirect_route(resident_id, destination)
        replacement = _Trip(trip.resident_id, self._next_entity_id(), destination.anchor_id, trip.travel_class,
                            self._access(destination, trip.travel_class, "destination"))
        self._add_body(replacement, edges, position, lane_index)
        self._retire(trip)
        self._own(replacement)
        return replacement.entity_id

    def _redirect_route(self, resident_id: str, destination: ActivityAnchor):
        conn = self._require_open()
        entity_id = self._residents.get(resident_id)
        if entity_id is None:
            raise ValueError("Resident has no travelling body")
        trip = self._active[entity_id]
        kind = trip.travel_class
        if destination.anchor_id == trip.destination_id:
            raise ValueError("Already travelling to that destination")
        if not trip.departed:
            raise ValueError("The body has not left yet; redirect after it departs")
        domain = conn.person if kind == "pedestrian" else conn.vehicle
        road = domain.getRoadID(entity_id)
        if not road or road.startswith(":"):
            raise ValueError("The body is crossing a junction; redirect once it reaches a street")
        if kind != "pedestrian" and road in self._closed_to(kind):
            # A new vehicle body cannot be inserted on a closed lane; this one is already rerouting out.
            raise ValueError("The vehicle is on a closed street; it can only drive out of the footprint first")
        target_access = destination.access.get(kind)
        if target_access is None:
            raise ValueError(f"destination anchor {destination.anchor_id} has no {kind} access")
        self._require_open_street(target_access.edge_id, kind, "destination")
        target = self._access(destination, kind, "destination")
        position = domain.getLanePosition(entity_id)
        lane_index = 0 if kind == "pedestrian" else conn.vehicle.getLaneIndex(entity_id)
        if lane_index < 0:  # a parked vehicle is beside the road, not on a lane: it rejoins the first lane it may use
            lane_index = next(lane.getIndex() for lane in self.net.getEdge(road).getLanes() if lane.allows(kind))
        found = (self._walk_route(road, position, target) if kind == "pedestrian"
                 else self._drive_route(road, position, kind, target))
        if found is None:
            raise ValueError(f"No {kind} route from here to that destination that avoids closed streets")
        edges, duration, distance = found
        return trip, edges, duration, distance, position, lane_index

    def _next_entity_id(self) -> str:
        self._sequence += 1
        return f"body_{self.run_id}_{self._sequence:06d}"

    def _add_body(self, trip: _Trip, edges: tuple[str, ...], position: float, lane_index: int) -> None:
        conn = self._require_open()
        try:
            if trip.travel_class == "pedestrian":
                conn.person.add(trip.entity_id, edges[0], position, depart=self.t, typeID=POPULATION_TYPES["pedestrian"])
                conn.person.appendWalkingStage(trip.entity_id, edges, arrivalPos=trip.destination.position_m)
            else:
                route_id = f"route_{trip.entity_id}"
                conn.route.add(route_id, edges)
                conn.vehicle.add(
                    trip.entity_id, route_id, typeID=POPULATION_TYPES[trip.travel_class], depart=str(self.t),
                    departLane=str(lane_index), departPos=str(position), departSpeed="0",
                    arrivalLane=str(trip.destination.lane_index), arrivalPos=str(trip.destination.position_m),
                    arrivalSpeed="0",
                )
        except traci.TraCIException as error:
            self._remove_body(trip)
            raise ValueError(f"SUMO rejected {trip.travel_class} trip: {error}") from error

    def _own(self, trip: _Trip) -> None:
        self._active[trip.entity_id] = trip
        self._residents[trip.resident_id] = trip.entity_id
        self.tracks[trip.entity_id] = EntityTrack(
            entity_id=trip.entity_id, kind=classify_vehicle(trip.travel_class), samples=[],
            resident_id=trip.resident_id, vehicle_class=trip.travel_class,
        )

    def _retire(self, trip: _Trip) -> None:
        """Remove a body whose trip continues in a replacement; its measured track simply ends here."""
        if trip.departed:
            conn = self._require_open()
            (conn.person if trip.travel_class == "pedestrian" else conn.vehicle).unsubscribe(trip.entity_id)
        self._remove_body(trip)
        del self._active[trip.entity_id]
        self._residents.pop(trip.resident_id, None)
        self._blocked.pop(trip.entity_id, None)
        self._replan.discard(trip.entity_id)
        self._held.discard(trip.entity_id)

    def _closed_to(self, travel_class: str) -> set[str]:
        if travel_class == "pedestrian":
            return set(self._blocked_walk)
        return {eid for eid, classes in self._street_closures.items() if travel_class in classes}

    def _require_open_street(self, edge_id: str, travel_class: str, endpoint: str) -> None:
        if edge_id in self._closed_to(travel_class):
            raise ValueError(f"The {endpoint} street is closed to {travel_class} by a hazard")

    def _hazards_on(self, edges: Iterable[str], travel_class: str) -> tuple[str, ...]:
        edges = set(edges)
        return tuple(sorted(hid for hid, hazard in self._hazards.items()
                            if travel_class in hazard.classes and hazard.edges & edges))

    def _apply_closures(self) -> None:
        """Derive the closed streets from the active hazards and apply them to SUMO's lanes."""
        closed: dict[str, set[str]] = {}
        walk: set[str] = set()
        for hazard in self._hazards.values():
            for edge_id in hazard.edges:
                if "pedestrian" in hazard.classes:
                    walk.add(edge_id)
                if hazard.classes - {"pedestrian"}:
                    closed.setdefault(edge_id, set()).update(hazard.classes - {"pedestrian"})
        self._street_closures = {edge_id: frozenset(classes) for edge_id, classes in closed.items()}
        if frozenset(walk) != self._blocked_walk:
            self._walk_trees.clear()
        self._blocked_walk = frozenset(walk)
        self._close_lanes()

    def _close_lanes(self) -> None:
        """Close lanes to vehicles, except under resident vehicles still on them: a street closes once they leave.

        SUMO neither lets a vehicle stop on a lane closed to it nor lets it leave by another closed lane, so a vehicle
        caught on a street when it closes keeps that street until it drives out (or waits there, held).
        """
        conn = self._require_open()
        occupied: set[str] = set()
        for trip in self._active.values():
            if trip.travel_class == "pedestrian" or not trip.departed:
                continue
            road = conn.vehicle.getRoadID(trip.entity_id)
            if road.startswith(":"):  # on a junction: already committed to its next street
                route, index = conn.vehicle.getRoute(trip.entity_id), conn.vehicle.getRouteIndex(trip.entity_id)
                road = route[index + 1] if 0 <= index < len(route) - 1 else ""
            occupied.add(road)
        wanted = {edge_id: classes for edge_id, classes in self._street_closures.items() if edge_id not in occupied}
        exempt = set(self._street_closures) & occupied
        # SUMO's vehicle router honours these travel times, so routes go around a street kept open for its occupant.
        for edge_id in sorted(exempt - self._exempt):
            conn.edge.adaptTraveltime(edge_id, EXEMPT_TRAVEL_TIME_S)
        for edge_id in sorted(self._exempt - exempt):
            conn.edge.adaptTraveltime(edge_id, -1)
        self._exempt = exempt
        for edge_id in sorted(set(wanted) | set(self._lane_closures)):
            if wanted.get(edge_id) == self._lane_closures.get(edge_id):
                continue
            for lane in self.net.getEdge(edge_id).getLanes():
                lane_id = lane.getID()
                original = self._lane_disallowed.setdefault(lane_id, tuple(conn.lane.getDisallowed(lane_id)))
                conn.lane.setDisallowed(lane_id, sorted(set(original) | wanted.get(edge_id, frozenset())))
        self._lane_closures = wanted

    def _avoid_closures(self, trip: _Trip) -> None:
        """Keep a trip off closed streets: vehicles take a new route, walkers continue in a body on a detour.

        A body on a junction (or not yet on the road) is decided at the next `set_hazards` call. A vehicle with no
        open way on pulls over before the closure until it ends; SUMO cannot hold a walker, so a blocked walker is
        only reported.
        """
        conn = self._require_open()
        self._replan.discard(trip.entity_id)
        kind = trip.travel_class
        try:
            if kind == "pedestrian":
                edges = conn.person.getEdges(trip.entity_id, conn.person.getRemainingStages(trip.entity_id) - 1)
                road = conn.person.getRoadID(trip.entity_id) if trip.departed else ""
                on_street = trip.departed and road in edges
                ahead = edges[edges.index(road) + 1:] if on_street else edges[1:]
                if road in self._blocked_walk:  # leaving a closed area is allowed; only entering one is blocked
                    ahead = list(dropwhile(self._blocked_walk.__contains__, ahead))
            else:
                edges = conn.vehicle.getRoute(trip.entity_id)
                index = max(0, conn.vehicle.getRouteIndex(trip.entity_id))
                road = conn.vehicle.getRoadID(trip.entity_id) if trip.departed else edges[0]
                on_street = not road.startswith(":") and road == edges[index]
                ahead = edges[index + 1:]
        except traci.TraCIException:
            return
        blocking = self._hazards_on(ahead, kind)
        if not blocking:
            self._clear(trip)
            return
        if not on_street:
            self._replan.add(trip.entity_id)
            return
        domain = conn.person if kind == "pedestrian" else conn.vehicle
        position = domain.getLanePosition(trip.entity_id) if trip.departed else 0.0
        if kind == "pedestrian":
            path = self._walk_path(road, position, trip.destination.edge_id, trip.destination.position_m)
            try:
                if path is None:
                    raise ValueError("no detour")
                # SUMO keeps a replanned walk's history in its state files, so the detour is walked by a new body.
                replacement = _Trip(trip.resident_id, self._next_entity_id(), trip.destination_id, kind, trip.destination)
                self._add_body(replacement, path[0], position, 0)
            except ValueError:
                self._report_blocked(trip, blocking)
                return
            self._retire(trip)
            self._own(replacement)
            self._report_diverted(replacement, trip.entity_id, blocking)
            return
        route = self._drive_route(road, position, kind, trip.destination)
        if route is not None:
            self._release(trip)
            try:
                conn.vehicle.setRoute(trip.entity_id, route[0])
            except traci.TraCIException:
                pass
            else:
                self._report_diverted(trip, None, blocking)
                return
        if self._blocked.get(trip.entity_id) != blocking:
            self._release(trip)
        if trip.entity_id not in self._held and not self._hold(trip, edges, index, blocking):
            self._replan.add(trip.entity_id)  # e.g. too close to brake this second; try again next step
        self._report_blocked(trip, blocking)

    def _hold(self, trip: _Trip, route: tuple[str, ...], index: int, blocking: tuple[str, ...]) -> bool:
        """Pull a vehicle over at the end of its last open street until the closures in its way end.

        A parked stop keeps the lane free for others and is exempt from SUMO's teleport of stuck vehicles.
        """
        conn = self._require_open()
        closed = self._closed_to(trip.travel_class)
        first_closed = next((i for i in range(index + 1, len(route)) if route[i] in closed), index + 1)
        edge = self.net.getEdge(route[first_closed - 1])
        lane = next((lane for lane in edge.getLanes() if lane.allows(trip.travel_class)), None)
        if lane is None:
            return False
        try:
            conn.vehicle.setStop(trip.entity_id, edge.getID(), pos=lane.getLength(), laneIndex=lane.getIndex(),
                                 duration=0, until=max(self._hazards[h].until_s for h in blocking),
                                 flags=tc.STOP_PARKING)
        except traci.TraCIException:
            return False
        self._held.add(trip.entity_id)
        return True

    def _clear(self, trip: _Trip) -> None:
        """Nothing closed lies ahead any more: end a blockage (and any hold) and say so."""
        if trip.entity_id in self._blocked:
            self._release(trip)
            self._notices.append(RouteNotice(trip.resident_id, trip.entity_id, None, "cleared", ()))

    def _recheck_walker(self, trip: _Trip) -> None:
        """A blocked walker keeps walking; once no closed sidewalk lies ahead (it walked in, or out), it is clear."""
        conn = self._require_open()
        try:
            edges = conn.person.getEdges(trip.entity_id, conn.person.getRemainingStages(trip.entity_id) - 1)
            road = conn.person.getRoadID(trip.entity_id)
        except traci.TraCIException:
            return
        if road not in edges:
            return
        ahead = edges[edges.index(road) + 1:]
        if road in self._blocked_walk:
            ahead = list(dropwhile(self._blocked_walk.__contains__, ahead))
        if not self._hazards_on(ahead, "pedestrian"):
            self._clear(trip)

    def _release(self, trip: _Trip) -> None:
        self._blocked.pop(trip.entity_id, None)
        if trip.entity_id not in self._held:
            return
        self._held.discard(trip.entity_id)
        conn = self._require_open()
        try:
            if conn.vehicle.isStopped(trip.entity_id):
                conn.vehicle.resume(trip.entity_id)
            elif conn.vehicle.getStops(trip.entity_id, 1):
                conn.vehicle.replaceStop(trip.entity_id, 0, "")
        except traci.TraCIException:
            pass

    def _report_blocked(self, trip: _Trip, hazard_ids: tuple[str, ...]) -> None:
        if self._blocked.get(trip.entity_id) != hazard_ids:
            self._blocked[trip.entity_id] = hazard_ids
            self._notices.append(RouteNotice(trip.resident_id, trip.entity_id, None, "blocked", hazard_ids))

    def _report_diverted(self, trip: _Trip, previous: str | None, hazard_ids: tuple[str, ...]) -> None:
        self._notices.append(RouteNotice(trip.resident_id, trip.entity_id, previous, "diverted", hazard_ids))

    def _walk_route(self, road: str, position: float, target: AnchorAccess) -> tuple[tuple[str, ...], float, float] | None:
        """SUMO's own walking route when it avoids every closed sidewalk, otherwise a detour around them."""
        conn = self._require_open()
        try:
            stages = conn.simulation.findIntermodalRoute(
                road, target.edge_id, modes="", pType=POPULATION_TYPES["pedestrian"], depart=self.t, departPos=position,
                arrivalPos=target.position_m, speed=PEDESTRIAN_SPEED_MPS, walkFactor=1.0,
            )
        except traci.TraCIException:
            stages = ()
        if len(stages) == 1 and stages[0].type == tc.STAGE_WALKING:
            edges = tuple(stages[0].edges)
            if edges and edges[0] == road and edges[-1] == target.edge_id and not self._blocked_walk & set(edges[1:]):
                duration = float(stages[0].travelTime)
                return edges, duration, duration * PEDESTRIAN_SPEED_MPS
        return self._walk_path(road, position, target.edge_id, target.position_m)

    def _drive_route(self, road: str, position: float, kind: TravelClass, target: AnchorAccess) -> tuple[tuple[str, ...], float, float] | None:
        """Fastest open route from a vehicle's street; a vehicle on a closed street may only drive out of it."""
        conn = self._require_open()
        closed = self._closed_to(kind)
        starts = [(road, (), position)] if road not in closed else [
            (edge.getID(), (road,), 0.0) for edge in sorted(self.net.getEdge(road).getOutgoing(), key=lambda e: e.getID())
            if edge.getID() not in closed and edge.allows(kind)
        ]
        best = None
        for start, prefix, depart_pos in starts:
            try:
                stage = conn.simulation.findRoute(start, target.edge_id, vType=POPULATION_TYPES[kind], depart=self.t,
                                                  departPos=depart_pos, arrivalPos=target.position_m)
            except traci.TraCIException:
                continue
            edges = (*prefix, *stage.edges)
            usable = bool(stage.edges) and stage.edges[-1] == target.edge_id and not closed & set(edges[1:])
            if usable and (best is None or stage.travelTime < best[1]):
                best = (edges, float(stage.travelTime), float(stage.length))
        return best

    def _walk_path(self, source: str, source_pos: float, target: str, target_pos: float) -> tuple[tuple[str, ...], float, float] | None:
        """Shortest sidewalk path that never enters a closed footprint, though it may leave the one it starts in.

        SUMO builds its pedestrian router once, so it cannot see closures made later. This search follows SUMO's own
        walking rules instead: sidewalks meet only through a junction's walking areas and crossings, and a walk leaves
        its first street at the far end when the next street touches it.
        """
        if target in self._blocked_walk:
            return None
        if source == target:
            distance = abs(target_pos - source_pos)
            return (source,), distance / PEDESTRIAN_SPEED_MPS, distance
        links, exits, settled = self._walk_tree(source, source_pos)
        goal = self.net.getEdge(target)
        best: tuple[float, tuple[str, ...]] | None = None
        for node, finish in ((goal.getFromNode().getID(), target_pos), (goal.getToNode().getID(), goal.getLength() - target_pos)):
            root = links.ends.get((node, target))
            for exit_root, cost, backward in exits:
                if root == exit_root and not (backward and self._touches(target, source)):
                    candidate = (cost + finish, (source, target))
                    best = candidate if best is None or candidate < best else best
            for escaped in (False, True):
                reached = settled.get((root, escaped))
                if reached is None or reached[2] == target:
                    continue
                edges = [target]
                state = (root, escaped)
                while state is not None:
                    edges.append(settled[state][2])
                    state = settled[state][1]
                candidate = (reached[0] + finish, (source, *reversed(edges)))
                best = candidate if best is None or candidate < best else best
        if best is None:
            return None
        return best[1], best[0] / PEDESTRIAN_SPEED_MPS, best[0]

    def _touches(self, edge_id: str, source: str) -> bool:
        """Whether a street meets the far end of `source`, where SUMO sends a walk that continues onto it."""
        edge, ahead = self.net.getEdge(edge_id), self.net.getEdge(source).getToNode().getID()
        return ahead in (edge.getFromNode().getID(), edge.getToNode().getID())

    def _walk_tree(self, source: str, source_pos: float):
        """Shortest walks from one point to every junction it can reach, cached until the closures change."""
        key = (source, source_pos)
        if key in self._walk_trees:
            return self._walk_trees[key]
        links = self._walk_links or _WalkLinks(self.net)
        self._walk_links = links
        blocked = self._blocked_walk
        start = self.net.getEdge(source)
        exits = []
        frontier: list[tuple[float, tuple, tuple | None, str]] = []
        escaped = source not in blocked
        for node, cost, backward in ((start.getToNode().getID(), start.getLength() - source_pos, False),
                                     (start.getFromNode().getID(), source_pos, True)):
            root = links.ends.get((node, source))
            if root is None:
                continue
            exits.append((root, cost, backward))
            for edge_id, other in links.members[root]:
                if edge_id == source or (backward and self._touches(edge_id, source)) or (other, edge_id) not in links.ends:
                    continue
                if edge_id not in blocked or not escaped:  # a closed street may only be used to leave
                    state = (links.ends[(other, edge_id)], escaped or edge_id not in blocked)
                    heapq.heappush(frontier, (cost + self.net.getEdge(edge_id).getLength(), state, None, edge_id))
        settled: dict[tuple, tuple[float, tuple | None, str]] = {}
        while frontier:
            cost, state, previous, via = heapq.heappop(frontier)
            if state in settled:
                continue
            settled[state] = (cost, previous, via)
            root, out = state
            for edge_id, other in links.members.get(root, ()):
                if (edge_id in blocked and out) or (other, edge_id) not in links.ends:
                    continue
                following = (links.ends[(other, edge_id)], out or edge_id not in blocked)
                if following not in settled:
                    heapq.heappush(frontier, (cost + self.net.getEdge(edge_id).getLength(), following, state, edge_id))
        if len(self._walk_trees) >= 16:
            self._walk_trees.clear()
        self._walk_trees[key] = (links, exits, settled)
        return self._walk_trees[key]

    def _depart(self, trip: _Trip) -> None:
        if not trip.departed:
            trip.departed = True
            self.events.append(PersonEvent(
                t=self.t, person_id=trip.resident_id, event="depart",
                vehicle_id=None if trip.travel_class == "pedestrian" else trip.entity_id,
            ))

    def _remove_body(self, trip: _Trip) -> None:
        conn = self._require_open()
        if trip.travel_class == "pedestrian":
            try:
                conn.person.getRemainingStages(trip.entity_id)
            except traci.TraCIException:
                return
            conn.person.remove(trip.entity_id)
        elif trip.entity_id in conn.vehicle.getLoadedIDList():
            conn.vehicle.remove(trip.entity_id)

    def _finish(self, trip: _Trip, status: Literal["arrived", "failed"], reason: str = "") -> MobilityOutcome:
        if status == "failed":
            self._remove_body(trip)
        self._active.pop(trip.entity_id)
        self._residents.pop(trip.resident_id)
        self._blocked.pop(trip.entity_id, None)
        self._replan.discard(trip.entity_id)
        self._held.discard(trip.entity_id)
        self.events.append(PersonEvent(
            t=self.t, person_id=trip.resident_id, event="arrive" if status == "arrived" else "unroutable",
            vehicle_id=None if trip.travel_class == "pedestrian" else trip.entity_id,
        ))
        return MobilityOutcome(trip.resident_id, trip.entity_id, trip.destination_id, self.t, status, reason)

    def step(self) -> list[MobilityOutcome]:
        conn = self._require_open()
        if self.t >= self.horizon_s:
            return []
        missing_before_step: set[str] = set()
        if self._active:
            loaded_before = set(conn.vehicle.getLoadedIDList())
            persons_before = set(conn.person.getIDList())
            for entity_id, trip in self._active.items():
                if trip.travel_class == "pedestrian":
                    if trip.departed and entity_id not in persons_before:
                        missing_before_step.add(entity_id)
                        continue
                    try:
                        index = 0 if trip.departed else conn.person.getRemainingStages(entity_id) - 1
                        stage = conn.person.getStage(entity_id, index)
                        if (
                            index < 0 or stage.type != tc.STAGE_WALKING or not stage.edges
                            or stage.edges[-1] != trip.destination.edge_id
                            or not math.isclose(stage.arrivalPos, trip.destination.position_m, abs_tol=1e-6)
                        ):
                            missing_before_step.add(entity_id)
                    except traci.TraCIException:
                        missing_before_step.add(entity_id)
                elif entity_id not in loaded_before:
                    missing_before_step.add(entity_id)
        conn.simulationStep()
        self.t = int(conn.simulation.getTime())
        teleported = set(conn.simulation.getStartingTeleportIDList())
        self.teleports += conn.simulation.getStartingTeleportNumber()
        collided = set(conn.simulation.getCollidingVehiclesIDList())
        arrived_vehicles = set(conn.simulation.getArrivedIDList())
        arrived_persons = set(conn.simulation.getArrivedPersonIDList())
        vehicles = set(conn.vehicle.getIDList())
        loaded_vehicles = set(conn.vehicle.getLoadedIDList())
        persons = set(conn.person.getIDList())
        for ids, domain, present in (
            (conn.simulation.getDepartedIDList(), conn.vehicle, vehicles),
            (conn.simulation.getDepartedPersonIDList(), conn.person, persons),
        ):
            for entity_id in ids:
                departing_trip = self._active.get(entity_id)
                if departing_trip is not None:
                    self._depart(departing_trip)
                    if entity_id in present:
                        domain.subscribe(entity_id, SAMPLE_VARS)
        for domain in (conn.vehicle, conn.person):
            for entity_id, data in domain.getAllSubscriptionResults().items():
                if entity_id not in self._active:
                    continue
                track = self.tracks[entity_id]
                x, y = data[tc.VAR_POSITION]
                if entity_id in teleported or x == tc.INVALID_DOUBLE_VALUE or y == tc.INVALID_DOUBLE_VALUE:
                    lon, lat = math.nan, math.nan
                else:
                    lon, lat = self.net.convertXY2LonLat(x, y)
                sample(track, self.t, lon, lat, data[tc.VAR_ANGLE], data[tc.VAR_SPEED])
        outcomes = []
        for entity_id, trip in sorted(self._active.items()):
            arrived = arrived_persons if trip.travel_class == "pedestrian" else arrived_vehicles
            present = persons if trip.travel_class == "pedestrian" else loaded_vehicles
            if entity_id in teleported or entity_id in collided:
                reason = "SUMO teleport" if entity_id in teleported else "SUMO collision"
                outcomes.append(self._finish(trip, "failed", reason))
            elif entity_id in missing_before_step:
                outcomes.append(self._finish(trip, "failed", "SUMO body or walking stage was removed or changed before the simulation step"))
            elif entity_id in arrived:
                if trip.departed:
                    outcomes.append(self._finish(trip, "arrived"))
                else:
                    outcomes.append(self._finish(trip, "failed", "SUMO arrival had no observed departure"))
            elif entity_id not in present:
                outcomes.append(self._finish(trip, "failed", "SUMO entity disappeared without an arrival report"))
            elif self.t >= self.horizon_s:
                outcomes.append(self._finish(trip, "failed", "Simulation horizon reached before arrival"))
        return outcomes
