import pytest

from cityshift.contracts import DevelopmentSpec, DevelopmentWave
from cityshift.live.contracts import (
    DevelopmentChange,
    InterventionRequest,
    RemoveDevelopmentChange,
    SessionConfig,
)
from cityshift.live.developments import trip_counts
from cityshift.live.preview import preview


def townhouses(live_pack, **over) -> DevelopmentSpec:
    zones = {z.zone_id: z.share for z in live_pack.zones}
    total = sum(zones.values())
    base: dict = {
        "name": "Townhouses", "land_use": "residential", "position": live_pack.venue_lonlat, "footprint_m": (48, 14), "height_m": 10,
        "capacity": 12, "people_per_unit": 2.5, "trip_rate": 0.6, "car_share": 0.5, "walk_limit_m": 1500,
        "zone_shares": {zid: share / total for zid, share in zones.items()}, "first_wave": DevelopmentWave(start_s=5, end_s=60, profile="uniform"),
    }
    return DevelopmentSpec(**(base | over))


def test_trip_counts_follow_the_declared_assumptions(live_pack):
    spec = townhouses(live_pack)
    assert trip_counts(spec) == {"added_trips": 18, "outbound_trips": 18, "inbound_trips": 0}
    park = townhouses(live_pack, name="Park", land_use="park", capacity=300, people_per_unit=1, trip_rate=1)
    assert trip_counts(park) == {"added_trips": 300, "outbound_trips": 0, "inbound_trips": 300}


def test_a_placed_development_adds_exactly_its_trips_and_demolition_drops_the_pending_ones(live_pack, tmp_path):
    from cityshift.live.engine import LiveEngine

    engine = LiveEngine(live_pack, SessionConfig(pack_id=live_pack.pack_id, initial_population=0, horizon_s=600), tmp_path)
    try:
        spec = townhouses(live_pack)
        result = engine.apply(DevelopmentChange(kind="development", spec=spec), "cmd-place")
        assert result["added_trips"] == 18
        assert engine.counts()["total"] == 18
        standing = engine.snapshot_developments()
        assert len(standing) == 1 and standing[0]["spec"]["name"] == "Townhouses"
        assert {a["mode"] for a in standing[0]["access"]} == {"passenger", "pedestrian"}
        # residents leave from the building's street towards the declared zones
        gates = {a["edge_id"] for a in standing[0]["access"]}
        assert all(e["origin_edge"] in gates and e["development_id"] == standing[0]["development_id"] for e in engine.entities)
        with pytest.raises(ValueError):
            engine.apply(DevelopmentChange(kind="development", spec=spec), "cmd-place")

        engine.advance_to(20)  # some residents have set off, the rest are still at home
        departed = sum(1 for t in engine.population.trips.values() if t.state != 0)
        removal = engine.apply(RemoveDevelopmentChange(kind="remove_development", development_id=standing[0]["development_id"]), "cmd-demolish")
        assert removal["dropped_travelers"] + removal["travelling"] == 18
        assert removal["travelling"] >= departed
        assert engine.counts()["total"] == removal["travelling"]
        assert engine.snapshot_developments() == []
        engine.advance_to(30)  # dropped travelers never appear
        assert engine.counts()["total"] == removal["travelling"]
    finally:
        engine.close()


def test_preview_refuses_a_building_far_from_any_street(live_pack):
    import sumolib

    net = sumolib.net.readNet(live_pack.net_file)
    config = SessionConfig(pack_id=live_pack.pack_id, initial_population=0)
    state = {"revision": 0, "available_until_s": 0, "time_s": 0, "commands": [], "developments": []}
    good = InterventionRequest(command_id="c1", at_s=0, expected_revision=0, intervention=DevelopmentChange(kind="development", spec=townhouses(live_pack)))
    out = preview(live_pack, config, state, good, net)
    assert out["added_trips"] == 18 and out["outbound_trips"] == 18 and len(out["access"]) == 2
    west, _south, _east, north = live_pack.bbox
    far = townhouses(live_pack, position=(west + 1e-4, north - 1e-4))
    bad = InterventionRequest(command_id="c2", at_s=0, expected_revision=0, intervention=DevelopmentChange(kind="development", spec=far))
    with pytest.raises(ValueError, match="access"):
        preview(live_pack, config, state, bad, net)
    gone = InterventionRequest(command_id="c3", at_s=0, expected_revision=0, intervention=RemoveDevelopmentChange(kind="remove_development", development_id="development-missing"))
    with pytest.raises(ValueError, match="no such development"):
        preview(live_pack, config, state, gone, net)
