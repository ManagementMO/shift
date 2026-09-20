from __future__ import annotations

import math
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest
import sumolib

from cityshift.citypack.make_pack import NETCONVERT_OPTS
from cityshift.citypack.world import WorldFrame, compile_network
from cityshift.contracts import CityPack, ConstraintSet, DemandSet, ScenarioSpec, Traveler
from cityshift.domain import compiler, network
from cityshift.transport.runner import SumoRunner
from cityshift.transport.sumo_xml import VTYPES, write_routes, write_sumocfg
from cityshift.transport.tiny_fixture import build_tiny_network


@pytest.fixture(scope="module")
def geo_net_path(tmp_path_factory) -> Path:
    return build_tiny_network(tmp_path_factory.mktemp("population_routes"), geo=True)


@pytest.fixture
def compile_inputs(geo_net_path, monkeypatch):
    net = sumolib.net.readNet(str(geo_net_path))
    monkeypatch.setattr(compiler, "load_net", lambda _: net)
    monkeypatch.setattr(network, "load_net", lambda _: net)
    network._walk_graph.cache_clear()
    network._walk_cache.clear()
    venue = net.convertXY2LonLat(*net.getEdge("e_AB").getShape()[0])
    pack = CityPack(
        pack_id="population-route-fixture", name="Population routes", version="1",
        net_file=str(geo_net_path), network_fingerprint="tiny-geo",
        bbox=(-79.40, 43.63, -79.37, 43.65), center=venue,
        venue_edge_id="e_AB", venue_lonlat=venue, stops=[], zones=[], real_data=False,
    )
    scenario = ScenarioSpec(
        scenario_id="multi-origin", pack_id=pack.pack_id, demand_id="demand",
        constraints=ConstraintSet(
            fleet=[], horizon_s=1200, service_window_s=(0, 900), allowed_stop_ids=[],
        ),
    )
    return net, pack, scenario


def test_compiler_drivers_use_their_actual_origins(tmp_path, compile_inputs):
    _, pack, scenario = compile_inputs
    demand = DemandSet(demand_id="demand", seed=1, travelers=[
        Traveler(person_id="west", origin_edge="e_AB", dest_edge="e_BC", dest_zone="z", depart_s=0, has_car=True),
        Traveler(person_id="east", origin_edge="e_DC", dest_edge="e_BC", dest_zone="z", depart_s=0, has_car=True),
    ])
    result = compiler.compile_scenario(pack, scenario, demand, compiler.baseline_plan(), tmp_path, 1)
    assert result.ok and not result.unroutable
    trips = {trip.attrib["id"]: trip.attrib for trip in ET.parse(tmp_path / "scenario.rou.xml").findall("trip")}
    assert trips["car_west"]["from"] == "e_AB"
    assert trips["car_east"]["from"] == "e_DC"
    assert result.cohort_vehicles == {"car_west": "west", "car_east": "east"}
    assert not ET.parse(tmp_path / "scenario.rou.xml").findall("person")


@pytest.mark.parametrize("near_first", [False, True])
def test_compiler_walk_cache_separates_origins(tmp_path, compile_inputs, near_first):
    _, pack, scenario = compile_inputs
    far = Traveler(person_id="far", origin_edge="e_AB", dest_edge="e_CD", dest_zone="z", depart_s=0, walk_limit_m=220)
    near = Traveler(person_id="near", origin_edge="e_CD", dest_edge="e_CD", dest_zone="z", depart_s=0, walk_limit_m=220)
    demand = DemandSet(demand_id="demand", seed=1, travelers=[near, far] if near_first else [far, near])
    result = compiler.compile_scenario(pack, scenario, demand, compiler.baseline_plan(), tmp_path, 1)
    assert result.ok
    assert result.mode_assignment == {"far": "unroutable", "near": "walk"}
    assert set(result.unroutable) == {"far"}


@pytest.mark.parametrize("edge_id", ["e_AB", "e_CD"])
def test_walking_rejects_forbidden_source_and_destination(compile_inputs, edge_id):
    net, pack, _ = compile_inputs
    for lane in net.getEdge(edge_id).getLanes():
        lane.setPermissions(["passenger"])
    assert network.walk_distance_m(pack.pack_id, "e_AB", "e_CD") is None


def test_walking_cache_is_scoped_to_network_identity(compile_inputs, geo_net_path, monkeypatch):
    net, pack, _ = compile_inputs
    assert network.walk_distance_m(pack.pack_id, "e_AB", "e_CD") is not None
    replacement = sumolib.net.readNet(str(geo_net_path))
    for edge_id in ("e_BC", "e_CB"):
        for lane in replacement.getEdge(edge_id).getLanes():
            lane.setPermissions(["bus"])
    assert replacement is not net
    monkeypatch.setattr(network, "load_net", lambda _: replacement)
    assert network.walk_distance_m(pack.pack_id, "e_AB", "e_CD") is None


@pytest.mark.parametrize("has_car", [False, True])
def test_compiler_unknown_origin_remains_unroutable(tmp_path, compile_inputs, has_car):
    _, pack, scenario = compile_inputs
    demand = DemandSet(demand_id="demand", seed=1, travelers=[
        Traveler(person_id="missing", origin_edge="missing", dest_edge="e_CD", dest_zone="z", depart_s=0, has_car=has_car),
    ])
    result = compiler.compile_scenario(pack, scenario, demand, compiler.baseline_plan(), tmp_path, 1)
    assert result.ok
    assert result.mode_assignment == {"missing": "unroutable"}
    assert not result.cohort_vehicles


@pytest.mark.parametrize("from_lane,closed", [(0, set()), (90, set()), (1, {"e_AB"})])
def test_routing_rejects_forbidden_source_lane_or_edge(compile_inputs, from_lane, closed):
    net, _, _ = compile_inputs
    path, seconds = network.route(net, "e_AB", "e_CD", "bus", closed, from_lane=from_lane)
    assert path is None and seconds == math.inf


def test_world_exports_each_lane_and_road_permission(geo_net_path):
    net = sumolib.net.readNet(str(geo_net_path))
    roads, _, _ = compile_network(net, WorldFrame(net))
    expected = {
        "pedestrian": "ped", "passenger": "car", "bus": "bus",
        "bicycle": "bicycle", "delivery": "delivery", "truck": "truck",
    }
    road = next(road for road in roads if road["id"] == "e_AB")
    edge = net.getEdge("e_AB")
    assert set(road["allow"]) == {label for vclass, label in expected.items() if edge.allows(vclass)}
    for lane, rendered in zip(edge.getLanes(), road["lanes"], strict=True):
        assert set(rendered["allow"]) == {label for vclass, label in expected.items() if lane.allows(vclass)}


def test_pack_pipeline_keeps_all_population_travel_classes():
    value = NETCONVERT_OPTS[NETCONVERT_OPTS.index("--keep-edges.by-vclass") + 1]
    assert {"pedestrian", "passenger", "bus", "bicycle", "delivery", "truck"} <= set(value.split(","))


def test_route_types_and_legacy_sampling_preserve_vehicle_class(tmp_path, geo_net_path):
    types = {node.attrib["vClass"]: node.attrib["id"] for node in ET.fromstring(f"<routes>{VTYPES.format(cap=60)}</routes>")}
    assert {"pedestrian", "passenger", "bus", "bicycle", "delivery", "truck"} <= types.keys()
    route_file = tmp_path / "classes.rou.xml"
    write_routes(route_file, [], [], [])
    tree = ET.parse(route_file)
    root = tree.getroot()
    expected = {"bicycle": "bicycle", "passenger": "car", "delivery": "delivery", "truck": "truck"}
    for i, travel_class in enumerate(expected):
        vehicle = ET.SubElement(root, "vehicle", id=travel_class, type=types[travel_class], depart=str(i * 5))
        ET.SubElement(vehicle, "route", edges="e_AB e_BC")
    tree.write(route_file)
    cfg = tmp_path / "classes.sumocfg"
    write_sumocfg(cfg, geo_net_path, route_file, [], 500, 1, tmp_path / "tripinfo.xml")
    record = SumoRunner(geo_net_path).run(cfg, 500, [], {}, [], [], label="population-classification")
    assert set(record.tracks) == set(expected)
    for entity_id, kind in expected.items():
        assert record.tracks[entity_id].kind == kind
        assert record.tracks[entity_id].vehicle_class == entity_id
        assert record.tracks[entity_id].resident_id is None
    assert not record.events
