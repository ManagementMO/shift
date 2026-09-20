from xml.etree import ElementTree as ET

import pytest

from cityshift.contracts import DemandSet, Traveler
from cityshift.domain.compiler import _nearest_allowed, baseline_plan, compile_scenario
from cityshift.domain.demand import generate_demand


def test_walking_cache_is_keyed_by_origin_and_destination(transport_world, tmp_path):
    pack, scenario, _ = transport_world
    demand = DemandSet(demand_id=scenario.demand_id, seed=7, travelers=[
        Traveler(person_id="far", origin_edge="e_AB", dest_edge="e_CD", dest_zone="east", depart_s=0, walk_limit_m=500),
        Traveler(person_id="near", origin_edge="e_CE", dest_edge="e_CD", dest_zone="east", depart_s=0, walk_limit_m=500),
    ])
    compiled = compile_scenario(pack, scenario, demand, baseline_plan(), tmp_path, 1)
    assert compiled.mode_assignment == {"far": "unroutable", "near": "walk"}
    assert set(compiled.cohort_ids) == {"far", "near"}


def test_each_car_starts_at_its_own_origin(transport_world, tmp_path):
    pack, scenario, _ = transport_world
    demand = DemandSet(demand_id=scenario.demand_id, seed=7, travelers=[
        Traveler(person_id="a", origin_edge="e_AB", dest_edge="e_CD", dest_zone="east", depart_s=0, has_car=True),
        Traveler(person_id="b", origin_edge="e_BC", dest_edge="e_CD", dest_zone="east", depart_s=1, has_car=True),
    ])
    compiled = compile_scenario(pack, scenario, demand, baseline_plan(), tmp_path, 1)
    assert compiled.ok
    trips = {t.get("id"): t for t in ET.parse(tmp_path / "scenario.rou.xml").getroot().findall("trip")}
    assert trips["car_a"].get("from") == "e_AB"
    assert trips["car_b"].get("from") == "e_BC"


def test_missing_car_origin_stays_in_unroutable_accounting(transport_world, tmp_path):
    pack, scenario, _ = transport_world
    demand = DemandSet(demand_id=scenario.demand_id, seed=7, travelers=[
        Traveler(person_id="missing", origin_edge="not-an-edge", dest_edge="e_CD", dest_zone="east", depart_s=0, has_car=True),
    ])
    compiled = compile_scenario(pack, scenario, demand, baseline_plan(), tmp_path, 1)
    assert compiled.mode_assignment == {"missing": "unroutable"}
    assert compiled.cohort_ids == ["missing"]
    assert not compiled.cohort_vehicles


def test_nearest_allowed_returns_none_when_no_candidate_exists(transport_world):
    _, _, net = transport_world
    assert _nearest_allowed(net, net.convertXY2LonLat(20000, 20000), "passenger") is None


@pytest.mark.parametrize("change", [
    {"egress_window_s": (100, 200)}, {"car_share": 0.9},
    {"walk_limits_m": ((300, 1.0),)}, {"background_vehicles": 1},
])
def test_venue_demand_identity_includes_all_generation_inputs(transport_world, change):
    pack, _, _ = transport_world
    original = generate_demand(pack, 7)
    changed = generate_demand(pack, 7, **change)
    assert changed.demand_id != original.demand_id
    assert generate_demand(pack, 7, **change) == changed
