from cityshift.live.contracts import PopulationChange, RoadChange, SessionConfig
from cityshift.live.engine import LiveEngine


def test_no_detour_is_reported_without_dropping_or_teleporting_the_driver(live_pack, tmp_path):
    engine = LiveEngine(live_pack, SessionConfig(pack_id=live_pack.pack_id, initial_population=0, car_share=1), tmp_path)
    try:
        engine.apply(PopulationChange(kind="population", count=1, origin_zone_id="Z_WEST", destination_zone_id="Z_EAST", release_window_s=0), "trapped-driver")
        engine.advance_to(2)
        vid = engine.connection.vehicle.getIDList()[0]
        engine.apply(RoadChange(kind="close_road", edge_ids=["e_BC", "e_BE", "e_BA"]), "no-detour")
        assert engine.metrics()["warnings"]
        engine.advance_to(100)
        assert vid in engine.connection.vehicle.getIDList()
        assert engine.counts()["total"] == 1
        assert engine.counts()["driving"] == 1
    finally:
        engine.close()
