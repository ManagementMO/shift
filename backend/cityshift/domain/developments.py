from __future__ import annotations

from typing import Literal

from cityshift.contracts import (
    CityPack,
    DemandSet,
    Development,
    DevelopmentAccess,
    DevelopmentPreview,
    DevelopmentSpec,
    ScenarioSpec,
    content_hash,
    utcnow,
)
from cityshift.domain.demand import append_development_demand, development_participants
from cityshift.domain.network import load_net, walk_distance_m

MAX_ACCESS_DISTANCE_M = 100.0
MAX_ADDED_TRIPS = 10000
MAX_SCENARIO_TRIPS = 20000


def resolve_development(pack: CityPack, scenario: ScenarioSpec, spec: DevelopmentSpec) -> Development:
    spec = DevelopmentSpec.model_validate(spec.model_dump())
    if scenario.pack_id != pack.pack_id:
        raise ValueError("development and scenario must use the same city pack")
    lo, bottom, hi, top = pack.bbox
    lon, lat = spec.position
    if not (lo <= lon <= hi and bottom <= lat <= top):
        raise ValueError("development position is outside the city pack")
    net = load_net(pack.pack_id)
    x, y = net.convertLonLat2XY(lon, lat)
    width, depth = spec.footprint_m
    for dx, dy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        corner_lon, corner_lat = net.convertXY2LonLat(x + dx * width / 2, y + dy * depth / 2)
        if not (lo <= corner_lon <= hi and bottom <= corner_lat <= top):
            raise ValueError("development footprint extends outside the city pack")
    for wave in (spec.first_wave, spec.return_wave):
        if wave and wave.end_s > scenario.constraints.horizon_s:
            raise ValueError("all development departure waves must fit inside the scenario horizon")
    participants = development_participants(spec)
    if not participants:
        raise ValueError("capacity, occupancy and trip rate round to zero participants")
    if participants * (2 if spec.return_wave else 1) > MAX_ADDED_TRIPS:
        raise ValueError(f"development exceeds the {MAX_ADDED_TRIPS} one-way-trip limit")
    zones = {z.zone_id: z for z in pack.zones}
    unknown = set(spec.zone_shares) - set(zones)
    if unknown:
        raise ValueError(f"unknown counterpart zones: {', '.join(sorted(unknown))}")
    selected = sorted(z for z, share in spec.zone_shares.items() if share > 0)
    needs_outbound = spec.land_use == "residential" or spec.return_wave is not None
    needs_inbound = spec.land_use != "residential" or spec.return_wave is not None
    modes: list[Literal["passenger", "pedestrian"]] = []
    if spec.car_share > 0:
        modes.append("passenger")
    if spec.car_share < 1:
        modes.append("pedestrian")
    nearby = sorted(net.getNeighboringEdges(x, y, MAX_ACCESS_DISTANCE_M), key=lambda item: (item[1], item[0].getID()))
    access = []

    def connected(a: str, b: str, mode: str) -> bool:
        if mode == "pedestrian":
            return walk_distance_m(pack.pack_id, a, b) is not None
        return net.getShortestPath(net.getEdge(a), net.getEdge(b), vClass=mode)[0] is not None

    for mode in modes:
        candidates = [(edge, distance) for edge, distance in nearby if not edge.isSpecial() and edge.allows(mode)]
        if not candidates:
            raise ValueError(f"no {mode} access within {MAX_ACCESS_DISTANCE_M:g} m; place the building beside a supported existing network edge")
        zone_candidates = {
            zid: sorted(eid for eid in zones[zid].edge_ids
                        if net.hasEdge(eid) and not net.getEdge(eid).isSpecial() and net.getEdge(eid).allows(mode))
            for zid in selected
        }
        missing = [zid for zid, edges in zone_candidates.items() if not edges]
        if missing:
            raise ValueError(f"zones have no declared {mode} access: {', '.join(missing)}")

        for edge, distance in candidates:
            eid = edge.getID()
            reachable = {
                zid: [other for other in edges
                      if (not needs_outbound or connected(eid, other, mode))
                      and (not needs_inbound or connected(other, eid, mode))]
                for zid, edges in zone_candidates.items()
            }
            if all(reachable.values()):
                access.append(DevelopmentAccess(mode=mode, edge_id=eid, distance_m=round(distance, 3), zone_edges=reachable))
                break
        else:
            raise ValueError(f"nearby {mode} access is disconnected from one or more selected zones in the requested trip directions")
    identity = content_hash({
        "model": "development-v1", "pack": pack.pack_id, "network": pack.network_fingerprint,
        "spec": spec.model_dump(mode="json"), "access": [a.model_dump(mode="json") for a in access],
    })
    return Development(development_id=f"development-{identity}", spec=spec, access=access)


def prepare_development(
    pack: CityPack, scenario: ScenarioSpec, parent: DemandSet, spec: DevelopmentSpec,
) -> tuple[DevelopmentPreview, DemandSet]:
    if scenario.demand_id != parent.demand_id:
        raise ValueError("parent scenario and demand identities do not match")
    development = resolve_development(pack, scenario, spec)
    if any(d.development_id == development.development_id for d in scenario.developments):
        raise ValueError("this development already exists in the scenario")
    demand = append_development_demand(parent, development)
    if len(demand.travelers) > MAX_SCENARIO_TRIPS:
        raise ValueError(f"scenario exceeds the {MAX_SCENARIO_TRIPS} one-way-trip limit")
    added = demand.travelers[len(parent.travelers):]
    identity = content_hash({
        "parent": scenario.model_dump(mode="json", exclude={"created_at"}),
        "parent_demand": content_hash(parent), "development": development.model_dump(mode="json"),
        "demand": content_hash(demand),
    })
    warnings = [
        "Synthetic transport experiment, not a calibrated planning forecast or a zoning/permit check.",
        "Capacity × people per unit × trip rate is rounded half up to participants; each enabled wave adds one trip per participant.",
        "Car share is rounded half up to vehicles per wave: one car per car trip, without carpooling or linked escort tours.",
        "Return legs are independent one-way trips, not a linked daily itinerary; metrics count trips, not unique residents or students.",
        "Access is an edge-level approximation within 100 m; no driveway, street, pedestrian link or construction closure is created.",
        "Counterpart edges are restricted to mode-compatible connected edges in the explicitly weighted pack zones.",
        "Waves specify departure times from each origin, not guaranteed arrival times; triangular waves peak at their midpoint.",
        "Height and footprint affect the visual overlay only; occupancy and trips come solely from the declared capacity and travel assumptions.",
    ]
    if scenario.restrictions:
        warnings.append("Static access is connected; active restrictions and walk limits may still make trips unroutable. They remain in run accounting.")
    return DevelopmentPreview(
        preview_id=f"development-preview-{identity}", base_scenario_id=scenario.scenario_id,
        development=development, participants=development_participants(spec),
        incumbent_trips=len(parent.travelers), added_trips=len(added),
        inbound_trips=sum(t.trip_direction == "inbound" for t in added),
        outbound_trips=sum(t.trip_direction == "outbound" for t in added),
        car_trips=sum(t.has_car for t in added), warnings=warnings,
    ), demand


def apply_development(
    pack: CityPack, scenario: ScenarioSpec, parent: DemandSet, proposal: DevelopmentPreview,
) -> tuple[ScenarioSpec, DemandSet]:
    if proposal.base_scenario_id != scenario.scenario_id:
        raise ValueError("development was previewed against a different scenario")
    checked, demand = prepare_development(pack, scenario, parent, proposal.development.spec)
    if checked != proposal:
        raise ValueError("development preview is stale or modified; preview the current assumptions again")
    development = checked.development
    change = f"add {development.spec.land_use} {development.spec.name}: {checked.added_trips} one-way trips"
    child = scenario.model_copy(deep=True, update={
        "scenario_id": f"{pack.pack_id}-development-{checked.preview_id.removeprefix('development-preview-')}",
        "demand_id": demand.demand_id,
        "developments": [d.model_copy(deep=True) for d in scenario.developments] + [development],
        "parent_scenario_id": scenario.scenario_id,
        "change_set": [*scenario.change_set, change], "label": f"{scenario.label} · {change}", "created_at": utcnow(),
    })
    return child, demand


def remove_development(scenario: ScenarioSpec, demand: DemandSet, development_id: str) -> tuple[ScenarioSpec, DemandSet]:
    """In-place removal: the development and exactly its trips go; every other traveler keeps its identity."""
    if scenario.demand_id != demand.demand_id:
        raise ValueError("scenario and demand identities do not match")
    development = next((d for d in scenario.developments if d.development_id == development_id), None)
    if development is None:
        raise KeyError(development_id)
    kept = [t.model_copy(deep=True) for t in demand.travelers if t.development_id != development_id]
    identity = content_hash({
        "generator": "development-removed-v1", "parent": content_hash(demand), "removed": development_id,
    })
    new_demand = DemandSet(
        demand_id=f"demand-{identity}", seed=demand.seed, travelers=kept,
        background_vehicles=demand.background_vehicles, synthetic=True,
        generation_method=f"{demand.generation_method}; removed {development_id}: {len(demand.travelers) - len(kept)} trips",
    )
    change = f"remove {development.spec.land_use} {development.spec.name}: {len(demand.travelers) - len(kept)} one-way trips"
    updated = scenario.model_copy(deep=True, update={
        "demand_id": new_demand.demand_id,
        "developments": [d.model_copy(deep=True) for d in scenario.developments if d.development_id != development_id],
        "change_set": [*scenario.change_set, change],
    })
    return updated, new_demand


def demolish_building(scenario: ScenarioSpec, building_id: str) -> ScenarioSpec:
    """Hide a base-city building in this scenario. Visual only: base buildings generate no trips here."""
    building_id = building_id.strip()
    if not building_id or len(building_id) > 80:
        raise ValueError("building id must be 1-80 characters")
    if building_id in scenario.demolished:
        return scenario
    return scenario.model_copy(deep=True, update={
        "demolished": [*scenario.demolished, building_id],
        "change_set": [*scenario.change_set, f"demolish building {building_id}"],
    })
