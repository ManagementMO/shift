"""Resource / service-plan compiler: ServicePlan + ScenarioSpec + DemandSet -> SUMO inputs.

One physical bus = one SUMO vehicle for the whole window.  Duties compile to timetabled stops
(`until`) on that single vehicle; the TraCI runner switches the vehicle's `line` at each duty start
so travelers only board the duty that actually serves their destination stop.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from itertools import pairwise
from pathlib import Path

from cityshift.contracts import (
    CityPack,
    DemandSet,
    Duty,
    ScenarioSpec,
    ServicePlan,
    StopCandidate,
)
from cityshift.domain.network import closed_edges_during, load_net, route, walk_distance_m
from cityshift.transport.sumo_xml import (
    BusStopDef,
    BusTrip,
    CarTrip,
    EdgeClosure,
    PersonTrip,
    write_additional,
    write_routes,
    write_sumocfg,
)

DWELL_DROP_S = 25
VENUE_MIN_DWELL_S = 30
HOLD_BEFORE_DEPART_S = 180  # bus line is switched to the duty this long before scheduled departure
TRAVEL_FACTOR = 1.35  # schedule padding over free-flow estimate
ZONE_STOP_RADIUS_M = 300.0
WALK_SPEED_MPS = 1.3


@dataclass
class DutySchedule:
    duty: Duty
    line: str
    segments: list[list[str]]  # edge lists between consecutive stops (first: from previous position)
    est_arrivals_s: list[int]  # estimated arrival at each stop in stop_sequence
    est_end_s: int
    est_return_s: int  # back at the venue stop after deadhead


@dataclass
class CompileResult:
    ok: bool
    cfg: Path | None
    cohort_ids: list[str]
    desired_depart: dict[str, int]
    cohort_vehicles: dict[str, str]  # sumo vehicle id -> person id
    unroutable: dict[str, str]  # person id -> reason (never inserted into SUMO)
    line_schedule: dict[str, list[tuple[int, str]]]
    stop_ids: list[str]
    duty_schedules: list[DutySchedule]
    mode_assignment: dict[str, str]  # person -> ride|walk|car|unroutable
    errors: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def _dist_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    dlat = (b[1] - a[1]) * 110_574.0
    dlon = (b[0] - a[0]) * 111_320.0 * math.cos(math.radians(a[1]))
    return math.hypot(dlat, dlon)


def stops_by_id(pack: CityPack) -> dict[str, StopCandidate]:
    return {s.stop_id: s for s in pack.stops}


def zone_for_stop(pack: CityPack, stop: StopCandidate, scenario: ScenarioSpec | None = None) -> str | None:
    best, bestd = None, ZONE_STOP_RADIUS_M
    destinations = [(z.zone_id, (z.lon, z.lat)) for z in pack.zones]
    if scenario:
        destinations.extend((d.development_id, d.spec.position) for d in scenario.developments)
    for zone_id, position in destinations:
        d = _dist_m((stop.lon, stop.lat), position)
        if d < bestd:
            best, bestd = zone_id, d
    return best


def venue_stop_candidates(pack: CityPack, radius_m: float = 400.0) -> list[StopCandidate]:
    return sorted(
        (s for s in pack.stops if _dist_m((s.lon, s.lat), pack.venue_lonlat) <= radius_m),
        key=lambda s: _dist_m((s.lon, s.lat), pack.venue_lonlat),
    )


def _concat(segments: list[list[str]]) -> list[str]:
    out: list[str] = []
    for seg in segments:
        if not seg:
            continue
        if out and out[-1] == seg[0]:
            out.extend(seg[1:])
        else:
            out.extend(seg)
    return out


def schedule_duties(pack: CityPack, plan: ServicePlan, scenario: ScenarioSpec) -> tuple[list[DutySchedule], list[str]]:
    """Estimate every duty's timeline and route.  Returns (schedules, hard errors)."""
    net = load_net(pack.pack_id)
    stops = stops_by_id(pack)
    errors: list[str] = []
    schedules: list[DutySchedule] = []
    by_vehicle: dict[str, list[Duty]] = {}
    for d in plan.duties:
        by_vehicle.setdefault(d.vehicle_id, []).append(d)
    for vid, duties in by_vehicle.items():
        duties.sort(key=lambda d: d.depart_s)
        fleet = {f.vehicle_id: f for f in scenario.constraints.fleet}
        prev_edge = fleet[vid].depot_edge if vid in fleet else None
        first_duty_done = False
        for d in duties:
            if any(s not in stops for s in d.stop_sequence):
                errors.append(f"{d.duty_id}: unknown stop id in {d.stop_sequence}")
                continue
            seq = [stops[s] for s in d.stop_sequence]
            horizon_guess = d.depart_s + 3600
            closed = closed_edges_during(scenario.restrictions, d.depart_s - HOLD_BEFORE_DEPART_S, horizon_guess, "bus")
            segments: list[list[str]] = []
            arrivals: list[int] = []
            t = d.depart_s
            # positioning leg (depot or previous duty's last stop -> first stop); not timed against the schedule
            if prev_edge and prev_edge != seq[0].edge_id:
                path, _ = route(net, prev_edge, seq[0].edge_id, "bus", closed, from_lane=_lane_of(stops, prev_edge))
                if path is None:
                    errors.append(f"{d.duty_id}: bus {vid} cannot reach {seq[0].name} from {prev_edge} (closed/disconnected)")
                    continue
                segments.append(path)
            elif prev_edge and first_duty_done:
                loop, _ = route(net, seq[0].edge_id, seq[0].edge_id, "bus", closed, from_lane=seq[0].lane_index)
                if loop is None:
                    errors.append(f"{d.duty_id}: bus {vid} cannot loop back to {seq[0].name}")
                    continue
                segments.append(loop)
            else:
                segments.append([seq[0].edge_id])
            first_duty_done = True
            arrivals.append(d.depart_s)
            bad = False
            for a, b in pairwise(seq):
                path, secs = route(net, a.edge_id, b.edge_id, "bus", closed, from_lane=a.lane_index)
                if path is None:
                    errors.append(f"{d.duty_id}: no bus route {a.name} -> {b.name} avoiding closures")
                    bad = True
                    break
                t += int(secs * TRAVEL_FACTOR) + DWELL_DROP_S
                segments.append(path)
                arrivals.append(t)
            if bad:
                continue
            # deadhead back to the venue (first stop) for the next duty
            back, secs = route(net, seq[-1].edge_id, seq[0].edge_id, "bus", closed, from_lane=seq[-1].lane_index)
            est_return = t + (int(secs * TRAVEL_FACTOR) if back else 10**9)
            schedules.append(
                DutySchedule(duty=d, line=f"{vid}:{d.duty_id}", segments=segments, est_arrivals_s=arrivals, est_end_s=t, est_return_s=est_return)
            )
            prev_edge = seq[-1].edge_id
    return schedules, errors


def compile_scenario(
    pack: CityPack,
    scenario: ScenarioSpec,
    demand: DemandSet,
    plan: ServicePlan,
    out_dir: Path,
    seed: int,
) -> CompileResult:
    net = load_net(pack.pack_id)
    stops = stops_by_id(pack)
    out_dir.mkdir(parents=True, exist_ok=True)
    horizon = scenario.constraints.horizon_s
    schedules, errors = schedule_duties(pack, plan, scenario)
    if errors:
        return CompileResult(False, None, [], {}, {}, {}, {}, [], schedules, {}, errors=errors)

    # --- buses -------------------------------------------------------------------------------
    fleet = {f.vehicle_id: f for f in scenario.constraints.fleet}
    buses: list[BusTrip] = []
    line_schedule: dict[str, list[tuple[int, str]]] = {}
    sched_by_vehicle: dict[str, list[DutySchedule]] = {}
    for s in schedules:
        sched_by_vehicle.setdefault(s.duty.vehicle_id, []).append(s)
    for vid, scheds in sched_by_vehicle.items():
        scheds.sort(key=lambda s: s.duty.depart_s)
        edges: list[list[str]] = []
        stop_rows: list[tuple] = []
        for k, s in enumerate(scheds):
            edges.extend(s.segments)
            seq = s.duty.stop_sequence
            stop_rows.append((seq[0], VENUE_MIN_DWELL_S, s.duty.depart_s))
            for sid in seq[1:]:
                stop_rows.append((sid, DWELL_DROP_S))
            line_schedule.setdefault(vid, []).append((max(0, s.duty.depart_s - HOLD_BEFORE_DEPART_S), s.line))
        depart = fleet[vid].available_from_s if vid in fleet else 0
        first_line = scheds[0].line
        buses.append(BusTrip(vid, _concat(edges), stop_rows, depart_s=depart, line=first_line, capacity=fleet[vid].capacity if vid in fleet else 60))
    if errors:
        return CompileResult(False, None, [], {}, {}, {}, {}, [], schedules, {}, errors=errors)

    # --- travelers ----------------------------------------------------------------------------
    # which duties serve which zone, and where they pick up
    zone_service: dict[str, list[tuple[DutySchedule, str]]] = {}  # zone -> [(schedule, alight stop id)]
    for s in schedules:
        for sid in s.duty.stop_sequence[1:]:
            zone_service.setdefault(zone_for_stop(pack, stops[sid], scenario) or sid, []).append((s, sid))
    stop_service = [pair for entries in zone_service.values() for pair in entries]
    persons: list[PersonTrip] = []
    cars: list[CarTrip] = []
    cohort_ids: list[str] = []
    desired: dict[str, int] = {}
    cohort_vehicles: dict[str, str] = {}
    unroutable: dict[str, str] = {}
    mode: dict[str, str] = {}
    walk_cache: dict[tuple[str, str], float | None] = {}
    car_edges: dict[str, str | None] = {}
    car_paths: dict[tuple[str, str], bool] = {}
    service_cache: dict[tuple[str, str, int], list[tuple[DutySchedule, str, str, float]]] = {}
    window_end = scenario.constraints.service_window_s[1]

    def walking(a: str, b: str) -> float | None:
        key = (a, b)
        if key not in walk_cache:
            walk_cache[key] = walk_distance_m(pack.pack_id, a, b)
        return walk_cache[key]

    for tr in demand.travelers:
        cohort_ids.append(tr.person_id)
        desired[tr.person_id] = tr.depart_s
        if tr.has_car:
            for eid in (tr.origin_edge, tr.dest_edge):
                if eid not in car_edges:
                    car_edges[eid] = _nearest_allowed_edge_to_edge(net, eid, "passenger")
            origin_car_edge, dest_car_edge = car_edges[tr.origin_edge], car_edges[tr.dest_edge]
            if origin_car_edge is None or dest_car_edge is None:
                unroutable[tr.person_id] = "no drivable edge near origin or destination"
                mode[tr.person_id] = "unroutable"
                continue
            od = (origin_car_edge, dest_car_edge)
            if od not in car_paths:
                car_paths[od] = net.getShortestPath(net.getEdge(od[0]), net.getEdge(od[1]), vClass="passenger")[0] is not None
            if not car_paths[od]:
                unroutable[tr.person_id] = "no passenger route from origin to destination"
                mode[tr.person_id] = "unroutable"
                continue
            vid = f"car_{tr.person_id}"
            cars.append(CarTrip(vid, origin_car_edge, dest_car_edge, tr.depart_s))
            cohort_vehicles[vid] = tr.person_id
            mode[tr.person_id] = "car"
            continue
        service_key = (tr.origin_edge, tr.dest_edge, tr.walk_limit_m)
        if service_key not in service_cache:
            options = []
            for s, alight in stop_service:
                pickup = s.duty.stop_sequence[0]
                access = walking(tr.origin_edge, stops[pickup].edge_id)
                egress = walking(stops[alight].edge_id, tr.dest_edge)
                if access is not None and egress is not None and access + egress <= tr.walk_limit_m:
                    options.append((s, pickup, alight, access))
            service_cache[service_key] = sorted(options, key=lambda x: (x[0].duty.depart_s, x[3], x[1], x[2]))
        served = [(s, pickup, alight) for s, pickup, alight, access in service_cache[service_key]
                  if tr.depart_s + math.ceil(access / WALK_SPEED_MPS) <= s.duty.depart_s <= window_end]
        if served:
            _, pickup, alight = served[0]
            lines = sorted({s.line for s, board, drop in served if board == pickup and drop == alight})
            persons.append(PersonTrip(tr.person_id, tr.origin_edge, pickup, alight, tr.dest_edge, tr.depart_s, lines=" ".join(lines)))
            mode[tr.person_id] = "ride"
            continue
        dist = walking(tr.origin_edge, tr.dest_edge)
        if dist is None:
            unroutable[tr.person_id] = "no pedestrian path to destination"
            mode[tr.person_id] = "unroutable"
        elif dist > tr.walk_limit_m:
            unroutable[tr.person_id] = f"walk {dist:.0f} m exceeds limit {tr.walk_limit_m} m and no shuttle serves {tr.dest_zone}"
            mode[tr.person_id] = "unroutable"
        else:
            persons.append(PersonTrip(tr.person_id, tr.origin_edge, None, None, tr.dest_edge, tr.depart_s, walk_only=True))
            mode[tr.person_id] = "walk"

    # --- background traffic -------------------------------------------------------------------
    rng = random.Random(seed * 7919 + 17)
    ever_closed = {eid for r in scenario.restrictions for eid in r.edge_ids}
    drivable = [e for e in net.getEdges() if e.allows("passenger") and not e.isSpecial() and e.getLength() > 30 and e.getID() not in ever_closed]
    for i in range(demand.background_vehicles):
        a, b = rng.choice(drivable), rng.choice(drivable)
        cars.append(CarTrip(f"bg_{i:04d}", a.getID(), b.getID(), rng.randint(0, max(1, horizon - 600))))

    # --- restrictions -> rerouters --------------------------------------------------------------
    closures: list[EdgeClosure] = []
    for r in scenario.restrictions:
        notify = set(r.edge_ids)
        for eid in r.edge_ids:
            try:
                for inc in net.getEdge(eid).getIncoming():
                    if not inc.isSpecial():
                        notify.add(inc.getID())
            except KeyError:
                pass
        closures.append(EdgeClosure(r.restriction_id, sorted(notify), r.start_s, r.end_s, [m for m in r.modes if m != "pedestrian"]))
    used_stop_ids = sorted({sid for d in plan.duties for sid in d.stop_sequence})
    pickup_ids = {d.stop_sequence[0] for d in plan.duties if d.stop_sequence}
    stop_defs = [BusStopDef(s.stop_id, f"{s.edge_id}_{s.lane_index}", s.start_pos, s.end_pos, s.name, person_capacity=400 if s.stop_id in pickup_ids else 80)
                 for s in pack.stops if s.stop_id in used_stop_ids]

    add = out_dir / "scenario.add.xml"
    rou = out_dir / "scenario.rou.xml"
    cfg = out_dir / "scenario.sumocfg"
    write_additional(add, stop_defs, closures)
    write_routes(rou, buses, persons, cars, bus_capacity=max([f.capacity for f in fleet.values()] or [60]))
    write_sumocfg(cfg, Path(pack.net_file), rou, [add], horizon, seed, out_dir / "tripinfo.xml")
    notes = [
        f"{len(persons)} persons inserted ({sum(1 for m in mode.values() if m == 'ride')} ride, {sum(1 for m in mode.values() if m == 'walk')} walk)",
        f"{len(cohort_vehicles)} cohort cars, {demand.background_vehicles} background cars",
        f"{len(unroutable)} travelers unroutable at compile time (kept in the cohort accounting)",
    ]
    return CompileResult(True, cfg, cohort_ids, desired, cohort_vehicles, unroutable, line_schedule, used_stop_ids, schedules, mode, notes=notes)


def _lane_of(stops: dict[str, StopCandidate], edge_id: str) -> int | None:
    for s in stops.values():
        if s.edge_id == edge_id:
            return s.lane_index
    return None


def _nearest_allowed(net, lonlat: tuple[float, float], vclass: str, radius: float = 400.0) -> str | None:
    x, y = net.convertLonLat2XY(*lonlat)
    cands = [(d, e) for e, d in net.getNeighboringEdges(x, y, radius) if e.allows(vclass) and not e.isSpecial()]
    cands.sort(key=lambda t: (t[0], t[1].getID()))
    return cands[0][1].getID() if cands else None


def _nearest_allowed_edge_to_edge(net, edge_id: str, vclass: str) -> str | None:
    if not net.hasEdge(edge_id):
        return None
    e = net.getEdge(edge_id)
    if e.allows(vclass):
        return edge_id
    shape = e.getShape()
    mx = sum(p[0] for p in shape) / len(shape)
    my = sum(p[1] for p in shape) / len(shape)
    cands = [(d, c) for c, d in net.getNeighboringEdges(mx, my, 250) if c.allows(vclass) and not c.isSpecial()]
    if not cands:
        return None
    cands.sort(key=lambda t: t[0])
    return cands[0][1].getID()


# --- plan families -------------------------------------------------------------------------------

def make_cycles(
    pack: CityPack,
    scenario: ScenarioSpec,
    vehicle_id: str,
    pickup_stop: str,
    drop_stops: list[str],
    first_depart_s: int,
    duty_prefix: str,
    max_cycles: int = 12,
) -> list[Duty]:
    """Repeat pickup -> drops -> deadhead back until the service window closes."""
    net = load_net(pack.pack_id)
    stops = stops_by_id(pack)
    window_end = scenario.constraints.service_window_s[1]
    duties: list[Duty] = []
    t = first_depart_s
    seq = [pickup_stop, *drop_stops]
    for k in range(max_cycles):
        if t > window_end:
            break
        duties.append(Duty(duty_id=f"{duty_prefix}{k+1}", vehicle_id=vehicle_id, stop_sequence=seq, depart_s=t, layover_s=60))
        # estimate the cycle time
        closed = closed_edges_during(scenario.restrictions, t, t + 3600, "bus")
        cyc = 0.0
        for a, b in pairwise(seq):
            _, secs = route(net, stops[a].edge_id, stops[b].edge_id, "bus", closed, from_lane=stops[a].lane_index)
            if secs == math.inf:
                return duties
            cyc += secs * TRAVEL_FACTOR + DWELL_DROP_S
        _, back = route(net, stops[seq[-1]].edge_id, stops[seq[0]].edge_id, "bus", closed, from_lane=stops[seq[-1]].lane_index)
        if back == math.inf:
            return duties
        cyc += back * TRAVEL_FACTOR + 60 + VENUE_MIN_DWELL_S
        t += int(math.ceil(cyc / 60.0) * 60)
    return duties


def zone_anchor_stop(pack: CityPack, zone_id: str) -> str:
    z = next(z for z in pack.zones if z.zone_id == zone_id)
    stops = sorted(pack.stops, key=lambda s: _dist_m((s.lon, s.lat), (z.lon, z.lat)))
    return stops[0].stop_id


def origin_destination_plans(pack: CityPack, scenario: ScenarioSpec, demand: DemandSet) -> list[ServicePlan]:
    allowed = set(scenario.constraints.allowed_stop_ids)
    stops = [s for s in pack.stops if s.allowed and (not allowed or s.stop_id in allowed)]
    anchors: dict[tuple[str, bool], tuple[str, float] | None] = {}

    def anchor(edge_id: str, origin: bool) -> tuple[str, float] | None:
        key = (edge_id, origin)
        if key not in anchors:
            distances = []
            for stop in stops:
                a, b = (edge_id, stop.edge_id) if origin else (stop.edge_id, edge_id)
                distance = walk_distance_m(pack.pack_id, a, b)
                if distance is not None:
                    distances.append((distance, stop.stop_id))
            nearest = min(distances) if distances else None
            anchors[key] = (nearest[1], nearest[0]) if nearest else None
        return anchors[key]

    counts: dict[tuple[str, str], int] = {}
    ready: dict[tuple[str, str], int] = {}
    for traveler in demand.travelers:
        if traveler.has_car:
            continue
        pickup, drop = anchor(traveler.origin_edge, True), anchor(traveler.dest_edge, False)
        if not pickup or not drop or pickup[0] == drop[0] or pickup[1] + drop[1] > traveler.walk_limit_m:
            continue
        pair = (pickup[0], drop[0])
        counts[pair] = counts.get(pair, 0) + 1
        arrival = traveler.depart_s + math.ceil(pickup[1] / WALK_SPEED_MPS)
        ready[pair] = min(ready.get(pair, arrival), arrival)
    pairs = sorted(counts, key=lambda pair: (-counts[pair], pair))
    duties = []
    served_pairs = []
    for vehicle, pair in zip(scenario.constraints.fleet, pairs):
        first = max(scenario.constraints.service_window_s[0], vehicle.available_from_s, ready[pair] + 60)
        cycles = make_cycles(pack, scenario, vehicle.vehicle_id, pair[0], [pair[1]], first, f"{vehicle.vehicle_id}-od-")
        if cycles:
            duties.extend(cycles)
            served_pairs.append(f"{pair[0]} → {pair[1]} ({counts[pair]} eligible no-car trips)")
    if not duties:
        return []
    return [ServicePlan(
        plan_id="od-direct", name="Shuttles: busiest origin/destination pairs", family="heuristic",
        duties=duties, authored_by="heuristic", rationale="; ".join(served_pairs),
        assumptions=["Ranked by declared trips with connected walking access, not venue-only zones.",
                     "A separate service response: run it against the no-extra-service baseline; capacity and timing are measured in SUMO."],
    )]


def heuristic_plans(pack: CityPack, scenario: ScenarioSpec, demand: DemandSet) -> list[ServicePlan]:
    zone_ids = {z.zone_id for z in pack.zones}
    if scenario.developments or any(t.origin_edge != pack.venue_edge_id or t.dest_zone not in zone_ids for t in demand.travelers):
        return origin_destination_plans(pack, scenario, demand)
    fleet = [f.vehicle_id for f in scenario.constraints.fleet]
    pickups = venue_stop_candidates(pack)
    if len(fleet) < 2 or not pickups:
        return []
    pickup = pickups[0].stop_id
    start = scenario.constraints.service_window_s[0]
    # demand by zone (declared), used only to order zones for heuristics
    counts: dict[str, int] = {}
    for t in demand.travelers:
        if not t.has_car:
            counts[t.dest_zone] = counts.get(t.dest_zone, 0) + 1
    zones = sorted(counts, key=lambda z: -counts[z])
    anchors = {z: zone_anchor_stop(pack, z) for z in zones}
    plans: list[ServicePlan] = []
    if len(zones) >= 2:
        a = make_cycles(pack, scenario, fleet[0], pickup, [anchors[zones[0]]], start + 300, "A")
        b = make_cycles(pack, scenario, fleet[1], pickup, [anchors[zones[1]]], start + 300, "B")
        plans.append(ServicePlan(plan_id="direct-top2", name="Direct shuttles: two busiest zones", family="direct", duties=a + b, authored_by="heuristic",
                                 rationale=f"Bus {fleet[0]} loops venue↔{zones[0]}, bus {fleet[1]} loops venue↔{zones[1]}; other zones walk or drive.",
                                 assumptions=["zone demand ordered by declared no-car cohort counts"]))
    if len(zones) >= 4:
        a = make_cycles(pack, scenario, fleet[0], pickup, [anchors[zones[1]], anchors[zones[0]]], start + 300, "A")
        b = make_cycles(pack, scenario, fleet[1], pickup, [anchors[zones[2]], anchors[zones[3]]], start + 300, "B")
        plans.append(ServicePlan(plan_id="split-two-stop", name="Split routes: two drop stops per bus", family="split", duties=a + b, authored_by="heuristic",
                                 rationale=f"{fleet[0]} serves {zones[1]} then {zones[0]}; {fleet[1]} serves {zones[2]} then {zones[3]}. Covers four zones with fewer cycles each.",
                                 assumptions=["longer cycles reduce frequency at the venue"]))
    return plans


def baseline_plan() -> ServicePlan:
    return ServicePlan(plan_id="baseline", name="Baseline: no extra service", family="none", duties=[], authored_by="baseline",
                       rationale="Travelers drive if they have a car, otherwise walk within their declared limit.")
