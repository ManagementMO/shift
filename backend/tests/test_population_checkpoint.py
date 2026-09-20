from __future__ import annotations

import json
from copy import deepcopy

import pytest
from test_population_run import network_population
from test_population_world import FixtureMobility, decision, delivery_in_transit, turn, world_at_work

from cityshift.contracts import PopulationArtifact, RunStatus, SimulationRun, SwarmBinding
from cityshift.domain.population_checkpoints import load_checkpoint
from cityshift.domain.population_runs import execute_population_run, population_run_id
from cityshift.domain.society import SocietyWorld


def test_world_checkpoint_restores_pending_services_messages_and_private_history():
    world = world_at_work()
    task = next(t for t in world.tasks.values() if t.kind == "delivery")
    worker = next(p.resident_id for p in world.profiles.values() if "shop_worker" in p.roles)
    turn(world, worker, "accept", target_id=task.task_id)
    sender = next(r for r, state in world.states.items() if state.role == "customer")
    target = world.profiles[sender].contacts[0]
    turn(world, sender, "message", target_id=target, text="A private update before the boundary.")
    assert world.messages[0].delivered_s is None
    boundary = world.align_epoch()
    saved = json.loads(json.dumps(world.checkpoint_state()))
    restored = SocietyWorld.from_checkpoint(world.run_id, world.definition, FixtureMobility(), saved)
    assert restored.checkpoint_state() == saved
    assert (restored.t, restored.epoch, restored.version) == (boundary["t"], boundary["epoch"], boundary["world_version"])
    for t in (1, 9, 10):
        world.advance(t)
        restored.advance(t)
        assert restored.checkpoint_state() == world.checkpoint_state()
    assert restored.tasks[task.task_id].status == "ready"
    assert restored.messages[0].delivered_s == 1
    assert "private update" in str(restored.observation(target)["messages"])
    outsider = next(r for r in world.states if r not in {sender, target})
    assert "private update" not in str(restored.observation(outsider))


def test_checkpoint_requires_a_finished_epoch_and_rejects_forged_or_future_state():
    world = world_at_work()
    rid = next(iter(world.states))
    world.begin_epoch([rid])
    with pytest.raises(ValueError, match="epoch"):
        world.checkpoint_state()
    with pytest.raises(ValueError, match="epoch"):
        world.align_epoch()
    world.commit_decisions({rid: decision("wait", "before-checkpoint")}, source="rules")
    data = world.checkpoint_state()
    for key, value in (("run_id", "other-run"), ("population_id", "another-population"),
                       ("definition_hash", "wrong"), ("t", world.definition.spec.horizon_s + 1)):
        with pytest.raises(ValueError, match="mismatch"):
            SocietyWorld.from_checkpoint(world.run_id, world.definition, FixtureMobility(), data | {key: value})
    future = json.loads(json.dumps(data))
    future["states"][rid]["memories"][0]["t"] = world.t + 1
    with pytest.raises(ValueError, match="future"):
        SocietyWorld.from_checkpoint(world.run_id, world.definition, FixtureMobility(), future)


def test_swarm_binding_history_keeps_generation_time_without_duplicates():
    world = world_at_work()
    rid = next(iter(world.states))
    binding = SwarmBinding(resident_id=rid, run_id=world.run_id, team_id="team", workflow_id="workflow",
                           session_id="session", worker_id="worker", requested_model_id="baseline-v1",
                           resolved_model_id="baseline-v1")
    world.record_swarm_binding(binding)
    world.advance(10)
    world.record_swarm_binding(binding.model_copy(update={"bound_s": 10}))
    assert len(world.swarm_bindings) == 1
    world.record_swarm_binding(binding.model_copy(update={"generation": 1, "restored": True}))
    assert [b.bound_s for b in world.swarm_bindings] == [0, 10]
    restored = SocietyWorld.from_checkpoint(world.run_id, world.definition, FixtureMobility(), world.checkpoint_state())
    assert restored.swarm_bindings == world.swarm_bindings


def test_checkpoint_rejects_future_memories_inside_an_earlier_replay_snapshot():
    world = world_at_work()
    world.advance(10)
    data = world.checkpoint_state()
    data["state_history"][0]["state"]["memories"][0]["t"] = 1
    with pytest.raises(ValueError, match="future"):
        SocietyWorld.from_checkpoint(world.run_id, world.definition, FixtureMobility(), data)


@pytest.mark.parametrize("corruption", ["state", "task", "missing_resident", "missing_task"])
def test_checkpoint_rejects_replay_history_that_disagrees_with_current_state(corruption):
    world = world_at_work()
    data = world.checkpoint_state()
    if corruption == "state":
        data["state_history"][-1]["state"]["plan"] = ["An inconsistent replay history."]
    elif corruption == "task":
        data["task_history"][-1]["task"]["deadline_s"] += 1
    elif corruption == "missing_resident":
        data["state_history"].pop()
    else:
        data["task_history"].pop()
    with pytest.raises(ValueError, match="history"):
        SocietyWorld.from_checkpoint(world.run_id, world.definition, FixtureMobility(), data)


@pytest.mark.parametrize("corruption", ["owner", "duration", "kind", "terminal"])
def test_checkpoint_rejects_inconsistent_pending_service(corruption):
    world = world_at_work()
    task = next(t for t in world.tasks.values() if t.kind == "delivery")
    worker = next(r for r, s in world.states.items() if s.role == "shop_worker")
    assert turn(world, worker, "accept", target_id=task.task_id).accepted
    data = world.checkpoint_state()
    if corruption == "owner":
        other = next(r for r in world.states if r != worker)
        data["pending"][other] = data["pending"].pop(worker)
    elif corruption == "duration":
        data["pending"][worker]["until_s"] += 1
    elif corruption == "kind":
        data["pending"][worker]["kind"] = "deliver"
    else:
        data["tasks"][task.task_id]["status"] = "failed"
        data["tasks"][task.task_id]["failure_reason"] = "inconsistent terminal activity"
        data["task_history"][-1]["task"] = deepcopy(data["tasks"][task.task_id])
    with pytest.raises(ValueError):
        SocietyWorld.from_checkpoint(world.run_id, world.definition, FixtureMobility(), data)


@pytest.mark.parametrize("corruption", ["future_presence", "unknown_presence", "unknown_anchor", "future_task", "unowned_commitment"])
def test_checkpoint_rejects_invalid_resource_or_temporal_references(corruption):
    world = world_at_work()
    data = world.checkpoint_state()
    rid = next(iter(world.states))
    tid = next(iter(world.tasks))
    if corruption == "future_presence":
        data["mobility_bindings"][0]["start_s"] = world.t + 1
    elif corruption == "unknown_presence":
        data["mobility_bindings"][0]["resident_id"] = "unknown"
    elif corruption == "unknown_anchor":
        data["tasks"][tid]["service_anchor_id"] = "undeclared"
        next(h for h in data["task_history"] if h["task"]["task_id"] == tid)["task"] = deepcopy(data["tasks"][tid])
    elif corruption == "future_task":
        data["tasks"][tid]["created_s"] = world.t + 1
        next(h for h in data["task_history"] if h["task"]["task_id"] == tid)["task"] = deepcopy(data["tasks"][tid])
    else:
        data["states"][rid]["commitments"].append(tid)
        next(h for h in data["state_history"] if h["state"]["resident_id"] == rid)["state"] = deepcopy(data["states"][rid])
    with pytest.raises(ValueError):
        SocietyWorld.from_checkpoint(world.run_id, world.definition, FixtureMobility(), data)


def test_declining_pending_preparation_releases_capacity_and_never_resurrects_after_restore():
    world = world_at_work()
    world.anchors["shop"].capacity = 1
    tasks = [t for t in world.tasks.values() if t.kind == "delivery"]
    workers = [r for r, s in world.states.items() if s.role == "shop_worker"]
    task = tasks[0]
    assert turn(world, workers[0], "accept", target_id=task.task_id).accepted
    assert turn(world, task.requester_id, "decline", target_id=task.task_id).accepted
    assert task.status == "declined"
    assert not world._pending
    assert world.states[workers[0]].current_task_id is None
    assert all(task.task_id not in state.commitments for state in world.states.values())
    assert world.states[task.requester_id].needs["delivery"] == 1
    assert turn(world, workers[1], "accept", target_id=tasks[1].task_id).accepted
    saved = world.checkpoint_state()
    restored = SocietyWorld.from_checkpoint(world.run_id, world.definition, FixtureMobility(), saved)
    for candidate in (world, restored):
        candidate.advance(10)
        assert candidate.tasks[task.task_id].status == "declined"
        assert candidate.tasks[task.task_id].ready_s is None
        assert candidate.tasks[tasks[1].task_id].status == "ready"
    assert world.checkpoint_state() == restored.checkpoint_state()


@pytest.mark.parametrize("kind", ["visit", "delivery"])
def test_pending_two_participant_activity_restores_without_shortening_duration(kind):
    world = world_at_work()
    if kind == "delivery":
        task, carrier, trip = delivery_in_transit(world)
        world.advance(30)
        world.mobility_arrived(carrier, trip["entity_id"], trip["destination_id"])
        end = 40
    else:
        task = next(t for t in world.tasks.values() if t.kind == "visit")
        worker = next(r for r, s in world.states.items() if s.role == "service_worker")
        assert turn(world, worker, "accept", target_id=task.task_id).accepted
        assert turn(world, task.requester_id, "visit", target_id=task.task_id).accepted
        trip = world.mobility.started[-1]
        world.advance(5)
        world.mobility_arrived(task.requester_id, trip["entity_id"], trip["destination_id"])
        end = 15
    saved = world.checkpoint_state()
    restored = SocietyWorld.from_checkpoint(world.run_id, world.definition, FixtureMobility(), saved)
    assert restored.checkpoint_state() == saved
    for t in (end - 1, end):
        world.advance(t)
        restored.advance(t)
        assert world.checkpoint_state() == restored.checkpoint_state()
        assert (restored.tasks[task.task_id].completed_s is not None) == (t == end)
    assert not restored._pending
    assert all(state.current_task_id != task.task_id for state in restored.states.values())


def test_completed_empty_wait_schedule_survives_restore_and_contact_wakeup():
    world = world_at_work()
    rid = next(r for r, s in world.states.items() if s.role == "courier")
    assert turn(world, rid, "wait", duration_s=30).accepted
    world.advance(30)
    assert rid not in world.due_residents()
    restored = SocietyWorld.from_checkpoint(world.run_id, world.definition, FixtureMobility(), world.checkpoint_state())
    assert restored.states[rid].next_decision_s == world.states[rid].next_need_s
    for candidate in (world, restored):
        sender = next(p.resident_id for p in candidate.profiles.values() if rid in p.contacts)
        assert turn(candidate, sender, "message", target_id=rid, text="Wake on delivery, not on a poll.").accepted
        candidate.advance(31)
        assert rid in candidate.due_residents()
    assert world.checkpoint_state() == restored.checkpoint_state()


def test_coordinated_world_sumo_pair_resumes_same_attempt_and_rejects_tampering(tmp_path):
    pack, population = network_population(tmp_path, horizon=600)
    rid = population_run_id(population, "checkpoint-attempt")
    run = SimulationRun(run_id=rid, scenario_id=population.population_id, population_id=population.population_id,
                        run_kind="population", plan_id="service-ledger-v1", seed=7)
    run_root = tmp_path / "runs"
    bridges = {}
    ticks = 0

    def pause_at_boundary():
        nonlocal ticks
        ticks += 1
        return ticks > 25

    def execute(*, resume=False, pause=None, cancel=None):
        return execute_population_run(run, pack, population, lambda value: None,
                                      lambda key, value: bridges.__setitem__(key, value), lambda key: bridges.pop(key),
                                      "fixture-control", run_root=run_root, resume=resume, pause=pause, cancel=cancel)

    paused = execute(pause=pause_at_boundary)
    assert paused.status == RunStatus.paused, paused.error
    assert paused.checkpoint_available and paused.checkpoint_id
    assert not bridges
    checkpoint = load_checkpoint(run_root / rid, rid, population)
    before = PopulationArtifact.model_validate_json((run_root / rid / "population.json").read_text())
    assert before.metrics.end_time_s == 25
    native_path = checkpoint["directory"] / "mobility.json"
    original = native_path.read_text()
    native_path.write_text(original + " ")
    with pytest.raises(ValueError, match="hash"):
        load_checkpoint(run_root / rid, rid, population)
    native_path.write_text(original)
    counter = 0

    def stop_after_resume():
        nonlocal counter
        counter += 1
        return counter > 26

    resumed = execute(resume=True, cancel=stop_after_resume)
    assert resumed.status == RunStatus.canceled, resumed.error
    assert not resumed.checkpoint_available
    after = PopulationArtifact.model_validate_json((run_root / rid / "population.json").read_text())
    assert after.run_id == before.run_id
    assert after.attempt_id == before.attempt_id
    assert after.definition == before.definition
    assert after.metrics.end_time_s == 51
    assert after.decisions[:len(before.decisions)] == before.decisions
    assert after.states[:len(before.states)] == before.states
    assert after.events[:len(before.events)] == before.events
    with pytest.raises(ValueError, match="consumed"):
        load_checkpoint(run_root / rid, rid, population)
    assert not bridges
