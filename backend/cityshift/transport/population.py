from __future__ import annotations

import gzip
import hashlib
import math
import platform
import subprocess
import sys
import threading
from dataclasses import dataclass
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
from cityshift.transport.runner import classify_vehicle, sample
from cityshift.transport.sumo_env import binary
from cityshift.transport.sumo_xml import PEDESTRIAN_SPEED_MPS, POPULATION_TYPES, write_routes, write_sumocfg

SAMPLE_VARS = [tc.VAR_POSITION, tc.VAR_ANGLE, tc.VAR_SPEED]
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


@dataclass(frozen=True)
class MobilityOutcome:
    resident_id: str
    entity_id: str
    destination_id: str
    t: int
    status: Literal["arrived", "failed"]
    reason: str = ""


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
        )
        self._validate_checkpoint(path, saved)
        self._validate_checkpoint_bodies(saved)
        return saved.model_dump(mode="json")

    def restore_checkpoint(self, path: Path, metadata: dict) -> None:
        conn = self._require_open()
        if (
            self._restored or self.t != 0 or self._sequence or self._active or self._residents
            or self.tracks or self.events or self.teleports or conn.simulation.getTime() != 0
            or conn.vehicle.getLoadedIDList() or conn.person.getIDList()
            or conn.simulation.getMinExpectedNumber() != 0
        ):
            raise ValueError("Checkpoint restore requires a pristine, fresh adapter")
        saved = _Checkpoint.model_validate(metadata, strict=True)
        path = Path(path).resolve()
        self._validate_checkpoint(path, saved)
        try:
            conn.simulation.loadState(str(path))
            if conn.simulation.getTime() != saved.t:
                raise ValueError("Restored SUMO time does not match checkpoint time")
            self._validate_checkpoint_bodies(saved)
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

    def _validate_checkpoint(self, path: Path, saved: _Checkpoint) -> None:
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

    def _validate_checkpoint_bodies(self, saved: _Checkpoint) -> None:
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
                    if (entity_id in on_road) != trip.departed or not route or route[-1] != trip.destination.edge_id:
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
        if not edges or edges[0] != source.edge_id or edges[-1] != target.edge_id:
            raise ValueError(f"No {travel_class} route between the declared access positions")
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
        conn = self._require_open()
        if self.t >= self.horizon_s:
            raise ValueError("Cannot start a trip at or beyond the simulation horizon")
        if not resident_id:
            raise ValueError("A resident ID is required")
        if resident_id in self._residents:
            raise ValueError(f"Resident {resident_id} already has an active mobility body")
        route = self._route(origin, destination, travel_class)
        self._sequence += 1
        entity_id = f"body_{self.run_id}_{self._sequence:06d}"
        trip = _Trip(resident_id, entity_id, destination.anchor_id, travel_class, route.destination)
        try:
            if travel_class == "pedestrian":
                conn.person.add(entity_id, route.origin.edge_id, route.origin.position_m, depart=self.t, typeID=POPULATION_TYPES[travel_class])
                conn.person.appendWalkingStage(entity_id, route.edges, arrivalPos=route.destination.position_m)
            else:
                route_id = f"route_{entity_id}"
                conn.route.add(route_id, route.edges)
                conn.vehicle.add(
                    entity_id, route_id, typeID=POPULATION_TYPES[travel_class], depart=str(self.t),
                    departLane=str(route.origin.lane_index), departPos=str(route.origin.position_m), departSpeed="0",
                    arrivalLane=str(route.destination.lane_index), arrivalPos=str(route.destination.position_m),
                    arrivalSpeed="0",
                )
        except traci.TraCIException as error:
            self._remove_body(trip)
            raise ValueError(f"SUMO rejected {travel_class} trip: {error}") from error
        self._active[entity_id] = trip
        self._residents[resident_id] = entity_id
        self.tracks[entity_id] = EntityTrack(
            entity_id=entity_id, kind=classify_vehicle(travel_class), samples=[],
            resident_id=resident_id, vehicle_class=travel_class,
        )
        return entity_id

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
