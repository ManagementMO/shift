from __future__ import annotations

import pytest
from pydantic import ValidationError

from cityshift.agents.population_bridge import BridgeError, ScopedCityBridge
from cityshift.contracts import ActionIntent


def observation(resident_id: str, epoch: int = 1) -> dict:
    return {
        "run_id": "population-test",
        "resident_id": resident_id,
        "epoch": epoch,
        "world_version": epoch,
        "t": epoch * 10,
        "profile": {"resident_id": resident_id},
        "state": {"activity": "idle"},
        "memories": [{"text": f"private-{resident_id}"}],
        "tasks": [],
        "contacts": ["r2"] if resident_id == "r1" else ["r1"],
        "messages": [],
        "trip_options": [],
    }


def test_actor_capability_is_bound_outside_model_arguments():
    bridge = ScopedCityBridge("population-test")
    bridge.begin_epoch(1, [observation("r1"), observation("r2")])
    one = bridge.bind_worker("r1", "worker-one")
    two = bridge.bind_worker("r2", "worker-two")
    assert bridge.call(one, "worker-one", 1, "recall_experience", {}) == [{"text": "private-r1"}]
    assert bridge.call(two, "worker-two", 1, "recall_experience", {}) == [{"text": "private-r2"}]
    with pytest.raises(BridgeError, match="arguments"):
        bridge.call(one, "worker-one", 1, "observe_local_state", {"resident_id": "r2"})
    with pytest.raises(BridgeError, match="capability"):
        bridge.call(one, "worker-two", 1, "observe_local_state", {})
    with pytest.raises(BridgeError, match="capability"):
        ScopedCityBridge("other-run").call(one, "worker-one", 1, "observe_local_state", {})


def test_observations_are_immutable_and_old_epochs_are_rejected():
    bridge = ScopedCityBridge("population-test")
    original = observation("r1")
    bridge.begin_epoch(1, [original])
    cap = bridge.bind_worker("r1", "worker-one")
    original["memories"].append({"text": "future"})
    received = bridge.call(cap, "worker-one", 1, "observe_local_state", {})
    received["state"]["activity"] = "tamper"
    assert bridge.call(cap, "worker-one", 1, "observe_local_state", {})["state"]["activity"] == "idle"
    assert not {"tasks", "memories", "trip_options"}.intersection(received)
    assert bridge.call(cap, "worker-one", 1, "view_tasks", {}) == []
    assert len(bridge.call(cap, "worker-one", 1, "recall_experience", {})) == 1
    bridge.end_epoch(1)
    with pytest.raises(BridgeError, match="epoch"):
        bridge.call(cap, "worker-one", 1, "observe_local_state", {})
    bridge.begin_epoch(2, [observation("r1", 2)])
    with pytest.raises(BridgeError, match="epoch"):
        bridge.call(cap, "worker-one", 1, "observe_local_state", {})


def test_proposals_are_staged_not_committed_and_retries_are_idempotent():
    bridge = ScopedCityBridge("population-test")
    bridge.begin_epoch(1, [observation("r1")])
    cap = bridge.bind_worker("r1", "worker-one")
    action = {"action": "wait", "duration_s": 30, "idempotency_key": "turn-one"}
    first = bridge.call(cap, "worker-one", 1, "propose_action", action)
    second = bridge.call(cap, "worker-one", 1, "propose_action", action)
    assert first == second
    assert first["status"] == "proposed"
    assert bridge.call(cap, "worker-one", 1, "observe_local_state", {})["state"]["activity"] == "idle"
    proposals = bridge.end_epoch(1)
    assert len(proposals) == 1
    assert proposals[0].resident_id == "r1"
    assert proposals[0].run_id == "population-test"
    assert proposals[0].world_version == 1
    assert proposals[0].effective_t == 10


def test_changed_duplicate_proposal_and_unknown_tools_fail_closed():
    bridge = ScopedCityBridge("population-test")
    bridge.begin_epoch(1, [observation("r1")])
    cap = bridge.bind_worker("r1", "worker-one")
    bridge.call(cap, "worker-one", 1, "propose_action", {
        "action": "wait", "duration_s": 30, "idempotency_key": "same",
    })
    with pytest.raises(BridgeError, match="idempotency"):
        bridge.call(cap, "worker-one", 1, "propose_action", {
            "action": "wait", "duration_s": 60, "idempotency_key": "same",
        })
    for name in ("advance_time", "shell", "read_file", "complete_delivery", "rewrite_workflow"):
        with pytest.raises(BridgeError, match="tool"):
            bridge.call(cap, "worker-one", 1, name, {})


def test_controller_cannot_rebind_another_worker_or_overlap_epochs():
    bridge = ScopedCityBridge("population-test")
    bridge.begin_epoch(1, [observation("r1"), observation("r2")])
    bridge.bind_worker("r1", "worker-one")
    with pytest.raises(BridgeError, match="worker"):
        bridge.bind_worker("r2", "worker-one")
    with pytest.raises(BridgeError, match="epoch"):
        bridge.begin_epoch(2, [observation("r1", 2)])


def test_action_schema_rejects_forged_fields_and_invalid_time():
    base = {
        "run_id": "population-test", "resident_id": "r1", "epoch": 1,
        "world_version": 1, "effective_t": 10, "expires_t": 10,
        "action": "wait", "duration_s": 30, "idempotency_key": "one",
    }
    assert ActionIntent.model_validate(base).resident_id == "r1"
    with pytest.raises(ValidationError):
        ActionIntent.model_validate(base | {"world_rules": "anything goes"})
    with pytest.raises(ValidationError):
        ActionIntent.model_validate(base | {"expires_t": 9})
    with pytest.raises(ValidationError):
        ActionIntent.model_validate(base | {"duration_s": -1})


def test_capabilities_are_revoked_at_cleanup():
    bridge = ScopedCityBridge("population-test")
    bridge.begin_epoch(1, [observation("r1")])
    cap = bridge.bind_worker("r1", "worker-one")
    bridge.close()
    with pytest.raises(BridgeError, match="closed|capability"):
        bridge.call(cap, "worker-one", 1, "observe_local_state", {})
