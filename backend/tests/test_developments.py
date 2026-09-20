import json
from datetime import timedelta
from xml.etree import ElementTree as ET

import pytest
from pydantic import ValidationError

from cityshift.contracts import (
    DemandSet,
    DevelopmentSpec,
    DevelopmentWave,
    Duty,
    HazardTrack,
    Restriction,
    RunStatus,
    ServicePlan,
    SimulationRun,
    Traveler,
    content_hash,
)
from cityshift.domain import edits, runs
from cityshift.domain.compiler import baseline_plan, compile_scenario, heuristic_plans
from cityshift.domain.developments import apply_development, prepare_development, resolve_development
from cityshift.domain.runs import execute_run, run_id_for


def parent_demand(scenario):
    return DemandSet(demand_id=scenario.demand_id, seed=7, travelers=[
        Traveler(person_id="incumbent", origin_edge="e_BC", dest_edge="e_CD", dest_zone="east", depart_s=0, has_car=True),
    ])


@pytest.mark.parametrize("land_use", ["residential", "office", "school", "park"])
def test_two_waves_have_declared_direction_timing_and_reverse_endpoints(transport_world, development_spec, land_use):
    pack, scenario, _ = transport_world
    parent = parent_demand(scenario)
    spec = development_spec.model_copy(update={"land_use": land_use, "return_wave": DevelopmentWave(start_s=900, end_s=1000, profile="triangular")})
    preview, demand = prepare_development(pack, scenario, parent, spec)
    assert prepare_development(pack, scenario, parent, spec) == (preview, demand)
    assert preview.participants == 8 and preview.added_trips == 16
    assert preview.inbound_trips == preview.outbound_trips == 8
    assert demand.travelers[:1] == parent.travelers
    by_person = {}
    for trip in demand.travelers[1:]:
        by_person.setdefault(trip.person_id.rsplit("-", 1)[0], []).append(trip)
    assert len(by_person) == 8
    for pair in by_person.values():
        early, late = sorted(pair, key=lambda t: t.depart_s)
        assert 0 <= early.depart_s < 60 and 900 <= late.depart_s < 1000
        assert (early.origin_edge, early.dest_edge) == (late.dest_edge, late.origin_edge)
        assert early.trip_direction == ("outbound" if land_use == "residential" else "inbound")
        assert early.has_car == late.has_car


@pytest.mark.parametrize("change", [
    {"capacity": 9}, {"land_use": "office"}, {"position": (-79.3845, 43.6400)},
    {"height_m": 45}, {"footprint_m": (40, 25)}, {"people_per_unit": 2},
    {"trip_rate": 0.5}, {"car_share": 0.75}, {"walk_limit_m": 800}, {"seed": 8},
    {"zone_shares": {"north": 1}},
    {"first_wave": DevelopmentWave(start_s=100, end_s=200, profile="triangular")},
])
def test_meaningful_inputs_change_demand_scenario_and_run_identity(transport_world, development_spec, change):
    pack, scenario, _ = transport_world
    parent = parent_demand(scenario)
    original, _ = prepare_development(pack, scenario, parent, development_spec)
    changed, _ = prepare_development(pack, scenario, parent, development_spec.model_copy(update=change))
    a, demand_a = apply_development(pack, scenario, parent, original)
    b, demand_b = apply_development(pack, scenario, parent, changed)
    assert a.scenario_id != b.scenario_id
    assert demand_a.demand_id != demand_b.demand_id
    assert run_id_for(a, baseline_plan(), 1, demand_a) != run_id_for(b, baseline_plan(), 1, demand_b)
    assert demand_a.travelers[:1] == demand_b.travelers[:1] == parent.travelers
    added_a, added_b = demand_a.travelers[1:], demand_b.travelers[1:]
    if "capacity" in change:
        assert len(added_b) == 9 and len(added_a) == 8
    if "position" in change:
        assert {t.origin_edge for t in added_a} != {t.origin_edge for t in added_b}
    if "first_wave" in change:
        assert all(100 <= t.depart_s < 200 for t in added_b)
        assert all(0 <= t.depart_s < 60 for t in added_a)
    if "zone_shares" in change:
        assert {t.dest_zone for t in added_b} == {"north"}
        assert {t.dest_zone for t in added_a} == {"east"}


@pytest.mark.parametrize(("position", "message"), [
    ((-80, 43), "outside"), ((-79.370001, 43.644), "footprint"),
    ((-79.373, 43.647), "within 100"), ((-79.388, 43.646), "disconnected"),
    ((-79.388, 43.648), "passenger access"),
])
def test_invalid_placements_are_explicit(transport_world, development_spec, position, message):
    pack, scenario, _ = transport_world
    with pytest.raises(ValueError, match=message):
        resolve_development(pack, scenario, development_spec.model_copy(update={"position": position}))


@pytest.mark.parametrize("change", [
    {"capacity": 0}, {"height_m": float("nan")}, {"land_use": "hospital"},
    {"zone_shares": {"east": 0.7}}, {"land_use": "school", "people_per_unit": 2}, {"land_use": "park", "people_per_unit": 2},
    {"return_wave": {"start_s": 10, "end_s": 20, "profile": "uniform"}},
])
def test_inconsistent_assumptions_are_rejected(development_spec, change):
    with pytest.raises(ValidationError):
        DevelopmentSpec.model_validate(development_spec.model_dump() | change)


def test_schedule_and_population_bounds_are_not_silently_clipped(transport_world, development_spec):
    pack, scenario, _ = transport_world
    for change, message in [
        ({"first_wave": DevelopmentWave(start_s=0, end_s=1900, profile="uniform")}, "horizon"),
        ({"capacity": 5000, "people_per_unit": 10}, "trip limit"),
        ({"trip_rate": 0.0001}, "zero participants"),
        ({"zone_shares": {"unknown": 1}}, "unknown counterpart"),
    ]:
        with pytest.raises(ValueError, match=message):
            resolve_development(pack, scenario, development_spec.model_copy(update=change))


def test_geometry_alone_never_changes_trip_counts_or_travel_attributes(transport_world, development_spec):
    pack, scenario, _ = transport_world
    parent = parent_demand(scenario)
    a, demand_a = prepare_development(pack, scenario, parent, development_spec)
    b, demand_b = prepare_development(pack, scenario, parent, development_spec.model_copy(update={"height_m": 250, "footprint_m": (120, 120)}))
    assert a.participants == b.participants and a.added_trips == b.added_trips
    def attrs(d):
        return [t.model_dump(exclude={"person_id", "development_id"}) for t in d.travelers]

    assert attrs(demand_a) == attrs(demand_b)


def test_branch_preserves_pack_parent_events_and_subsequent_edits(transport_world, development_spec):
    pack, scenario, _ = transport_world
    scenario.restrictions = [Restriction(restriction_id="existing", edge_ids=["e_CE"], start_s=1200, end_s=1500)]
    scenario.hazards = [HazardTrack(track_id="hazard", waypoints=[pack.center, pack.center], radius_m=30, start_s=300, end_s=500)]
    scenario.evidence_bundle_id, scenario.evidence_hash = "evidence", "hash"
    demand = parent_demand(scenario)
    before = (pack.model_dump(), scenario.model_dump(), demand.model_dump())
    preview, _ = prepare_development(pack, scenario, demand, development_spec)
    child, added = apply_development(pack, scenario, demand, preview)
    assert (pack.model_dump(), scenario.model_dump(), demand.model_dump()) == before
    assert child.restrictions == scenario.restrictions and child.hazards == scenario.hazards
    assert child.evidence_hash == "hash" and child.evidence_bundle_id == "evidence"
    edit = edits.preview(pack, child, "set fleet to 1 bus")
    edited = edits.apply(pack, child, edit)
    assert edited.developments == child.developments
    assert edited.demand_id == added.demand_id
    with pytest.raises(ValueError, match="already exists"):
        prepare_development(pack, child, added, development_spec)


def test_run_identity_uses_full_demand_and_ignores_creation_clock(transport_world):
    _, scenario, _ = transport_world
    demand = parent_demand(scenario)
    base = run_id_for(scenario, baseline_plan(), 1, demand)
    later = scenario.model_copy(update={"created_at": scenario.created_at + timedelta(days=1)})
    assert run_id_for(later, baseline_plan(), 1, demand) == base
    changed = demand.model_copy(deep=True)
    changed.travelers[0].origin_edge = "e_AB"
    assert changed.demand_id == demand.demand_id
    assert run_id_for(scenario, baseline_plan(), 1, changed) != base


def test_each_origin_gets_a_reachable_pickup_and_unknown_destination_zone_is_supported(transport_world, tmp_path):
    pack, scenario, _ = transport_world
    plan = ServicePlan(plan_id="multi-origin", name="Two pickups", family="custom", duties=[
        Duty(duty_id="east", vehicle_id="bus_A", stop_sequence=["S1", "S2"], depart_s=300),
        Duty(duty_id="north", vehicle_id="bus_B", stop_sequence=["S3", "S2"], depart_s=600),
    ])
    demand = DemandSet(demand_id=scenario.demand_id, seed=7, travelers=[
        Traveler(person_id="venue", origin_edge="e_AB", dest_edge="e_CD", dest_zone="east", depart_s=0, walk_limit_m=300),
        Traveler(person_id="north", origin_edge="e_CE", dest_edge="e_CD", dest_zone="development", depart_s=0, walk_limit_m=300),
    ])
    compiled = compile_scenario(pack, scenario, demand, plan, tmp_path, 1)
    assert compiled.mode_assignment == {"venue": "ride", "north": "ride"}
    persons = {p.get("id"): p for p in ET.parse(tmp_path / "scenario.rou.xml").getroot().findall("person")}
    assert persons["venue"].find("walk").get("busStop") == "S1"
    assert persons["north"].find("walk").get("busStop") == "S3"
    assert persons["north"].find("ride").get("lines") == "bus_B:north"
    assert heuristic_plans(pack, scenario, demand)


def test_real_sumo_added_trips_and_capacity_queues_remain_fully_accounted(transport_world, development_spec, tmp_path, monkeypatch):
    pack, scenario, _ = transport_world
    parent = parent_demand(scenario)
    preview, _ = prepare_development(pack, scenario, parent, development_spec)
    child, demand = apply_development(pack, scenario, parent, preview)
    response = ServicePlan(plan_id="response", name="One three-seat shuttle", family="custom", duties=[
        Duty(duty_id="one", vehicle_id="bus_A", stop_sequence=["S1", "S2"], depart_s=300),
    ])
    monkeypatch.setattr(runs, "RUN_ROOT", tmp_path)
    runs._runners.clear()
    measured = []
    for spec, trips, plan in [(scenario, parent, baseline_plan()), (child, demand, baseline_plan()), (child, demand, response)]:
        run = SimulationRun(run_id=run_id_for(spec, plan, 1, trips), scenario_id=spec.scenario_id, plan_id=plan.plan_id, seed=1)
        execute_run(run, pack, spec, trips, plan, persist=lambda _: None)
        assert run.status == RunStatus.completed, run.error
        metrics = run.metrics
        assert metrics is not None
        assert metrics.cohort_size == len(trips.travelers)
        assert (metrics.completed + metrics.unroutable + metrics.unfinished_waiting + metrics.unfinished_riding
                + metrics.unfinished_walking + metrics.unfinished_not_departed) == metrics.cohort_size
        record = json.loads((tmp_path / run.run_id / "cohort.json").read_text())
        assert set(record["cohort"]) == {t.person_id for t in trips.travelers}
        manifest = json.loads((tmp_path / run.run_id / "manifest.json").read_text())
        assert manifest["demand_hash"] == content_hash(trips)
        measured.append(run)
    before, without_service, with_service = measured
    assert before.metrics.completed == 1
    assert without_service.metrics.unroutable == 6
    assert with_service.metrics.boardings == 3
    assert with_service.metrics.unfinished_waiting == 3
    assert with_service.metrics.waiting_person_minutes > 0
    queues = json.loads((tmp_path / with_service.run_id / "stop_queue.json").read_text())
    assert max(n for _, n in queues["S1"]) >= 3
    runs._runners.clear()
