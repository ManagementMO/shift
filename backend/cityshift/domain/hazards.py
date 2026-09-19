"""Modeled hazard corridors -> edge footprints -> Restrictions.

A HazardTrack is a user/operator-defined corridor (lon/lat waypoints + radius). It is *not* a weather
forecast; the label says so. Its footprint is the set of network edges whose geometry comes within
`radius_m` of the corridor polyline; that footprint becomes a Restriction over the hazard's window so the
compiler, SUMO rerouter, and the post-run vehroute audit all see exactly the same closed edges.
"""

from __future__ import annotations

from shapely.geometry import LineString, Point

from cityshift.contracts import HazardTrack, Restriction
from cityshift.domain.network import load_net


def hazard_footprint_edges(pack_id: str, hazard: HazardTrack, vclass: str = "passenger") -> list[str]:
    net = load_net(pack_id)
    xy = [net.convertLonLat2XY(lon, lat) for lon, lat in hazard.waypoints]
    corridor = LineString(xy) if len(xy) > 1 else Point(xy[0])
    hit: list[str] = []
    for e in net.getEdges():
        if e.isSpecial() or not (e.allows(vclass) or e.allows("bus")):
            continue
        shape = e.getShape()
        geom = LineString(shape) if len(shape) > 1 else Point(shape[0])
        if geom.distance(corridor) <= hazard.radius_m:
            hit.append(e.getID())
    return sorted(hit)


def hazard_restriction(pack_id: str, hazard: HazardTrack) -> Restriction:
    edges = hazard_footprint_edges(pack_id, hazard)
    return Restriction(
        restriction_id=f"hazard-{hazard.track_id}",
        edge_ids=edges,
        start_s=hazard.start_s,
        end_s=hazard.end_s,
        modes=[m for m in hazard.modes if m in ("passenger", "bus")],
        source_claim_id=f"hazard:{hazard.track_id}",
        label=f"{hazard.label} — footprint {len(edges)} edges within {hazard.radius_m:.0f} m",
    )
