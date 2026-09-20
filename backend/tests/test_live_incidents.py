import pytest

from cityshift.live.contracts import IncidentChange, PopulationChange, SessionConfig
from cityshift.live.engine import LiveEngine
from cityshift.live.recording import HEADER, ROW, frame_spans
from cityshift.live.swarm import FLAG_AWARE_MASK, FLAG_IN_ZONE, FLAG_RESPONDED


def incident(engine, hazard, edge="e_BC", radius=60, duration=None, along=0.5):
    shape = engine.net.getEdge(edge).getShape()
    (x0, y0), (x1, y1) = shape[0], shape[-1]
    lon, lat = engine.net.convertXY2LonLat(x0 + (x1 - x0) * along, y0 + (y1 - y0) * along)
    return IncidentChange(kind="incident", hazard=hazard, lon=lon, lat=lat, radius_m=radius, duration_s=duration)


def demand(count, window):
    return PopulationChange(kind="population", count=count, destination_zone_id="Z_EAST", origin_zone_id="Z_WEST", release_window_s=window)


def flags_at(engine, t):
    data = engine.recording.read_chunk(t - t % 10)
    for frame_t, a, _ in frame_spans(data):
        if frame_t == t:
            count = HEADER.unpack_from(data, a)[2]
            return [ROW.unpack_from(data, a + HEADER.size + i * ROW.size)[7] for i in range(count)]
    raise AssertionError("frame not recorded")


@pytest.fixture
def drivers(live_pack, tmp_path):
    engine = LiveEngine(live_pack, SessionConfig(pack_id=live_pack.pack_id, initial_population=0, car_share=1, horizon_s=1200), tmp_path)
    yield engine
    engine.close()


@pytest.fixture
def walkers(live_pack, tmp_path):
    engine = LiveEngine(live_pack, SessionConfig(pack_id=live_pack.pack_id, initial_population=0, car_share=0, horizon_s=1200), tmp_path)
    yield engine
    engine.close()


def test_incident_without_streets_is_refused_before_touching_the_city(drivers):
    far = IncidentChange(kind="incident", hazard="crash", lon=-79.30, lat=43.70, radius_m=20)
    with pytest.raises(ValueError, match="footprint"):
        drivers.apply(far, "nowhere")
    assert not drivers.swarm.events
    assert not drivers.network.closures


def test_a_crash_is_learned_by_proximity_and_only_informed_drivers_detour(drivers):
    drivers.apply(demand(40, 120), "commuters")
    drivers.advance_to(60)
    drivers.apply(incident(drivers, "crash", radius=80, duration=300), "crash-1")
    assert "passenger" in drivers.connection.lane.getDisallowed("e_BC_1")
    assert "pedestrian" not in drivers.connection.lane.getDisallowed("e_BC_0")
    assert drivers.network.rerouted == 0, "an unannounced crash must not reroute every driver in the city"
    drivers.advance_to(200)
    swarm = drivers.metrics()["swarm"]
    assert swarm["witnessed"] > 0
    assert swarm["messages"] > swarm["witnessed"], "drivers must pass the news to neighbours, not only witness it"
    assert swarm["responded"] > 0
    routes = {vid: drivers.connection.vehicle.getRoute(vid) for vid in drivers.connection.vehicle.getIDList()}
    assert any("e_BE" in route for route in routes.values()), "informed drivers take the detour through E"
    aware = [f for t in range(61, 201, 10) for f in flags_at(drivers, t) if f & FLAG_AWARE_MASK]
    assert aware and any(f & FLAG_RESPONDED for f in aware)
    assert drivers.snapshot_incidents()[0]["hazard"] == "crash"
    drivers.advance_to(362)
    assert "passenger" not in drivers.connection.lane.getDisallowed("e_BC_1")
    assert not drivers.swarm.active_events(drivers.time_s)
    assert drivers.counts()["total"] == 40


def test_a_fire_evacuates_people_inside_and_the_news_spreads_down_the_sidewalk(walkers):
    walkers.apply(demand(40, 150), "pedestrians")
    walkers.advance_to(170)
    walkers.apply(incident(walkers, "fire", edge="e_AB", radius=40, duration=400, along=0.75), "fire-1")
    assert walkers.network.blocked_walk >= {"e_AB", "e_BA"}
    assert "pedestrian" not in walkers.connection.lane.getDisallowed("e_AB_0"), "sidewalks are avoided by informed people, not fenced off in SUMO"
    walkers.advance_to(230)
    swarm = walkers.metrics()["swarm"]
    assert swarm["witnessed"] > 0
    assert any(int(hop) >= 1 for hop in swarm["by_hop"]), "people further down the sidewalk learn second-hand"
    assert swarm["responded"] > 0
    plans = [trip.plan for trip in walkers.population.trips.values()]
    assert any(plan.startswith("flee:") for plan in plans), "people inside the footprint leave it"
    flags = flags_at(walkers, 230)
    assert any(f & FLAG_IN_ZONE for f in flags) or all(not (f & FLAG_IN_ZONE) for f in flags)
    assert any(f & FLAG_RESPONDED for f in flags)
    assert walkers.counts()["total"] == 40 and walkers.counts()["unroutable"] == 0
    walkers.advance_to(600)
    assert not walkers.network.blocked_walk
    walkers.advance_to(640)
    assert not any(trip.plan.startswith("flee:") for trip in walkers.population.trips.values() if trip.state in (1, 2)), "after the fire people resume their journeys"


def test_incident_messages_use_openjiuwen_envelope_fields(drivers):
    drivers.apply(demand(6, 0), "few")
    drivers.advance_to(30)
    drivers.apply(incident(drivers, "crash", edge="e_AB", radius=200, duration=120), "crash-2")
    message = drivers.swarm.log[0]
    assert set(message.__dataclass_fields__) == {"message_id", "message", "sender", "recipient", "topic_id", "session_id", "metadata"}
    assert message.topic_id == "incident/ev-1" and message.metadata["hop"] == 0
    assert message.message["blocks"] == ["passenger", "bus"]
