"""SUMO/TraCI run controller.

One controller advances one headless SUMO process, records sampled trajectories, person stage
events, boarding/alighting, occupancy, teleports; then derives metrics from the recorded truth.
"""

from __future__ import annotations

import json
import math
import statistics
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal
from xml.etree import ElementTree as ET

import sumolib
import traci
from traci import constants as tc

from cityshift.contracts import EntityTrack, PersonEvent, RunMetrics
from cityshift.transport.sumo_env import binary

EntityKind = Literal["bus", "car", "person", "bicycle", "delivery", "truck"]
TRACK_KINDS: dict[str, EntityKind] = {
    "bus": "bus", "passenger": "car", "pedestrian": "person",
    "bicycle": "bicycle", "delivery": "delivery", "truck": "truck",
}


def classify_vehicle(vehicle_class: str) -> EntityKind:
    return TRACK_KINDS.get(vehicle_class, "car")


def _finite(value: float, fallback: float) -> float:
    return value if math.isfinite(value) else fallback


def sample(tr: EntityTrack, t: int, lon: float, lat: float, angle: float, speed: float) -> None:
    """Append one TraCI sample.  A non-finite position (a teleporting vehicle reports INVALID_DOUBLE_VALUE)
    is no measurement at all: nothing is appended and the trail breaks before the next real sample.  Non-finite
    angle/speed (e.g. a bus while stopped) would make the artifact invalid JSON, so they carry the previous value."""
    if not (math.isfinite(lon) and math.isfinite(lat)):
        nxt = len(tr.samples)
        if nxt and (not tr.breaks or tr.breaks[-1] != nxt):
            tr.breaks.append(nxt)
        return
    prev = tr.samples[-1] if tr.samples else None
    a = _finite(angle, prev[3] if prev else 0.0)
    v = _finite(speed, prev[4] if prev else 0.0)
    tr.samples.append([t, round(lon, 7), round(lat, 7), round(a, 1), round(v, 2)])

# Derived person states.  SUMO reports stage type 3 ("driving") both while a person waits at a stop
# for a ride and while riding; the two are told apart by whether a vehicle is assigned.
STATE_WALKING = "walking"
STATE_WAITING = "waiting"
STATE_RIDING = "riding"
STATE_OTHER = "other"
VEH_VARS = [tc.VAR_POSITION, tc.VAR_ANGLE, tc.VAR_SPEED, tc.VAR_PERSON_NUMBER]
PERSON_VARS = [tc.VAR_POSITION, tc.VAR_VEHICLE, tc.VAR_SPEED, tc.VAR_STAGE]


def derive_state(stage_type: int, vehicle_id: str) -> str:
    if stage_type == tc.STAGE_WALKING:
        return STATE_WALKING
    if stage_type == tc.STAGE_DRIVING:
        return STATE_RIDING if vehicle_id else STATE_WAITING
    if stage_type == tc.STAGE_WAITING:
        return STATE_WAITING
    return STATE_OTHER


@dataclass
class RunRecord:
    tracks: dict[str, EntityTrack]
    events: list[PersonEvent]
    occupancy: dict[str, list[tuple[int, int]]]  # vehicle -> [(t, persons)]
    stop_queue: dict[str, list[tuple[int, int]]]  # stop -> [(t, waiting persons)]
    teleports: int
    end_time: int
    warnings: list[str] = field(default_factory=list)
    cohort_ids: list[str] = field(default_factory=list)
    desired_depart: dict[str, int] = field(default_factory=dict)
    final_state: dict[str, str | None] = field(default_factory=dict)
    arrived: dict[str, int] = field(default_factory=dict)
    waiting_seconds: dict[str, float] = field(default_factory=dict)
    duration_stats: dict = field(default_factory=dict)


class SumoRunner:
    def __init__(self, net_file: Path, sample_every_s: int = 1, sumo_binary: str | None = None):
        self.net_file = Path(net_file)
        self.net = sumolib.net.readNet(str(self.net_file))
        self.sample_every_s = sample_every_s
        self.sumo_binary = sumo_binary or binary("sumo")
        self.has_geo = self.net.hasGeoProj()

    def to_lonlat(self, x: float, y: float) -> tuple[float, float]:
        if self.has_geo:
            return self.net.convertXY2LonLat(x, y)
        # Non-geographic fixture: synthesize a local lon/lat frame around (0,0) at ~43.47N so the
        # frontend can still render it.  1 deg lat ~ 111 km; lon scaled by cos(lat).
        lat0, lon0 = 43.4723, -80.5449
        return lon0 + x / (111_320.0 * 0.7254), lat0 + y / 110_574.0

    def run(
        self,
        cfg: Path,
        horizon_s: int,
        cohort_ids: list[str],
        desired_depart: dict[str, int],
        extra_fleet_ids: list[str],
        stop_ids: list[str],
        on_progress: Callable[[float], None] | None = None,
        cancel: Callable[[], bool] | None = None,
        label: str = "run",
        line_schedule: dict[str, list[tuple[int, str]]] | None = None,
        cohort_vehicles: dict[str, str] | None = None,
        unroutable: dict[str, str] | None = None,
    ) -> RunRecord:
        line_schedule = {k: sorted(v) for k, v in (line_schedule or {}).items()}
        cohort_vehicles = cohort_vehicles or {}
        unroutable = unroutable or {}
        cmd = [self.sumo_binary, "-c", str(cfg), "--start", "--quit-on-end"]
        traci.start(cmd, label=label, traceFile=None)
        conn = traci.getConnection(label)
        tracks: dict[str, EntityTrack] = {}
        events: list[PersonEvent] = []
        occupancy: dict[str, list[tuple[int, int]]] = {}
        stop_queue: dict[str, list[tuple[int, int]]] = {}
        last_state: dict[str, str] = {}
        last_vehicle: dict[str, str] = {}
        waiting_seconds: dict[str, float] = {pid: 0.0 for pid in cohort_ids}
        arrived: dict[str, int] = {}
        seen_persons: set[str] = set()
        kinds: dict[str, EntityKind] = {}
        vehicle_classes: dict[str, str] = {}
        departed_gone: set[str] = set()
        teleports = 0
        warnings: list[str] = []
        cohort = set(cohort_ids)
        try:
            t = 0
            while t < horizon_s:
                if cancel and cancel():
                    warnings.append("canceled")
                    break
                conn.simulationStep()
                t = int(conn.simulation.getTime())
                teleports += conn.simulation.getStartingTeleportNumber()
                for vid, entries in line_schedule.items():
                    while entries and entries[0][0] <= t:
                        _, line = entries.pop(0)
                        if vid in kinds and vid not in departed_gone:
                            conn.vehicle.setLine(vid, line)
                        else:
                            entries.insert(0, (t + 1, line))
                            break
                # vehicles (subscriptions are registered on departure)
                for vid in conn.simulation.getDepartedIDList():
                    conn.vehicle.subscribe(vid, VEH_VARS)
                    vehicle_classes[vid] = conn.vehicle.getVehicleClass(vid)
                    kinds[vid] = classify_vehicle(vehicle_classes[vid])
                for vid, d in conn.vehicle.getAllSubscriptionResults().items():
                    x, y = d[tc.VAR_POSITION]
                    lon, lat = self.to_lonlat(x, y)
                    kind = kinds.get(vid, "car")
                    tr = tracks.get(vid)
                    if tr is None:
                        tr = tracks[vid] = EntityTrack(entity_id=vid, kind=kind, samples=[], vehicle_class=vehicle_classes.get(vid))
                    if t % self.sample_every_s == 0:
                        sample(tr, t, lon, lat, d[tc.VAR_ANGLE], d[tc.VAR_SPEED])
                    if kind == "bus":
                        occupancy.setdefault(vid, []).append((t, d[tc.VAR_PERSON_NUMBER]))
                    elif vid in cohort_vehicles:
                        pid = cohort_vehicles[vid]
                        if pid not in seen_persons:
                            seen_persons.add(pid)
                            events.append(PersonEvent(t=t, person_id=pid, event="depart", vehicle_id=vid))
                        last_state[pid] = STATE_RIDING
                        last_vehicle[pid] = vid
                for vid in conn.simulation.getArrivedIDList():
                    departed_gone.add(vid)
                    if vid in cohort_vehicles:
                        pid = cohort_vehicles[vid]
                        arrived[pid] = t
                        events.append(PersonEvent(t=t, person_id=pid, event="arrive", vehicle_id=vid))
                        last_state.pop(pid, None)
                # persons
                for pid in conn.simulation.getDepartedPersonIDList():
                    conn.person.subscribe(pid, PERSON_VARS, parameters={tc.VAR_STAGE: 0})
                for pid, d in conn.person.getAllSubscriptionResults().items():
                    x, y = d[tc.VAR_POSITION]
                    lon, lat = self.to_lonlat(x, y)
                    veh = d[tc.VAR_VEHICLE]
                    state = derive_state(d[tc.VAR_STAGE].type, veh)
                    tr = tracks.get(pid)
                    if tr is None:
                        tr = tracks[pid] = EntityTrack(entity_id=pid, kind="person", samples=[])
                        if pid not in seen_persons:
                            seen_persons.add(pid)
                            events.append(PersonEvent(t=t, person_id=pid, event="depart"))
                    if t % self.sample_every_s == 0:
                        sample(tr, t, lon, lat, 0.0, d[tc.VAR_SPEED])
                    prev = last_state.get(pid)
                    if state != prev:
                        if state == STATE_WAITING:
                            events.append(PersonEvent(t=t, person_id=pid, event="wait_start", stop_id=_stop_at(conn, pid, stop_ids)))
                        if state == STATE_RIDING:
                            events.append(PersonEvent(t=t, person_id=pid, event="board", vehicle_id=veh, stop_id=_stop_at(conn, pid, stop_ids)))
                            tr.breaks.append(len(tr.samples) - 1)
                        if prev == STATE_RIDING:
                            events.append(PersonEvent(t=t, person_id=pid, event="alight", vehicle_id=last_vehicle.get(pid), stop_id=_stop_at(conn, pid, stop_ids)))
                            tr.breaks.append(len(tr.samples) - 1)
                        last_state[pid] = state
                    if veh:
                        last_vehicle[pid] = veh
                    if state == STATE_WAITING and pid in cohort:
                        waiting_seconds[pid] = waiting_seconds.get(pid, 0.0) + 1.0
                for pid in conn.simulation.getArrivedPersonIDList():
                    arrived[pid] = t
                    events.append(PersonEvent(t=t, person_id=pid, event="arrive"))
                    last_state.pop(pid, None)
                # stop queues
                for sid in stop_ids:
                    try:
                        n = conn.busstop.getPersonCount(sid)
                    except traci.TraCIException:
                        n = 0
                    stop_queue.setdefault(sid, []).append((t, n))
                if on_progress and t % 30 == 0:
                    on_progress(min(1.0, t / horizon_s))
                if conn.simulation.getMinExpectedNumber() == 0 and t > 1:
                    break
        finally:
            try:
                conn.close()
            except Exception:  # noqa: BLE001, S110  # pragma: no cover
                pass
        final_state = {pid: (None if pid in arrived else last_state.get(pid)) for pid in cohort_ids}
        for pid in unroutable:
            final_state[pid] = "unroutable"
            events.append(PersonEvent(t=0, person_id=pid, event="unroutable"))
        return RunRecord(
            tracks=tracks,
            events=events,
            occupancy=occupancy,
            stop_queue=stop_queue,
            teleports=teleports,
            end_time=t,
            warnings=warnings,
            cohort_ids=list(cohort_ids),
            desired_depart=dict(desired_depart),
            final_state=final_state,
            arrived=arrived,
            waiting_seconds=waiting_seconds,
        )


def _stop_at(conn, pid: str, stop_ids: list[str]) -> str | None:
    try:
        edge = conn.person.getRoadID(pid)
        pos = conn.person.getLanePosition(pid)
    except traci.TraCIException:
        return None
    for sid in stop_ids:
        try:
            lane = conn.busstop.getLaneID(sid)
            if lane.rsplit("_", 1)[0] == edge:
                s, e = conn.busstop.getStartPos(sid), conn.busstop.getEndPos(sid)
                if s - 5 <= pos <= e + 5:
                    return sid
        except traci.TraCIException:
            continue
    return None


def compute_metrics(rec: RunRecord, horizon_s: int, extra_fleet_ids: list[str], tripinfo: Path | None = None) -> RunMetrics:
    cohort = rec.cohort_ids
    completed = [pid for pid in cohort if pid in rec.arrived and rec.arrived[pid] <= horizon_s]
    durations = [rec.arrived[pid] - rec.desired_depart.get(pid, 0) for pid in completed]
    waiting = riding = walking = not_departed = unroutable = 0
    seen = {e.person_id for e in rec.events if e.event == "depart"}
    for pid in cohort:
        if pid in rec.arrived:
            continue
        st = rec.final_state.get(pid)
        if st == "unroutable":
            unroutable += 1
        elif pid not in seen:
            not_departed += 1
        elif st == STATE_WAITING:
            waiting += 1
        elif st == STATE_RIDING:
            riding += 1
        elif st == STATE_WALKING:
            walking += 1
        else:
            unroutable += 1
    boardings = sum(1 for e in rec.events if e.event == "board")
    max_occ = {vid: max((n for _, n in occ), default=0) for vid, occ in rec.occupancy.items()}
    seen_fleet = sorted(v for v in rec.tracks if rec.tracks[v].kind == "bus")
    warnings = list(rec.warnings)
    if rec.teleports:
        warnings.append(f"{rec.teleports} teleport(s) recorded; affected trails are broken, not interpolated")
    return RunMetrics(
        cohort_size=len(cohort),
        horizon_s=horizon_s,
        completed=len(completed),
        unfinished_waiting=waiting,
        unfinished_riding=riding,
        unfinished_walking=walking,
        unfinished_not_departed=not_departed,
        unroutable=unroutable,
        waiting_person_minutes=round(sum(rec.waiting_seconds.get(p, 0.0) for p in cohort) / 60.0, 2),
        completed_duration_median_s=statistics.median(durations) if durations else None,
        completed_duration_p95_s=(sorted(durations)[max(0, int(len(durations) * 0.95) - 1)] if durations else None),
        boardings=boardings,
        extra_fleet_ids=seen_fleet,
        max_occupancy=max_occ,
        teleports=rec.teleports,
        warnings=warnings,
    )


def save_record(rec: RunRecord, metrics: RunMetrics, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "tracks.json").write_text(
        json.dumps({k: v.model_dump() for k, v in rec.tracks.items()}, separators=(",", ":"))
    )
    (out_dir / "events.json").write_text(json.dumps([e.model_dump() for e in rec.events]))
    (out_dir / "occupancy.json").write_text(json.dumps(rec.occupancy))
    (out_dir / "stop_queue.json").write_text(json.dumps(rec.stop_queue))
    (out_dir / "metrics.json").write_text(metrics.model_dump_json(indent=2))
    (out_dir / "cohort.json").write_text(
        json.dumps({"cohort": rec.cohort_ids, "desired_depart": rec.desired_depart, "arrived": rec.arrived,
                    "final_state": rec.final_state, "waiting_seconds": rec.waiting_seconds})
    )


def parse_tripinfo(path: Path) -> dict:
    if not path.exists():
        return {}
    root = ET.parse(path).getroot()
    out: dict[str, dict[str, dict]] = {"persons": {}, "vehicles": {}}
    for el in root:
        if el.tag == "personinfo":
            out["persons"][el.get("id", "")] = {c.tag: dict(c.attrib) for c in el}
        elif el.tag == "tripinfo":
            out["vehicles"][el.get("id", "")] = dict(el.attrib)
    return out


def sumo_check(cfg: Path) -> tuple[bool, str]:
    """Dry-run route/network consistency without stepping (fast fail for compile errors)."""
    res = subprocess.run(
        [binary("sumo"), "-c", str(cfg), "--end", "1", "--no-step-log", "true"], capture_output=True, text=True, check=False
    )
    return res.returncode == 0, (res.stderr or res.stdout)[-2000:]
