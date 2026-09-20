from __future__ import annotations

from dataclasses import dataclass

import traci

from cityshift.domain.network import route
from cityshift.live.contracts import RoadChange


@dataclass(frozen=True)
class WalkingPath:
    edges: tuple[str, ...]
    length: float


class LiveNetwork:
    def __init__(self, net, connection, origin: tuple[float, float]):
        self.net = net
        self.connection = connection
        self.origin = origin
        self.closures: list[tuple[set[str], int | None]] = []
        self.closed_edges: set[str] = set()
        self.original_permissions: dict[str, tuple[str, ...]] = {}
        self.walk_cache: dict[tuple[str, str], WalkingPath | None] = {}
        self.drive_cache: dict[tuple[str, str, str], tuple[list[str], float]] = {}
        self.mapped: dict[tuple[str, str], str] = {}
        self.warnings: list[str] = []
        self.rerouted = 0
        self.centers: dict[str, tuple[float, float]] = {}
        self.mode_edges: dict[str, list[str]] = {}

    def edge(self, edge_id: str):
        try:
            edge = self.net.getEdge(edge_id)
        except KeyError:
            raise ValueError(f"unknown road {edge_id}") from None
        if edge.isSpecial():
            raise ValueError("select a street rather than an internal junction")
        return edge

    def map_edge(self, edge_id: str, mode: str) -> str:
        edge = self.edge(edge_id)
        if edge.allows(mode):
            return edge_id
        key = edge_id, mode
        if key not in self.mapped:
            if mode not in self.mode_edges:
                self.mode_edges[mode] = [e.getID() for e in self.net.getEdges() if not e.isSpecial() and e.allows(mode)]
            if not self.mode_edges[mode]:
                raise ValueError(f"no {mode} streets in this city")
            x, y = self.center(edge_id)
            self.mapped[key] = min(self.mode_edges[mode], key=lambda eid: (self.center(eid)[0] - x) ** 2 + (self.center(eid)[1] - y) ** 2)
        return self.mapped[key]

    def center(self, edge_id: str) -> tuple[float, float]:
        if edge_id not in self.centers:
            points = self.net.getEdge(edge_id).getShape()
            self.centers[edge_id] = (sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points))
        return self.centers[edge_id]

    def walk(self, source: str, destination: str) -> WalkingPath | None:
        key = source, destination
        if key not in self.walk_cache:
            try:
                stages = self.connection.simulation.findIntermodalRoute(source, destination, modes="", pType="ped")
                edges: list[str] = []
                length = 0.0
                for stage in stages:
                    for eid in stage.edges:
                        if not edges or eid != edges[-1]:
                            edges.append(eid)
                    length += max(0.0, stage.length)
                self.walk_cache[key] = WalkingPath(tuple(edges), length) if edges else None
            except traci.TraCIException:
                self.walk_cache[key] = None
        return self.walk_cache[key]

    def drive(self, source: str, destination: str, mode: str = "passenger", from_lane: int | None = None) -> tuple[list[str], float]:
        key = source, destination, f"{mode}:{from_lane}"
        if key not in self.drive_cache:
            if source in self.closed_edges or destination in self.closed_edges:
                raise ValueError("a route endpoint is closed")
            edges, seconds = route(self.net, source, destination, mode, self.closed_edges, from_lane=from_lane)
            if not edges:
                raise ValueError(f"no {mode} route from {source} to {destination}")
            self.drive_cache[key] = edges, seconds
        return self.drive_cache[key]

    def apply(self, change: RoadChange, t: int) -> dict:
        edges = set(change.edge_ids)
        for eid in edges:
            edge = self.edge(eid)
            if not (edge.allows("passenger") or edge.allows("bus")):
                raise ValueError(f"{eid} is not a vehicle street")
        if change.until_s is not None and change.until_s <= t:
            raise ValueError("closure must end after the playhead")
        if change.kind == "close_road":
            self.closures.append((edges, change.until_s))
        else:
            self.closures = [(remaining, end) for ids, end in self.closures if (remaining := ids - edges)]
        self.expire(t)
        return {"closed_edges": len(self.closed_edges), "rerouted": self.rerouted}

    def expire(self, t: int) -> None:
        self.closures = [(ids, end) for ids, end in self.closures if end is None or end > t]
        current = set().union(*(ids for ids, _ in self.closures)) if self.closures else set()
        changed = self.closed_edges ^ current
        if not changed:
            return
        for eid in sorted(changed):
            for lane in self.net.getEdge(eid).getLanes():
                lid = lane.getID()
                if lid not in self.original_permissions:
                    self.original_permissions[lid] = tuple(self.connection.lane.getDisallowed(lid))
                original = self.original_permissions[lid]
                blocked = sorted(set(original) | {"passenger", "bus"}) if eid in current else original
                self.connection.lane.setDisallowed(lid, blocked)
        self.closed_edges = current
        self.drive_cache.clear()
        for vid in self.connection.vehicle.getIDList():
            try:
                before = self.connection.vehicle.getRoute(vid)
                self.connection.vehicle.rerouteTraveltime(vid, currentTravelTimes=False)
                after = self.connection.vehicle.getRoute(vid)
                if after != before:
                    self.rerouted += 1
                index = self.connection.vehicle.getRouteIndex(vid)
                if self.closed_edges.intersection(after[index + 1:]) and len(self.warnings) < 20:
                    self.warnings.append(f"At {t}s, {vid} had no available detour; it remains in the simulation rather than teleporting")
            except traci.TraCIException:
                if len(self.warnings) < 20:
                    self.warnings.append(f"{vid} could not reroute around the current closures; it remains accounted for")

    def world_path(self, edges: list[str]) -> list[list[float]]:
        return [[round(x - self.origin[0], 2), round(y - self.origin[1], 2)] for eid in edges for x, y in self.net.getEdge(eid).getShape()]
