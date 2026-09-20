import time

import pytest

from cityshift.live.contracts import InterventionRequest, SessionConfig


def wait_until(session, t):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        state = session.snapshot()
        if state["status"] == "failed":
            pytest.fail(state["error"])
        if state["time_s"] >= t:
            return state
        time.sleep(0.02)
    pytest.fail(f"session did not reach {t}: {session.snapshot()}")


def test_worker_only_advances_to_requested_time_and_closes_its_process(live_pack, tmp_path):
    from cityshift.live.sessions import LiveRegistry

    registry = LiveRegistry(tmp_path, pack_loader=lambda _: live_pack)
    try:
        session = registry.create(SessionConfig(pack_id=live_pack.pack_id, initial_population=0))
        session.wait_ready()
        assert session.snapshot()["status"] == "paused"
        session.advance(4)
        assert wait_until(session, 4)["available_until_s"] == 4
        paused = session.pause()
        assert paused["time_s"] == 4
        assert session.snapshot()["status"] == "paused"
        assert session.snapshot()["counts"]["total"] == 0
    finally:
        registry.close()
    assert not session.thread.is_alive()
    assert session.snapshot()["status"] == "closed"


def test_commands_are_idempotent_and_revision_checked(live_pack, tmp_path):
    from cityshift.live.sessions import LiveRegistry

    registry = LiveRegistry(tmp_path, pack_loader=lambda _: live_pack)
    try:
        session = registry.create(SessionConfig(pack_id=live_pack.pack_id, initial_population=0))
        session.wait_ready()
        request = InterventionRequest(command_id="cold-1", at_s=0, expected_revision=0, intervention={"kind": "temperature", "temperature_c": 0})
        result = registry.apply(session.session_id, request)
        assert result.session_id == session.session_id
        assert result.snapshot()["temperature_c"] == 0
        assert result.snapshot()["revision"] == 1
        registry.apply(session.session_id, request)
        assert len(session.snapshot()["commands"]) == 1
        with pytest.raises(ValueError, match="revision"):
            registry.apply(session.session_id, request.model_copy(update={"command_id": "stale", "expected_revision": 99}))
        assert len(session.snapshot()["commands"]) == 1
    finally:
        registry.close()


def test_past_edit_forks_without_overwriting_original_recorded_history(live_pack, tmp_path):
    from cityshift.live.recording import frame_spans
    from cityshift.live.sessions import LiveRegistry

    registry = LiveRegistry(tmp_path, pack_loader=lambda _: live_pack)
    try:
        parent = registry.create(SessionConfig(pack_id=live_pack.pack_id, initial_population=0))
        parent.wait_ready()
        parent.advance(12)
        wait_until(parent, 12)
        original = parent.recording.read_chunk(0)
        child = registry.apply(parent.session_id, InterventionRequest(command_id="past-cold", at_s=6, expected_revision=0, intervention={"kind": "temperature", "temperature_c": 0}))
        child.wait_ready()
        assert child.session_id != parent.session_id
        assert child.snapshot()["parent_session_id"] == parent.session_id
        assert child.snapshot()["fork_s"] == 6
        assert child.snapshot()["temperature_c"] == 0
        child.advance(8)
        wait_until(child, 8)
        prefix = b"".join(original[a:b] for t, a, b in frame_spans(original) if t <= 6)
        assert child.recording.read_chunk(0).startswith(prefix)
        assert parent.recording.read_chunk(0) == original
        assert parent.snapshot()["temperature_c"] == 20
        assert parent.snapshot()["time_s"] == 12
    finally:
        registry.close()


def test_live_registry_rejects_unknown_ids_and_uncomputed_edits(live_pack, tmp_path):
    from cityshift.live.sessions import LiveRegistry

    registry = LiveRegistry(tmp_path, pack_loader=lambda _: live_pack)
    try:
        with pytest.raises(KeyError):
            registry.get("../not-a-session")
        session = registry.create(SessionConfig(pack_id=live_pack.pack_id, initial_population=0))
        session.wait_ready()
        with pytest.raises(ValueError, match="simulated"):
            registry.apply(session.session_id, InterventionRequest(command_id="future", at_s=42, expected_revision=0, intervention={"kind": "temperature", "temperature_c": 0}))
        assert not session.snapshot()["commands"]
    finally:
        registry.close()
