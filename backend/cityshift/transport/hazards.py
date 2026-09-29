"""Declared hazards and their physical footprint, shared by the street simulation and the AI residents.

A street is inside a footprint when any point of its centreline lies within the radius. Vehicle closures are SUMO lane
permissions. Sidewalk closures are enforced by our own walking routes, because SUMO keeps walking a person along a
disallowed sidewalk (and fails on it) instead of stopping or rerouting them.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from itertools import pairwise


@dataclass(frozen=True)
class HazardProfile:
    label: str
    blocks: tuple[str, ...]
    alarm_factor: float
    default_duration_s: int
    description: str


EVERYONE = ("passenger", "bus", "pedestrian")
HAZARDS: dict[str, HazardProfile] = {
    "crash": HazardProfile("Vehicle collision", ("passenger", "bus"), 2.5, 900, "Streets inside the footprint close to cars and buses. Sidewalks stay open."),
    "fire": HazardProfile("Building fire", EVERYONE, 3.0, 1800, "Nobody may enter the footprint. People inside leave for the nearest street outside it."),
    "flood": HazardProfile("Flash flood", EVERYONE, 2.0, 3600, "Streets and sidewalks inside the footprint are impassable until the water recedes."),
    "tornado": HazardProfile("Tornado", EVERYONE, 4.0, 600, "A wide warning radius: everyone who sees it leaves the footprint and spreads the word."),
    "gas_leak": HazardProfile("Gas leak", EVERYONE, 3.0, 1200, "The footprint is evacuated and closed to all traffic."),
    # weather: rain blocks nothing (people see it and hear about it; the visual is the point), a storm closes its streets
    "rain": HazardProfile("Heavy rain", (), 1.5, 600, "Streets stay open under the downpour. People inside see it; the visual is illustrative."),
    "storm": HazardProfile("Storm", ("passenger", "bus"), 2.0, 600, "Streets inside the footprint close to cars and buses until the storm passes. Sidewalks stay open."),
}
# Every road vehicle an AI resident can use; a street closed to cars is closed to all of them.
ROAD_CLASSES = frozenset({"passenger", "bicycle", "delivery", "truck"})


def resident_classes(hazard: str) -> frozenset[str]:
    """Travel classes a hazard closes to the AI residents inside its footprint."""
    blocks = HAZARDS[hazard].blocks
    classes = set(ROAD_CLASSES) if {"passenger", "bus"} & set(blocks) else set()
    if "pedestrian" in blocks:
        classes.add("pedestrian")
    return frozenset(classes)


def alarm_radius(hazard: str, radius_m: float) -> float:
    """How far away people notice the hazard: its footprint scaled by the hazard's warning factor."""
    return round(radius_m * HAZARDS[hazard].alarm_factor, 1)


def distance_to_edge(net, edge_id: str, x: float, y: float) -> float:
    points = net.getEdge(edge_id).getShape()
    if len(points) == 1:
        return math.hypot(points[0][0] - x, points[0][1] - y)
    best = math.inf
    for (ax, ay), (bx, by) in pairwise(points):
        dx, dy = bx - ax, by - ay
        length2 = dx * dx + dy * dy
        k = 0.0 if length2 == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / length2))
        best = min(best, math.hypot(ax + dx * k - x, ay + dy * k - y))
    return best


def edges_within(net, x: float, y: float, radius: float) -> list[str]:
    return sorted(e.getID() for e in net.getEdges() if not e.isSpecial() and distance_to_edge(net, e.getID(), x, y) <= radius)
