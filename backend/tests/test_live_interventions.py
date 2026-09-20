import math

import pytest

from cityshift.live.contracts import (
    BusRouteChange,
    PopulationChange,
    RoadChange,
    SessionConfig,
    TemperatureChange,
)
from cityshift.live.engine import LiveEngine
from cityshift.live.recording import HEADER, ROW, frame_spans


@pytest.fixture
def city(live_pack, tmp_path):
    engine = LiveEngine(live_pack, SessionConfig(pack_id=live_pack.pack_id, initial_population=0, car_share=0, horizon_s=1200), tmp_path)
    yield engine
    engine.close()


def population(count=12, window=0):
    return PopulationChange(kind="population", count=count, destination_zone_id="Z_EAST", origin_zone_id="Z_WEST", release_window_s=window)


def test_road_closure_preserves_sidewalks_and_restores_original_permissions(city):
    before = {lane: city.connection.lane.getDisallowed(lane) for lane in ("e_BC_0", "e_BC_1")}
    city.apply(RoadChange(kind="close_road", edge_ids=["e_BC"]), "close")
    assert "passenger" in city.connection.lane.getDisallowed("e_BC_1")
    assert "pedestrian" not in city.connection.lane.getDisallowed("e_BC_0")
    city.apply(RoadChange(kind="reopen_road", edge_ids=["e_BC"]), "open")
    assert {lane: city.connection.lane.getDisallowed(lane) for lane in before} == before


def test_overlapping_closures_do_not_reopen_each_other_early(city):
    city.apply(RoadChange(kind="close_road", edge_ids=["e_BC"], until_s=3), "short")
    city.apply(RoadChange(kind="close_road", edge_ids=["e_BC"], until_s=5), "long")
    city.advance_to(4)
    assert "passenger" in city.connection.lane.getDisallowed("e_BC_1")
    city.advance_to(6)
    assert "passenger" not in city.connection.lane.getDisallowed("e_BC_1")


def test_invalid_road_list_does_not_partially_close_the_city(city):
    before = city.connection.lane.getDisallowed("e_BC_1")
    with pytest.raises(ValueError):
        city.apply(RoadChange(kind="close_road", edge_ids=["e_BC", "missing"]), "bad")
    assert city.connection.lane.getDisallowed("e_BC_1") == before


def test_added_route_uses_one_real_finite_capacity_bus(city):
    city.apply(BusRouteChange(kind="add_bus_route", bus_id="bus_A", stop_ids=["S1", "S2"]), "route-a")
    city.advance_to(5)
    assert city.connection.vehicle.getIDList() == ("bus_A",)
    assert city.connection.vehicle.getPersonCapacity("bus_A") == 60
    assert city.connection.vehicle.getRoute("bus_A")
    assert len([e for e in city.entities if e["kind"] == "bus"]) == 1
    with pytest.raises(ValueError):
        city.apply(BusRouteChange(kind="add_bus_route", bus_id="bus_A", stop_ids=["S1", "S3"]), "reuse")
    with pytest.raises(ValueError):
        city.apply(BusRouteChange(kind="add_bus_route", bus_id="bus_Z", stop_ids=["S1", "S3"]), "unlimited")


def test_added_demand_creates_individual_sumo_trips_and_measured_frames(city):
    city.apply(population(), "inbound")
    assert city.counts()["total"] == 12
    assert len({e["id"] for e in city.entities}) == 12
    assert all(e["destination_zone_id"] == "Z_EAST" for e in city.entities)
    city.advance_to(20)
    assert len(city.connection.person.getIDList()) == 12
    assert city.counts()["walking"] > 0
    data = city.recording.read_chunk(20)
    _, a, _ = next(frame_spans(data))
    count = HEADER.unpack_from(data, a)[2]
    assert count == 12
    assert all(math.isfinite(ROW.unpack_from(data, a + HEADER.size + i * ROW.size)[1]) for i in range(count))


def test_cold_changes_real_walking_speed_but_not_road_speed(city):
    city.apply(population(2), "walkers")
    city.advance_to(5)
    pid = city.connection.person.getIDList()[0]
    old_speed = city.connection.person.getMaxSpeed(pid)
    road_speed = city.connection.lane.getMaxSpeed("e_BC_1")
    city.apply(TemperatureChange(kind="temperature", temperature_c=0), "cold")
    city.advance_to(8)
    assert city.connection.person.getMaxSpeed(pid) < old_speed
    assert city.connection.lane.getMaxSpeed("e_BC_1") == road_speed
    assert sum(v for k, v in city.counts().items() if k != "total") == 2


def test_new_bus_route_changes_actual_boarding_and_arrivals(city):
    city.apply(BusRouteChange(kind="add_bus_route", bus_id="bus_A", stop_ids=["S1", "S2"]), "shuttle")
    city.apply(population(70, 20), "riders")
    city.advance_to(900)
    stats = city.metrics()
    assert stats["boardings"] > 0
    assert stats["max_occupancy"]["bus_A"] <= 60
    assert city.counts()["arrived"] > 0
    assert city.counts()["total"] == 70
    assert sum(v for k, v in city.counts().items() if k != "total") == 70


def test_population_limits_and_unknown_destinations_do_not_erase_existing_people(city):
    city.apply(population(3), "first")
    before = [e["id"] for e in city.entities]
    with pytest.raises(ValueError):
        city.apply(PopulationChange(kind="population", count=2, destination_zone_id="missing"), "bad-place")
    with pytest.raises(ValueError):
        city.apply(population(10000), "over-budget")
    assert city.counts()["total"] == 3
    assert [e["id"] for e in city.entities] == before


def test_5000_new_journeys_are_individually_identified_not_a_visual_multiplier(city):
    city.apply(population(5000, 300), "downtown-5000")
    assert city.counts()["total"] == 5000
    assert city.counts()["not_departed"] == 5000
    assert len(city.entities) == len({e["id"] for e in city.entities}) == 5000
    assert all(e["origin_edge"] == "e_AB" and e["destination_edge"] == "e_CD" for e in city.entities)
    city.advance_to(3)
    assert len(city.connection.person.getIDList()) > 0
    assert sum(v for k, v in city.counts().items() if k != "total") == 5000


def test_closure_reroutes_an_existing_car_without_changing_its_identity(live_pack, tmp_path):
    engine = LiveEngine(live_pack, SessionConfig(pack_id=live_pack.pack_id, initial_population=0, car_share=1), tmp_path)
    try:
        engine.apply(population(1), "driver")
        engine.advance_to(2)
        vid = engine.connection.vehicle.getIDList()[0]
        before = engine.connection.vehicle.getRoute(vid)
        assert "e_BC" in before
        engine.apply(RoadChange(kind="close_road", edge_ids=["e_BC"]), "detour")
        after = engine.connection.vehicle.getRoute(vid)
        current = engine.connection.vehicle.getRouteIndex(vid)
        assert "e_BC" not in after[current + 1:]
        assert engine.metrics()["rerouted"] > 0
        engine.advance_to(4)
        assert engine.connection.vehicle.getIDList() == (vid,)
    finally:
        engine.close()


def test_route_added_after_departure_serves_existing_waiting_people(city):
    city.apply(TemperatureChange(kind="temperature", temperature_c=-20), "cold-first")
    city.apply(population(30), "existing-demand")
    city.advance_to(30)
    assert city.counts()["waiting"] > 0
    city.apply(BusRouteChange(kind="add_bus_route", bus_id="bus_A", stop_ids=["S1", "S2"]), "new-service")
    city.advance_to(900)
    assert city.metrics()["boardings"] > 0
    assert city.counts()["arrived"] > 0
    assert city.counts()["total"] == 30
