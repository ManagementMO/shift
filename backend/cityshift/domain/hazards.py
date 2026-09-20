"""Modeled hazard corridors -> edge footprints -> Restrictions.

A HazardTrack is a user/operator-defined corridor (lon/lat waypoints + radius). It is *not* a weather
forecast; the label says so. Its footprint is the set of network edges whose geometry comes within
`radius_m` of the corridor polyline; that footprint becomes a Restriction over the hazard's window so the
compiler, SUMO rerouter, and the post-run vehroute audit all see exactly the same closed edges.
"""

from __future__ import annotations

import math

from shapely.geometry import LineString, Point, Polygon

from cityshift.contracts import CityPack, HazardDraft, HazardTrack, Restriction, ScenarioSpec
from cityshift.domain import network


def _geometry(pack_id: str, hazard: HazardDraft):
    draft = HazardDraft.model_validate(hazard.model_dump(include=set(HazardDraft.model_fields)))
    pack = network.load_pack(pack_id)
    west, south, east, north = pack.bbox
    if any(not (west <= lon <= east and south <= lat <= north) for lon, lat in draft.waypoints):
        raise ValueError("hazard waypoints must be inside the city pack's supported extent")
    net = network.load_net(pack_id)
    if not net.hasGeoProj():
        raise ValueError("hazard geometry requires a georeferenced city pack")
    xy = [net.convertLonLat2XY(lon, lat) for lon, lat in draft.waypoints]
    if any(not (math.isfinite(x) and math.isfinite(y)) for x, y in xy):
        raise ValueError("hazard coordinates cannot be projected onto this network")
    if draft.shape == "polygon":
        polygon = Polygon(xy)
        if not polygon.is_valid or polygon.area <= 0:
            raise ValueError("polygon corners must outline a simple area: edges cannot cross or collapse")
        return net, polygon
    return net, Point(xy[0]) if len(set(xy)) == 1 else LineString(xy)


def hazard_footprint_edges(pack_id: str, hazard: HazardDraft) -> list[str]:
    net, corridor = _geometry(pack_id, hazard)
    hit: list[str] = []
    for e in net.getEdges():
        if e.isSpecial() or not any(e.allows(mode) for mode in hazard.modes):
            continue
        shape = e.getShape()
        if not shape:
            continue
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
        modes=list(hazard.modes),
        source_claim_id=f"hazard:{hazard.track_id}",
        label=(f"{hazard.label} — static footprint {len(edges)} edges inside the drawn area" if hazard.shape == "polygon"
               else f"{hazard.label} — static footprint {len(edges)} edges within {hazard.radius_m:.0f} m"),
    )


def resolve_hazard(pack: CityPack, draft: HazardDraft, track_id: str, horizon_s: int) -> tuple[HazardTrack, Restriction]:
    values = draft.model_dump(include=set(HazardDraft.model_fields))
    hazard = HazardTrack.model_validate({**values, "track_id": track_id})
    if hazard.end_s > horizon_s:
        raise ValueError("hazard window must end within the scenario horizon")
    net, corridor = _geometry(pack.pack_id, hazard)
    polygon = corridor.buffer(hazard.radius_m)
    hazard.footprint = [
        [net.convertXY2LonLat(x, y) for x, y in ring.coords]
        for ring in [polygon.exterior, *polygon.interiors]
    ]
    return hazard, hazard_restriction(pack.pack_id, hazard)


def validate_scenario_restrictions(pack: CityPack, scenario: ScenarioSpec) -> None:
    if pack.pack_id != scenario.pack_id:
        raise ValueError("scenario and city pack do not match")
    net = network.load_net(pack.pack_id)
    known = {e.getID() for e in net.getEdges() if not e.isSpecial()}
    ids = [r.restriction_id for r in scenario.restrictions]
    if len(ids) != len(set(ids)):
        raise ValueError("restriction ids must be unique")
    for r in scenario.restrictions:
        if not r.edge_ids or not set(r.edge_ids) <= known:
            raise ValueError(f"restriction {r.restriction_id} has empty or foreign edges")
        if not (0 <= r.start_s < r.end_s <= scenario.constraints.horizon_s):
            raise ValueError(f"restriction {r.restriction_id} has an invalid time window")
        if not r.modes or not set(r.modes) <= {"passenger", "bus"}:
            raise ValueError(f"restriction {r.restriction_id} supports passenger and bus modes only")
    tracks = {h.track_id for h in scenario.hazards}
    if len(tracks) != len(scenario.hazards):
        raise ValueError("hazard track ids must be unique")
    owners = {f"hazard:{tid}" for tid in tracks}
    if any((r.source_claim_id or "").startswith("hazard:") and r.source_claim_id not in owners for r in scenario.restrictions):
        raise ValueError("orphaned hazard restriction has no matching hazard")
    for h in scenario.hazards:
        resolved, restriction = resolve_hazard(pack, h, h.track_id, scenario.constraints.horizon_s)
        owned = [r for r in scenario.restrictions if r.source_claim_id == restriction.source_claim_id]
        # A footprint that touches no supported road is a visual-only event: it owns no restriction at all.
        expected = [restriction] if restriction.edge_ids else []
        if h != resolved or owned != expected:
            raise ValueError(f"hazard {h.track_id} footprint and owned restriction must match the preview")
