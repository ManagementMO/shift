"""Flagship scenario factory: concert egress during an Uptown closure with two extra buses."""

from __future__ import annotations

from cityshift.contracts import CityPack, ConstraintSet, DemandSet, FleetVehicle, Restriction, ScenarioSpec
from cityshift.domain.compiler import venue_stop_candidates
from cityshift.domain.demand import generate_demand
from cityshift.domain.network import load_corridors


def flagship_scenario(pack: CityPack, seed: int = 7, cohort_size: int = 240, horizon_s: int = 2700) -> tuple[ScenarioSpec, DemandSet]:
    demand = generate_demand(pack, seed=seed, cohort_size=cohort_size)
    venue_stop = venue_stop_candidates(pack)[0]
    corridors = load_corridors(pack.pack_id)
    restrictions = []
    if "king_uptown" in corridors:
        restrictions.append(
            Restriction(
                restriction_id="closure-king-uptown",
                edge_ids=corridors["king_uptown"]["edge_ids"],
                start_s=0,
                end_s=horizon_s,
                modes=["passenger", "bus"],
                label=corridors["king_uptown"]["label"] + " — closed both directions (fixture notice, not a live advisory)",
            )
        )
    cons = ConstraintSet(
        fleet=[
            FleetVehicle(vehicle_id="bus_A", capacity=60, depot_edge=venue_stop.edge_id, available_from_s=0),
            FleetVehicle(vehicle_id="bus_B", capacity=60, depot_edge=venue_stop.edge_id, available_from_s=0),
        ],
        horizon_s=horizon_s,
        service_window_s=(0, horizon_s - 600),
        allowed_stop_ids=[s.stop_id for s in pack.stops],
        objective="completion_by_horizon",
        hard_max_fleet=2,
    )
    spec = ScenarioSpec(
        scenario_id=f"concert-egress-{pack.pack_id}-n{cohort_size}-h{horizon_s}-s{seed}",
        pack_id=pack.pack_id,
        demand_id=demand.demand_id,
        restrictions=restrictions,
        constraints=cons,
        label="Concert egress at Waterloo Park during the King St Uptown closure; two extra buses for 35 minutes",
    )
    return spec, demand
