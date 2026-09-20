import pytest

from cityshift.live.contracts import SessionConfig


def test_live_engine_advances_an_empty_city_without_inventing_agents(live_pack, tmp_path):
    from cityshift.live.engine import LiveEngine

    engine = LiveEngine(live_pack, SessionConfig(pack_id=live_pack.pack_id, initial_population=0), tmp_path)
    try:
        assert engine.time_s == 0
        assert engine.counts()["total"] == 0
        engine.advance_to(4)
        assert engine.time_s == engine.connection.simulation.getTime() == 4
        assert engine.recording.latest_s == 4
        assert engine.process.poll() is None
    finally:
        engine.close()
    assert engine.process.poll() is not None
    engine.close()


def test_engine_rejects_rewinding_or_advancing_past_the_horizon(live_pack, tmp_path):
    from cityshift.live.engine import LiveEngine

    engine = LiveEngine(live_pack, SessionConfig(pack_id=live_pack.pack_id, initial_population=0, horizon_s=300), tmp_path)
    try:
        engine.advance_to(3)
        with pytest.raises(ValueError):
            engine.advance_to(2)
        with pytest.raises(ValueError):
            engine.advance_to(301)
        assert engine.time_s == 3
    finally:
        engine.close()


def test_separate_live_connections_do_not_replace_each_other(live_pack, tmp_path):
    from cityshift.live.engine import LiveEngine

    config = SessionConfig(pack_id=live_pack.pack_id, initial_population=0)
    a = LiveEngine(live_pack, config, tmp_path / "a")
    b = LiveEngine(live_pack, config, tmp_path / "b")
    try:
        a.advance_to(3)
        b.advance_to(7)
        assert a.connection.simulation.getTime() == 3
        assert b.connection.simulation.getTime() == 7
        assert a.process.pid != b.process.pid
    finally:
        a.close()
        b.close()
