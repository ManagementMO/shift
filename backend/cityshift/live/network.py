from __future__ import annotations

import heapq
import math
from collections.abc import Callable
from dataclasses import dataclass
from itertools import pairwise

import traci

from cityshift.domain.network import route
from cityshift.live.contracts import RoadChange
from cityshift.live.swarm import SwarmEvent

VEHICLE_CLASSES = frozenset({"passenger", "bus"})


@dataclass(frozen=True)
class WalkingPath:
    edges: tuple[str, ...]
    length: float


@dataclass(frozen=True)
class Closure:
    edges: frozenset[str]
    until_s: int | None
    classes: frozenset[str]
    announced: bool
    source: str


class LiveNetwork:
    def __init__(self, net, connection, origin: tuple[float, float]):
        self.net = net
        self.connection = connection
        self.origin = origin
        self.closures: list[Closure] = []
        self.closed_edges: set[str] = set()
        self.blocked_walk: set[str] = set()
        self.permissions: dict[str, frozenset[str]] = {}
        self.announced_edges: set[str] = set()
        self.original_permissions: dict[str, tuple[str, ...]] = {}
        self.walk_cache: dict[tuple[str, str], WalkingPath | None] = {}
        self.drive_cache: dict[tuple[str, str, str], tuple[list[str], float]] = {}
        self.mapped: dict[tuple[str, str], str] = {}
        self.warnings: list[str] = []
        self.rerouted = 0
        self.centers: dict[str, tuple[float, float]] = {}
        self.mode_edges: dict[str, list[str]] = {}
        self._walk_graph: dict[str, list[tuple[str, str, float]]] | None = None

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

    def distance_to(self, edge_id: str, x: float, y: float) -> float:
        points = self.net.getEdge(edge_id).getShape()
        best = math.inf
        for (ax, ay), (bx, by) in pairwise(points):
            dx, dy = bx - ax, by - ay
            length2 = dx * dx + dy * dy
            k = 0.0 if length2 == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / length2))
            best = min(best, math.hypot(ax + dx * k - x, ay + dy * k - y))
        if len(points) == 1:
            best = math.hypot(points[0][0] - x, points[0][1] - y)
        return best

    def edges_within(self, x: float, y: float, radius: float) -> list[str]:
        return sorted(e.getID() for e in self.net.getEdges() if not e.isSpecial() and self.distance_to(e.getID(), x, y) <= radius)

    def walk(self, source: str, destination: str) -> WalkingPath | None:
        """Sidewalk route between two edges. People who know about an incident keep out of its footprint."""
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
                path = WalkingPath(tuple(edges), length) if edges else None
            except traci.TraCIException:
                path = None
            if path is not None and self.blocked_walk.intersection(path.edges[1:-1]):
                path = self.walk_around(source, destination)
            self.walk_cache[key] = path
        return self.walk_cache[key]

    def walk_around(self, source: str, destination: str) -> WalkingPath | None:
        """Shortest sidewalk path that avoids blocked footprints; the current and target edges are always allowed."""
        graph = self.walk_graph()
        start, goal = self.net.getEdge(source), self.net.getEdge(destination)
        if source == destination:
            return WalkingPath((source,), start.getLength())
        goal_nodes = {goal.getFromNode().getID(): goal.getFromNode(), goal.getToNode().getID(): goal.getToNode()}
        frontier: list[tuple[float, str, tuple[str, ...]]] = []
        for node in (start.getToNode().getID(), start.getFromNode().getID()):
            heapq.heappush(frontier, (start.getLength() / 2, node, (source,)))
        seen: set[str] = set()
        while frontier:
            cost, node, path = heapq.heappop(frontier)
            if node in seen:
                continue
            seen.add(node)
            if node in goal_nodes:
                return WalkingPath((*path, destination), cost + goal.getLength() / 2)
            for eid, other, length in graph.get(node, ()):
                if eid in self.blocked_walk or eid in path or eid == destination:
                    continue
                heapq.heappush(frontier, (cost + length, other, (*path, eid)))
        return None

    def walk_graph(self) -> dict[str, list[tuple[str, str, float]]]:
        if self._walk_graph is None:
            graph: dict[str, list[tuple[str, str, float]]] = {}
            for e in self.net.getEdges():
                if e.isSpecial() or not e.allows("pedestrian"):
                    continue
                a, b, length = e.getFromNode().getID(), e.getToNode().getID(), e.getLength()
                graph.setdefault(a, []).append((e.getID(), b, length))
                graph.setdefault(b, []).append((e.getID(), a, length))
            self._walk_graph = graph
        return self._walk_graph

    def escape_path(self, from_edge: str, blocked: set[str], safe: Callable[[str], bool], position: float | None = None) -> list[str] | None:
        """Shortest sidewalk path from `from_edge` to the first edge that `safe` accepts, never entering `blocked` edges."""
        graph = self.walk_graph()
        edge = self.net.getEdge(from_edge)
        along = edge.getLength() / 2 if position is None else max(0.0, min(edge.getLength(), position))
        frontier: list[tuple[float, str, str, tuple[str, ...]]] = []
        heapq.heappush(frontier, (edge.getLength() - along, edge.getToNode().getID(), from_edge, (from_edge,)))
        heapq.heappush(frontier, (along, edge.getFromNode().getID(), from_edge, (from_edge,)))
        seen: set[str] = set()
        while frontier:
            cost, node, _, path = heapq.heappop(frontier)
            if node in seen:
                continue
            seen.add(node)
            for eid, other, length in graph.get(node, ()):
                if eid in blocked or eid in path:
                    continue
                if safe(eid):
                    return [*path, eid]
                heapq.heappush(frontier, (cost + length, other, eid, (*path, eid)))
        return None

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
            self.closures.append(Closure(frozenset(edges), change.until_s, VEHICLE_CLASSES, True, "closure"))
        else:
            kept = []
            for c in self.closures:
                remaining = c.edges - edges if c.announced else c.edges
                if remaining:
                    kept.append(Closure(remaining, c.until_s, c.classes, c.announced, c.source))
            self.closures = kept
        self.expire(t)
        return {"closed_edges": len(self.closed_edges), "rerouted": self.rerouted}

    def apply_incident(self, event: SwarmEvent, t: int) -> None:
        # a hazard that blocks nothing (heavy rain) is witnessed and talked about but never touches lane permissions
        if event.blocks:
            self.closures.append(Closure(frozenset(event.edge_ids), event.end_s, frozenset(event.blocks), False, event.event_id))
        self.expire(t)

    def expire(self, t: int) -> None:
        self.closures = [c for c in self.closures if c.until_s is None or c.until_s > t]
        desired: dict[str, set[str]] = {}
        for closure in self.closures:
            for eid in closure.edges:
                desired.setdefault(eid, set()).update(closure.classes)
        wanted = {eid: frozenset(classes) for eid, classes in desired.items()}
        changed = {eid for eid in set(wanted) | set(self.permissions) if wanted.get(eid) != self.permissions.get(eid)}
        if not changed:
            return
        for eid in sorted(changed):
            vehicle_classes = wanted.get(eid, frozenset()) & VEHICLE_CLASSES
            if vehicle_classes == (self.permissions.get(eid, frozenset()) & VEHICLE_CLASSES):
                continue
            for lane in self.net.getEdge(eid).getLanes():
                lid = lane.getID()
                if lid not in self.original_permissions:
                    self.original_permissions[lid] = tuple(self.connection.lane.getDisallowed(lid))
                self.connection.lane.setDisallowed(lid, sorted(set(self.original_permissions[lid]) | vehicle_classes))
        self.permissions = wanted
        self.closed_edges = {eid for eid, classes in wanted.items() if classes & VEHICLE_CLASSES}
        self.blocked_walk = {eid for eid, classes in wanted.items() if "pedestrian" in classes}
        self.drive_cache.clear()
        self.walk_cache.clear()
        announced = {eid for c in self.closures if c.announced for eid in c.edges}
        if announced != self.announced_edges:
            self.announced_edges = announced
            for vid in self.connection.vehicle.getIDList():
                self.reroute_vehicle(vid, t)

    def reroute_vehicle(self, vid: str, t: int) -> bool:
        try:
            before = self.connection.vehicle.getRoute(vid)
            self.connection.vehicle.rerouteTraveltime(vid, currentTravelTimes=False)
            after = self.connection.vehicle.getRoute(vid)
            changed = after != before
            if changed:
                self.rerouted += 1
            index = self.connection.vehicle.getRouteIndex(vid)
            if self.closed_edges.intersection(after[index + 1:]):
                if len(self.warnings) < 20:
                    self.warnings.append(f"At {t}s, {vid} had no available detour; it remains in the simulation rather than teleporting")
                return False
            return changed
        except traci.TraCIException:
            if len(self.warnings) < 20:
                self.warnings.append(f"{vid} could not reroute around the current closures; it remains accounted for")
            return False

    def world_path(self, edges: list[str]) -> list[list[float]]:
        return [[round(x - self.origin[0], 2), round(y - self.origin[1], 2)] for eid in edges for x, y in self.net.getEdge(eid).getShape()]
