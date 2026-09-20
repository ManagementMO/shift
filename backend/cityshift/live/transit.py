from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from itertools import pairwise

from traci import constants as tc

from cityshift.contracts import CityPack, StopCandidate
from cityshift.domain.compiler import _concat
from cityshift.live.contracts import BusRouteChange, SessionConfig
from cityshift.live.network import LiveNetwork


@dataclass
class TransitRoute:
    bus_id: str
    line: str
    stops: list[StopCandidate]
    cycle_s: float
    path: list[list[float]]


class Transit:
    def __init__(self, network: LiveNetwork, pack: CityPack, config: SessionConfig, entities: list[dict]):
        self.network = network
        self.connection = network.connection
        self.pack = pack
        self.config = config
        self.entities = entities
        self.stops = {s.stop_id: s for s in pack.stops}
        self.fleet_ids = [f"bus_{chr(65 + i)}" if i < 26 else f"bus_{i + 1}" for i in range(config.fleet_size)]
        self.routes: dict[str, TransitRoute] = {}
        self.indices: dict[str, int] = {}
        self.max_occupancy: dict[str, int] = {}

    def add(self, change: BusRouteChange, command_id: str, t: int) -> dict:
        if change.bus_id not in self.fleet_ids:
            raise ValueError("select a vehicle from the finite fleet")
        if change.bus_id in self.routes:
            raise ValueError("that bus is already assigned to a route")
        if len(set(change.stop_ids)) != len(change.stop_ids):
            raise ValueError("choose distinct stops; the bus returns automatically")
        if any(sid not in self.stops for sid in change.stop_ids):
            raise ValueError("unknown bus stop")
        stops = [self.stops[sid] for sid in change.stop_ids]
        for stop in stops:
            if not stop.allowed:
                raise ValueError(f"stop {stop.name} is not available")
        depot = min(self.pack.stops, key=lambda s: (s.lon - self.pack.venue_lonlat[0]) ** 2 + (s.lat - self.pack.venue_lonlat[1]) ** 2)
        positioning = [depot.edge_id]
        if depot.edge_id != stops[0].edge_id:
            positioning, _ = self.network.drive(depot.edge_id, stops[0].edge_id, "bus", depot.lane_index)
        segments, seconds = [], 0.0
        for a, b in pairwise([*stops, stops[0]]):
            path, travel = self.network.drive(a.edge_id, b.edge_id, "bus", a.lane_index)
            segments.append(path)
            seconds += travel
        cycle_s = seconds * 1.35 + 50 + 18 * (len(stops) - 1)
        cycles = min(256, max(1, math.ceil((self.config.horizon_s - t) / max(1, cycle_s)) + 2))
        edges = _concat([positioning, *(segment for _ in range(cycles) for segment in segments)])
        line = "line-" + hashlib.sha256(command_id.encode()).hexdigest()[:12]
        self.connection.route.add(line, edges)
        self.connection.vehicle.add(change.bus_id, line, typeID="shuttle_bus", depart="now", line=line, personCapacity=60)
        for cycle in range(cycles):
            for i, stop in enumerate(stops):
                self.connection.vehicle.insertStop(change.bus_id, cycle * len(stops) + i, stop.stop_id, duration=50 if i == 0 else 18, flags=tc.STOP_BUS_STOP, teleport=0)
        self.routes[change.bus_id] = TransitRoute(change.bus_id, line, stops, cycle_s, self.network.world_path(_concat(segments)))
        self.indices[change.bus_id] = len(self.entities)
        self.entities.append({"index": len(self.entities), "id": change.bus_id, "kind": "bus", "capacity": 60, "depart_s": t, "line": line})
        self.max_occupancy[change.bus_id] = 0
        return {"bus_id": change.bus_id, "stop_ids": change.stop_ids, "capacity": 60, "line": line}

    def public_routes(self) -> list[dict]:
        return [{"bus_id": r.bus_id, "line": r.line, "stop_ids": [s.stop_id for s in r.stops], "path": r.path} for r in self.routes.values()]

    def fleet(self) -> list[dict]:
        return [{"id": vid, "capacity": 60, "assigned": vid in self.routes} for vid in self.fleet_ids]
