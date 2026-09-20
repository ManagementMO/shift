from __future__ import annotations

import hashlib
import heapq
import math
import random
from dataclasses import dataclass

import traci
from traci import constants as tc

from cityshift.contracts import CityPack
from cityshift.live.contracts import (
    MAX_TRAVELERS,
    DevelopmentChange,
    PopulationChange,
    SessionConfig,
    temperature_response,
)
from cityshift.live.developments import (
    PlacedDevelopment,
    development_id_for,
    direction_of,
    participants_of,
    resolve_access,
)
from cityshift.live.network import LiveNetwork
from cityshift.live.recording import COUNT_KEYS, FrameRow
from cityshift.live.swarm import AgentMessage, Swarm, SwarmEvent
from cityshift.live.transit import Transit

PERSON_VARS = [tc.VAR_POSITION, tc.VAR_VEHICLE, tc.VAR_SPEED, tc.VAR_ROAD_ID, tc.VAR_LANEPOSITION]
VEHICLE_VARS = [tc.VAR_POSITION, tc.VAR_ANGLE, tc.VAR_SPEED, tc.VAR_PERSON_NUMBER]
# Drivers notice brake lights and share alerts further than people talking on a sidewalk.
VEHICLE_REACH_M = 60.0


@dataclass
class Trip:
    person_id: str
    entity_id: str
    index: int
    origin: str
    destination: str
    zone: str
    depart_s: int
    has_car: bool
    position: float
    arrival_pos: float
    walk_limit: float
    state: int = 0
    plan: str = ""
    reason: str = ""
    last_x: float | None = None
    last_y: float | None = None
    heading: float = 0


class Population:
    def __init__(self, network: LiveNetwork, transit: Transit, pack: CityPack, config: SessionConfig, entities: list[dict], swarm: Swarm | None = None):
        self.network = network
        self.connection = network.connection
        self.transit = transit
        self.swarm = swarm or Swarm(config.seed, pack.pack_id)
        self.positions: dict[str, tuple[float, float]] = {}
        self.reach: dict[str, float] = {}
        self.current_edge: dict[str, str] = {}
        self.flight_paths: dict[str, list[str]] = {}
        self.pack = pack
        self.config = config
        self.entities = entities
        self.zones = {z.zone_id: z for z in pack.zones}
        self.trips: dict[str, Trip] = {}
        self.cars: dict[str, Trip] = {}
        self.developments: dict[str, PlacedDevelopment] = {}
        self.pending: list[tuple[int, str]] = []
        self.dirty: set[str] = set()
        self.latest_people: dict = {}
        self.temperature_c = config.temperature_c
        self.boardings = 0
        self.waiting_seconds = 0
        self.arrival_times: dict[str, int] = {}
        self.stop_queues: dict[str, int] = {}
        self.events: list[dict] = []
        self.rows: list[FrameRow] = []
        self.observed_agents = 0
        self.peak_observed_agents = 0

    def add(self, change: PopulationChange, command_id: str, t: int) -> dict:
        if change.destination_zone_id not in self.zones or (change.origin_zone_id and change.origin_zone_id not in self.zones):
            raise ValueError("select a known origin and destination district")
        if len(self.trips) + change.count > MAX_TRAVELERS:
            raise ValueError(f"session limit is {MAX_TRAVELERS} individually tracked travelers")
        if t + change.release_window_s >= self.config.horizon_s:
            raise ValueError("release window must finish before the simulation horizon")
        destination = self.zones[change.destination_zone_id]
        origins = [self.zones[change.origin_zone_id]] if change.origin_zone_id else [z for z in self.pack.zones if z.zone_id != destination.zone_id]
        origins = origins or [destination]
        # Travelers spread across the other districts come from each in proportion to its declared demand share.
        origin_edges: list[str] = []
        origin_weights: list[float] = []
        for zone in origins:
            edges = sorted(eid for eid in set(zone.edge_ids) if self.network.edge(eid).allows("pedestrian"))
            if edges:
                origin_edges += edges
                origin_weights += [zone.share / len(edges)] * len(edges)
        if not any(origin_weights):
            origin_weights = [1.0] * len(origin_edges)
        destination_edges = sorted(eid for eid in destination.edge_ids if self.network.edge(eid).allows("pedestrian"))
        if not origin_edges or not destination_edges:
            raise ValueError("district has no pedestrian origins or destinations")
        digest = hashlib.sha256(command_id.encode()).hexdigest()
        prefix = "p_" + digest[:10]
        if f"{prefix}_00000" in self.trips:
            raise ValueError("this demand command has already been applied")
        rng = random.Random((self.config.seed << 32) ^ int(digest[:16], 16))
        for i in range(change.count):
            pid = f"{prefix}_{i:05d}"
            origin, target = rng.choices(origin_edges, origin_weights)[0], rng.choice(destination_edges)
            car = rng.random() < self.config.car_share
            entity_id = f"car_{pid}" if car else pid
            depart = t + rng.randint(0, change.release_window_s)
            length = self.network.edge(origin).getLength()
            position = length * rng.uniform(0.08, 0.65)
            arrival = self.network.edge(target).getLength() * 0.65
            walk_limit = rng.choices([800.0, 1500.0, 2500.0], [0.3, 0.45, 0.25])[0]
            trip = Trip(pid, entity_id, len(self.entities), origin, target, destination.zone_id, depart, car, position, arrival, walk_limit)
            self.trips[pid] = trip
            if car:
                self.cars[entity_id] = trip
            self.entities.append({"index": trip.index, "id": entity_id, "person_id": pid, "kind": "car" if car else "person", "origin_edge": origin, "destination_edge": target, "destination_zone_id": destination.zone_id, "depart_s": depart, "walk_limit_m": walk_limit})
            heapq.heappush(self.pending, (depart, pid))
        return {"added_travelers": change.count, "destination_zone_id": destination.zone_id, "release_window_s": change.release_window_s}

    def add_development(self, change: DevelopmentChange, command_id: str, t: int) -> dict:
        """Place a building: generate its declared trips from the placement and queue them into the running city."""
        spec = change.spec
        access = resolve_access(self.network.net, self.pack, spec)
        development_id = development_id_for(spec, command_id)
        if development_id in self.developments:
            raise ValueError("this development has already been placed")
        participants = participants_of(spec)
        waves = [(spec.first_wave, direction_of(spec))] + ([(spec.return_wave, direction_of(spec, returning=True))] if spec.return_wave else [])
        if len(self.trips) + participants * len(waves) > MAX_TRAVELERS:
            raise ValueError(f"session limit is {MAX_TRAVELERS} individually tracked travelers")
        by_mode = {a.mode: a for a in access}
        digest = hashlib.sha256((command_id + development_id).encode()).hexdigest()
        prefix = "d_" + digest[:10]
        rng = random.Random((spec.seed << 32) ^ int(digest[:16], 16))
        zone_ids = [zid for zid, share in spec.zone_shares.items() if share > 0]
        weights = [spec.zone_shares[zid] for zid in zone_ids]
        placed = PlacedDevelopment(development_id, spec, access, t)
        for w, (wave, direction) in enumerate(waves):
            # waves are offsets from the moment of placement; the last departure must still fit inside the horizon
            start = min(t + int(wave.start_s), self.config.horizon_s - 2)
            end = min(t + int(wave.end_s), self.config.horizon_s - 1)
            for i in range(participants):
                pid = f"{prefix}_{w}{i:05d}"
                car = rng.random() < spec.car_share and "passenger" in by_mode
                gate_access = by_mode["passenger"] if car else by_mode["pedestrian"]
                zone_id = rng.choices(zone_ids, weights)[0]
                gate = gate_access.edge_id
                counterpart = rng.choice(gate_access.zone_edges[zone_id])
                origin, target = (gate, counterpart) if direction == "outbound" else (counterpart, gate)
                entity_id = f"car_{pid}" if car else pid
                depart = rng.randint(start, max(start, end))
                length = self.network.edge(origin).getLength()
                position = length * rng.uniform(0.08, 0.65)
                arrival = self.network.edge(target).getLength() * 0.65
                trip = Trip(pid, entity_id, len(self.entities), origin, target, zone_id, depart, car, position, arrival, float(spec.walk_limit_m))
                self.trips[pid] = trip
                if car:
                    self.cars[entity_id] = trip
                self.entities.append({"index": trip.index, "id": entity_id, "person_id": pid, "kind": "car" if car else "person", "origin_edge": origin, "destination_edge": target, "destination_zone_id": zone_id, "depart_s": depart, "walk_limit_m": float(spec.walk_limit_m), "development_id": development_id, "trip_direction": direction})
                heapq.heappush(self.pending, (depart, pid))
                placed.person_ids.append(pid)
        self.developments[development_id] = placed
        return {"development_id": development_id, "added_trips": len(placed.person_ids), "access": [a.model_dump(mode="json") for a in access]}

    def remove_development(self, development_id: str, t: int) -> dict:
        """Demolish a placed building: drop the travelers who have not set off yet, let the rest finish their trips."""
        placed = self.developments.pop(development_id, None)
        if placed is None:
            raise ValueError("no such development stands in this city")
        dropped = 0
        for pid in placed.person_ids:
            trip = self.trips.get(pid)
            if trip is None or trip.state != 0 or trip.depart_s <= t:
                continue
            del self.trips[pid]
            self.cars.pop(trip.entity_id, None)
            self.dirty.discard(pid)
            dropped += 1
        if dropped:
            self.pending = [(depart, pid) for depart, pid in self.pending if pid in self.trips]
            heapq.heapify(self.pending)
        return {"development_id": development_id, "dropped_travelers": dropped, "travelling": len(placed.person_ids) - dropped}

    def snapshot_developments(self) -> list[dict]:
        return [d.snapshot() for d in self.developments.values()]

    def add_initial(self) -> None:
        if not self.config.initial_population:
            return
        assigned = 0
        for i, zone in enumerate(self.pack.zones):
            n = self.config.initial_population - assigned if i == len(self.pack.zones) - 1 else int(self.config.initial_population * zone.share)
            if n:
                self.add(PopulationChange(kind="population", count=n, destination_zone_id=zone.zone_id, release_window_s=min(120, self.config.horizon_s - 1)), f"initial-{self.config.seed}-{zone.zone_id}", 0)
                assigned += n

    def change_temperature(self, temperature_c: float) -> None:
        self.temperature_c = temperature_c
        speed = 1.3 * temperature_response(temperature_c).walk_speed_factor
        for pid in self.connection.person.getIDList():
            self.connection.person.setSpeed(pid, speed)
        self.reconsider()

    def reconsider(self) -> None:
        self.dirty.update(pid for pid, trip in self.trips.items() if not trip.has_car and trip.state in (1, 2, 6))

    def before_step(self, t: int) -> None:
        while self.pending and self.pending[0][0] <= t:
            _, pid = heapq.heappop(self.pending)
            trip = self.trips[pid]
            if trip.has_car:
                self._insert_car(trip)
            else:
                self.connection.person.add(pid, trip.origin, trip.position, typeID="ped")
                self._plan(trip, trip.origin, t)
        for pid in sorted(self.dirty)[:256]:
            trip = self.trips[pid]
            data = self.latest_people.get(pid)
            if not data or data.get(tc.VAR_VEHICLE):
                self.dirty.discard(pid)
                continue
            edge = data.get(tc.VAR_ROAD_ID, "")
            if not edge or edge.startswith(":"):
                continue
            self._plan(trip, edge, t, replacing=True)
            self.dirty.discard(pid)

    def _insert_car(self, trip: Trip) -> None:
        try:
            source = self.network.map_edge(trip.origin, "passenger")
            destination = self.network.map_edge(trip.destination, "passenger")
            route, _ = self.network.drive(source, destination)
            route_id = "trip-" + trip.person_id
            self.connection.route.add(route_id, route)
            self.connection.vehicle.add(trip.entity_id, route_id, typeID="car", depart="now", departLane="best", departPos="random_free")
            trip.plan = "car"
        except (ValueError, traci.TraCIException) as exc:
            trip.state = 6
            trip.reason = str(exc)[:200]
            self.events.append({"t": trip.depart_s, "person_id": trip.person_id, "event": "unroutable"})

    def _transit_option(self, trip: Trip, source: str, tolerance: float, speed: float):
        best = None
        best_cost = math.inf
        for route in self.transit.routes.values():
            for i, pickup in enumerate(route.stops[:-1]):
                if pickup.edge_id in self.network.closed_edges:
                    continue
                access = self.network.walk(source, pickup.edge_id)
                if access is None or access.length > min(800, tolerance):
                    continue
                for drop in route.stops[i + 1:]:
                    if drop.edge_id in self.network.closed_edges:
                        continue
                    egress = self.network.walk(drop.edge_id, trip.destination)
                    if egress is None or access.length + egress.length > tolerance:
                        continue
                    cost = (access.length + egress.length) / speed + min(120, route.cycle_s / 2) + route.cycle_s / 4
                    if cost < best_cost:
                        best, best_cost = (route, pickup, drop, access, egress), cost
        return best, best_cost

    def _sheltering(self, trip: Trip, t: int) -> bool:
        if not trip.plan.startswith("flee:"):
            return False
        event = self.swarm.events.get(trip.plan[5:])
        return event is not None and event.active(t)

    def respond(self, deliveries: list[AgentMessage], t: int) -> None:
        for exposed in self.swarm.in_zone:
            trip = self.trips.get(exposed)
            aw = self.swarm.awareness_of(exposed, t)
            if trip is None or aw is None or trip.state not in (1, 2) or self._sheltering(trip, t):
                continue
            event = self.swarm.events[aw.event_id]
            if "pedestrian" in event.blocks and not aw.trapped:
                self._flee(trip, event, t)
        for message in deliveries:
            agent = message.recipient
            event = self.swarm.events[message.metadata["event_id"]]
            if not agent:
                continue
            if agent in self.cars or agent in self.transit.indices:
                changed = self.network.reroute_vehicle(agent, t)
                if changed or agent in self.swarm.in_zone:
                    self.swarm.mark_responded(agent, trapped=not changed)
                continue
            trip = self.trips.get(agent)
            if trip is None or trip.state in (0, 3, 5, 6) or "pedestrian" not in event.blocks:
                continue
            if agent in self.swarm.in_zone:
                self._flee(trip, event, t)
            elif trip.state == 1:
                self._detour_on_foot(trip, event, t)

    def _detour_on_foot(self, trip: Trip, event: SwarmEvent, t: int) -> None:
        edge = self.current_edge.get(trip.person_id, "")
        if not edge or edge.startswith(":"):
            self.dirty.add(trip.person_id)
            return
        try:
            ahead = set(self.connection.person.getEdges(trip.person_id)) - {edge}
            if not ahead & set(event.edge_ids):
                return
            self._plan(trip, edge, t, replacing=True, force=True)
            remaining = set(self.connection.person.getEdges(trip.person_id)) - {edge}
            avoided = not remaining & set(event.edge_ids)
            self.swarm.mark_responded(trip.person_id, trapped=not avoided)
            trip.reason = f"Detoured on foot after hearing about the {event.label.lower()}" if avoided else f"No sidewalk detour around the {event.label.lower()}"
        except traci.TraCIException as exc:
            self.swarm.mark_responded(trip.person_id, trapped=True)
            trip.reason = str(exc)[:200]

    def _flee(self, trip: Trip, event: SwarmEvent, t: int) -> None:
        edge = self.current_edge.get(trip.person_id, "")
        if not edge or edge.startswith(":") or self._sheltering(trip, t):
            return
        margin = event.radius_m + 10
        data = self.latest_people.get(trip.person_id) or {}
        path = self.network.escape_path(edge, set(self.network.blocked_walk) - {edge}, lambda eid: self.network.distance_to(eid, event.x, event.y) > margin, data.get(tc.VAR_LANEPOSITION))
        if path is None:
            self.swarm.mark_responded(trip.person_id, trapped=True)
            trip.reason = f"Trapped inside the {event.label.lower()} footprint"
            return
        try:
            self.connection.person.removeStages(trip.person_id)
            arrival = self.network.edge(path[-1]).getLength() / 2
            self.connection.person.appendWalkingStage(trip.person_id, path, arrival, speed=1.3 * 1.35)
            self.connection.person.appendWaitingStage(trip.person_id, max(1, event.end_s - t + 1), f"sheltering from the {event.label.lower()}")
            trip.plan = f"flee:{event.event_id}"
            trip.reason = f"Leaving the {event.label.lower()} footprint for {path[-1]}"
            self.flight_paths[trip.person_id] = path
            self.swarm.mark_responded(trip.person_id)
        except traci.TraCIException as exc:
            self.swarm.mark_responded(trip.person_id, trapped=True)
            trip.reason = str(exc)[:200]

    def _plan(self, trip: Trip, source: str, t: int, replacing: bool = False, force: bool = False) -> None:
        if replacing and self._sheltering(trip, t):
            return
        response = temperature_response(self.temperature_c)
        speed = 1.3 * response.walk_speed_factor
        tolerance = trip.walk_limit * response.walk_tolerance_factor
        direct = self.network.walk(source, trip.destination)
        option, cost = self._transit_option(trip, source, tolerance, speed)
        can_walk = direct is not None and direct.length <= tolerance
        walking_cost = direct.length / speed / response.walk_tolerance_factor if can_walk and direct else math.inf
        if option is not None and cost < walking_cost:
            route, pickup, drop, access, egress = option
            key = f"ride:{route.line}:{pickup.stop_id}:{drop.stop_id}"
        else:
            key = "walk" if can_walk else "wait"
        if replacing and key == trip.plan and not force:
            self.connection.person.setSpeed(trip.person_id, speed)
            return
        if replacing:
            self.connection.person.removeStages(trip.person_id)
        if key.startswith("ride:") and option is not None:
            route, pickup, drop, access, egress = option
            self.connection.person.appendWalkingStage(trip.person_id, access.edges, (pickup.start_pos + pickup.end_pos) / 2, speed=speed, stopID=pickup.stop_id)
            self.connection.person.appendDrivingStage(trip.person_id, drop.edge_id, route.line, stopID=drop.stop_id)
            self.connection.person.appendWalkingStage(trip.person_id, egress.edges, trip.arrival_pos, speed=speed)
            trip.reason = "Walk to the shuttle, board its finite-capacity bus, then walk to the destination"
        elif key == "walk" and direct is not None:
            self.connection.person.appendWalkingStage(trip.person_id, direct.edges, trip.arrival_pos, speed=speed)
            trip.reason = "Walking within the declared weather-adjusted tolerance"
        else:
            self.connection.person.appendWaitingStage(trip.person_id, max(1, self.config.horizon_s - t + 1), "waiting for suitable transport")
            trip.reason = "No suitable transit or walk within the declared tolerance"
        self.connection.person.setSpeed(trip.person_id, speed)
        trip.plan = key

    def observe(self, t: int) -> list[FrameRow]:
        arrived_people = set(self.connection.simulation.getArrivedPersonIDList())
        arrived_vehicles = set(self.connection.simulation.getArrivedIDList())
        for vid in self.connection.simulation.getDepartedIDList():
            if vid not in arrived_vehicles:
                self.connection.vehicle.subscribe(vid, VEHICLE_VARS)
        for pid in self.connection.simulation.getDepartedPersonIDList():
            if pid not in arrived_people:
                self.connection.person.subscribe(pid, PERSON_VARS)
            if pid in self.trips:
                self.events.append({"t": t, "person_id": pid, "event": "depart"})
        vehicles = self.connection.vehicle.getAllSubscriptionResults()
        people = self.connection.person.getAllSubscriptionResults()
        self.latest_people = people
        waiting: set[str] = set()
        for stop_id in sorted({s.stop_id for r in self.transit.routes.values() for s in r.stops}):
            ids = self.connection.busstop.getPersonIDs(stop_id)
            self.stop_queues[stop_id] = len(ids)
            waiting.update(ids)
        pending: list[tuple[str, int, dict, int, int, float | None]] = []
        positions: dict[str, tuple[float, float]] = {}
        self.current_edge = {}
        for vid, data in vehicles.items():
            if not data:
                continue
            if vid in self.transit.indices:
                occupancy = int(data.get(tc.VAR_PERSON_NUMBER, 0))
                self.transit.max_occupancy[vid] = max(self.transit.max_occupancy[vid], occupancy)
                pending.append((vid, self.transit.indices[vid], data, 3, 0, None))
                positions[vid] = data[tc.VAR_POSITION]
            elif vid in self.cars:
                trip = self.cars[vid]
                if trip.state == 0:
                    self.events.append({"t": t, "person_id": trip.person_id, "event": "depart", "vehicle_id": vid})
                trip.state = 4
                pending.append((vid, trip.index, data, 2, 4, None))
                positions[vid] = data[tc.VAR_POSITION]
        for pid, data in people.items():
            if not data or pid not in self.trips:
                continue
            trip = self.trips[pid]
            vehicle = data.get(tc.VAR_VEHICLE, "")
            state = 3 if vehicle else 2 if pid in waiting or trip.plan == "wait" else 1
            if state == 3 and trip.state != 3:
                self.boardings += 1
                self.events.append({"t": t, "person_id": pid, "event": "board", "vehicle_id": vehicle})
            elif trip.state == 3 and state != 3:
                self.events.append({"t": t, "person_id": pid, "event": "alight"})
            if state == 2:
                self.waiting_seconds += 1
            trip.state = state
            if state != 3:
                position = data[tc.VAR_POSITION]
                if trip.last_x is not None and trip.last_y is not None:
                    dx, dy = position[0] - trip.last_x, position[1] - trip.last_y
                    if dx * dx + dy * dy > 0.0001:
                        trip.heading = math.degrees(math.atan2(dx, dy)) % 360
                trip.last_x, trip.last_y = position
                pending.append((pid, trip.index, data, 1, state, trip.heading))
                positions[pid] = position
                self.current_edge[pid] = data.get(tc.VAR_ROAD_ID, "")
        self.positions = positions
        self.reach = {vid: VEHICLE_REACH_M for vid in vehicles if vid in positions}
        self.respond(self.swarm.step(t, positions, self.reach), t)
        rows: list[FrameRow] = []
        for agent, index, data, kind, state, heading in pending:
            self._row(rows, index, data, kind, state, heading, self.swarm.flags(agent, t))
        for pid in arrived_people:
            if pid in self.trips:
                self._arrive(self.trips[pid], t)
        for vid in arrived_vehicles:
            if vid in self.cars:
                self._arrive(self.cars[vid], t)
        self.rows = rows
        self.observed_agents = len(people) + len(vehicles)
        self.peak_observed_agents = max(self.peak_observed_agents, self.observed_agents)
        return rows

    def _arrive(self, trip: Trip, t: int) -> None:
        trip.state = 5
        self.arrival_times[trip.person_id] = t
        self.events.append({"t": t, "person_id": trip.person_id, "event": "arrive"})

    def _row(self, rows: list[FrameRow], index: int, data: dict, kind: int, state: int, heading: float | None = None, flags: int = 0) -> None:
        x, y = data[tc.VAR_POSITION]
        if not math.isfinite(x) or not math.isfinite(y):
            return
        angle = heading if heading is not None else data.get(tc.VAR_ANGLE, 0)
        speed = data.get(tc.VAR_SPEED, 0)
        rows.append((index, x - self.network.origin[0], y - self.network.origin[1], angle if math.isfinite(angle) else 0, speed if math.isfinite(speed) else 0, kind, state, flags))

    def counts(self) -> dict[str, int]:
        counts = dict.fromkeys(COUNT_KEYS, 0)
        counts["total"] = len(self.trips)
        for trip in self.trips.values():
            counts[COUNT_KEYS[trip.state + 1]] += 1
        return counts

    def metrics(self) -> dict:
        return {"boardings": self.boardings, "waiting_person_minutes": round(self.waiting_seconds / 60, 2), "max_occupancy": dict(self.transit.max_occupancy), "observed_agents": self.observed_agents, "peak_observed_agents": self.peak_observed_agents, "stop_queues": dict(self.stop_queues), "swarm": self.swarm.metrics()}
