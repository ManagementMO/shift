"""Developments placed in the running city.

A placed building is a demand source, not scenery: its declared trips are generated from the placement and
inserted into the live SUMO population.  Residents leave (outbound); office workers, students and park visitors
arrive (inbound).  Waves are offsets from the moment of placement.  Demolishing a development drops the travelers
who have not set off yet; those already on their way finish their trips.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, field
from typing import Literal

import sumolib

from cityshift.contracts import CityPack, DevelopmentAccess, DevelopmentSpec
from cityshift.live.network import LiveNetwork

MAX_ACCESS_DISTANCE_M = 100.0
MAX_DEVELOPMENT_TRIPS = 10000


@dataclass
class PlacedDevelopment:
    development_id: str
    spec: DevelopmentSpec
    access: list[DevelopmentAccess]
    placed_s: int
    person_ids: list[str] = field(default_factory=list)

    def snapshot(self) -> dict:
        return {"development_id": self.development_id, "spec": self.spec.model_dump(mode="json"), "access": [a.model_dump(mode="json") for a in self.access]}


def participants_of(spec: DevelopmentSpec) -> int:
    return math.floor(spec.capacity * spec.people_per_unit * spec.trip_rate + 0.5)


def direction_of(spec: DevelopmentSpec, returning: bool = False) -> str:
    outbound = spec.land_use == "residential"
    return "outbound" if outbound != returning else "inbound"


def development_id_for(spec: DevelopmentSpec, command_id: str) -> str:
    return "development-" + hashlib.sha256((command_id + "|" + spec.model_dump_json()).encode()).hexdigest()[:16]


def resolve_access(net: sumolib.net.Net, pack: CityPack, spec: DevelopmentSpec) -> list[DevelopmentAccess]:
    """The nearest street for each mode the building needs, within reach and connected to its counterpart zones."""
    lon, lat = spec.position
    west, south, east, north = pack.bbox
    pad = 0.0015  # ~100 m: a building on the pack's edge may still reach a street inside it
    if not (west - pad <= lon <= east + pad and south - pad <= lat <= north + pad):
        raise ValueError("development position is outside the city pack")
    zones = {z.zone_id: z for z in pack.zones}
    unknown = set(spec.zone_shares) - set(zones)
    if unknown:
        raise ValueError(f"unknown counterpart zones: {', '.join(sorted(unknown))}")
    selected = [zid for zid, share in spec.zone_shares.items() if share > 0]
    if participants_of(spec) <= 0:
        raise ValueError("capacity, occupancy and trip rate round to zero participants")
    if participants_of(spec) * (2 if spec.return_wave else 1) > MAX_DEVELOPMENT_TRIPS:
        raise ValueError(f"development exceeds the {MAX_DEVELOPMENT_TRIPS} one-way-trip limit")
    x, y = net.convertLonLat2XY(lon, lat)
    modes: list[Literal["passenger", "pedestrian"]] = []
    if spec.car_share > 0:
        modes.append("passenger")
    if spec.car_share < 1:
        modes.append("pedestrian")
    nearby = sorted(net.getNeighboringEdges(x, y, MAX_ACCESS_DISTANCE_M), key=lambda item: (item[1], item[0].getID()))
    outbound = direction_of(spec) == "outbound" or spec.return_wave is not None
    inbound = direction_of(spec) == "inbound" or spec.return_wave is not None
    sidewalks = LiveNetwork(net, None, (0.0, 0.0))  # the undirected sidewalk graph needs no running SUMO

    def connected(a: str, b: str, mode: str) -> bool:
        if mode == "pedestrian":
            return sidewalks.walk_around(a, b) is not None
        return net.getShortestPath(net.getEdge(a), net.getEdge(b), vClass=mode)[0] is not None

    access = []
    for mode in modes:
        candidates = [(edge, distance) for edge, distance in nearby if not edge.isSpecial() and edge.allows(mode)]
        if not candidates:
            raise ValueError(f"no {mode} access within {MAX_ACCESS_DISTANCE_M:g} m; place the building beside a supported existing street")
        zone_edges = {
            zid: sorted(eid for eid in zones[zid].edge_ids if net.hasEdge(eid) and not net.getEdge(eid).isSpecial() and net.getEdge(eid).allows(mode))
            for zid in selected
        }
        missing = [zid for zid, edges in zone_edges.items() if not edges]
        if missing:
            raise ValueError(f"zones have no declared {mode} access: {', '.join(missing)}")
        for edge, distance in candidates:
            eid = edge.getID()
            reachable = {
                zid: [other for other in edges if (not outbound or connected(eid, other, mode)) and (not inbound or connected(other, eid, mode))]
                for zid, edges in zone_edges.items()
            }
            if all(reachable.values()):
                access.append(DevelopmentAccess(mode=mode, edge_id=eid, distance_m=round(distance, 3), zone_edges=reachable))
                break
        else:
            raise ValueError(f"nearby {mode} access is disconnected from one or more selected zones in the requested trip directions")
    return access


def trip_counts(spec: DevelopmentSpec) -> dict[str, int]:
    participants = participants_of(spec)
    waves = 2 if spec.return_wave else 1
    first = direction_of(spec)
    outbound = participants if first == "outbound" else 0
    inbound = participants if first == "inbound" else 0
    if spec.return_wave:
        outbound += participants if first == "inbound" else 0
        inbound += participants if first == "outbound" else 0
    return {"added_trips": participants * waves, "outbound_trips": outbound, "inbound_trips": inbound}
