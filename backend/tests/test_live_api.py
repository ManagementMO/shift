import time

import pytest
from fastapi.testclient import TestClient

from cityshift.live.contracts import SessionConfig
from cityshift.live.recording import frame_spans
from cityshift.live.sessions import LiveRegistry


@pytest.fixture
def client(live_pack, tmp_path, monkeypatch):
    from cityshift.api import live_router
    from cityshift.api.app import app

    registry = LiveRegistry(tmp_path, pack_loader=lambda _: live_pack)
    monkeypatch.setattr(live_router, "_registry", registry)
    with TestClient(app) as connection:
        yield connection, registry
    registry.close()


def ready(client, sid, t=0):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        response = client.get(f"/api/live/{sid}")
        assert response.status_code == 200
        state = response.json()
        assert state["status"] != "failed", state
        if state["status"] not in ("starting", "restoring") and state["available_until_s"] >= t:
            return state
        time.sleep(0.02)
    pytest.fail("live API did not produce the requested recorded time")


def test_api_starts_advances_and_serves_only_recorded_frames(client, live_pack):
    connection, _ = client
    created = connection.post("/api/live", json={"pack_id": live_pack.pack_id, "initial_population": 0})
    assert created.status_code == 201
    sid = created.json()["session_id"]
    ready(connection, sid)
    assert connection.post(f"/api/live/{sid}/advance", json={"target_s": 4}).status_code == 200
    state = ready(connection, sid, 4)
    assert state["metrics"]["boardings"] == 0
    frames = connection.get(f"/api/live/{sid}/frames/0")
    assert frames.status_code == 200
    assert frames.headers["content-type"] == "application/octet-stream"
    assert [t for t, _, _ in frame_spans(frames.content)] == [0, 1, 2, 3, 4]
    assert connection.get(f"/api/live/{sid}/frames/10").status_code == 404
    assert connection.post(f"/api/live/{sid}/pause").json()["status"] == "paused"


def test_preview_is_nonmutating_and_apply_changes_real_session_state(client, live_pack):
    connection, registry = client
    session = registry.create(SessionConfig(pack_id=live_pack.pack_id, initial_population=0))
    session.wait_ready()
    sid = session.session_id
    request = {"command_id": "weather-1", "at_s": 0, "expected_revision": 0, "intervention": {"kind": "temperature", "temperature_c": 0}}
    preview = connection.post(f"/api/live/{sid}/preview", json=request)
    assert preview.status_code == 200
    assert "assumption" in preview.json()
    assert session.snapshot()["temperature_c"] == 20
    assert not session.snapshot()["commands"]
    applied = connection.post(f"/api/live/{sid}/commands", json=request)
    assert applied.status_code == 200
    assert applied.json()["temperature_c"] == 0
    assert applied.json()["revision"] == 1
    assert connection.post(f"/api/live/{sid}/commands", json=request).json()["revision"] == 1
    stale = {**request, "command_id": "stale"}
    assert connection.post(f"/api/live/{sid}/commands", json=stale).status_code == 409


def test_api_rejects_invalid_places_and_exposes_metadata_for_each_traveler(client, live_pack):
    connection, registry = client
    session = registry.create(SessionConfig(pack_id=live_pack.pack_id, initial_population=0))
    session.wait_ready()
    sid = session.session_id
    request = {"command_id": "inbound-1", "at_s": 0, "expected_revision": 0, "intervention": {"kind": "population", "count": 12, "destination_zone_id": "missing"}}
    assert connection.post(f"/api/live/{sid}/preview", json=request).status_code == 422
    request["intervention"].update(destination_zone_id="Z_EAST", origin_zone_id="Z_WEST", release_window_s=10)
    assert connection.post(f"/api/live/{sid}/commands", json=request).status_code == 200
    metadata = connection.get(f"/api/live/{sid}/metadata").json()
    assert len(metadata["entities"]) == 12
    assert len(metadata["fleet"]) == 2
    assert metadata["routes"] == []
    assert connection.get("/api/live/not-a-session").status_code == 404


def test_resume_continues_an_archived_record_without_overwriting_it(client, live_pack):
    connection, registry = client
    original = registry.create(SessionConfig(pack_id=live_pack.pack_id, initial_population=0))
    original.wait_ready()
    original.advance(3)
    ready(connection, original.session_id, 3)
    original.close()
    before = original.recording.read_chunk(0)
    response = connection.post(f"/api/live/{original.session_id}/resume")
    assert response.status_code == 200
    sid = response.json()["session_id"]
    assert sid != original.session_id
    ready(connection, sid, 3)
    assert connection.post(f"/api/live/{sid}/advance", json={"target_s": 6}).status_code == 200
    ready(connection, sid, 6)
    assert original.recording.read_chunk(0) == before
    assert connection.get(f"/api/live/{sid}/frames/0").content.startswith(before)
