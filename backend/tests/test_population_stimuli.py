from __future__ import annotations

import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from test_population_run import network_population
from test_population_world import FixtureMobility, decision, definition

from cityshift.agents.population_client import SwarmUnavailable
from cityshift.api.population_router import router
from cityshift.api.population_service import PopulationService, get_population_service
from cityshift.api.service import Service
from cityshift.contracts import BrainAssignment, PopulationStimulus, RunStatus, SimulationRun
from cityshift.domain.population_admission import admission_quotes, admitted_residents
from cityshift.domain.population_runs import _save, execute_population_run, population_run_id
from cityshift.domain.population_stimuli import enqueue_stimuli, read_stimuli
from cityshift.domain.society import SocietyWorld
from cityshift.store import Store


def warning(**changes) -> PopulationStimulus:
    return PopulationStimulus.model_validate({"stimulus_id": "fire-1", "kind": "incident", "hazard": "fire",
        "text": "Smoke has been reported near the shops.", "lon": -79.38, "lat": 43.64,
        "radius_m": 30, "duration_s": 60} | changes)


def test_admission_uses_reviewed_reservation_before_starting_a_job(tmp_path, monkeypatch):
    owner = Service(Store(tmp_path))
    service = PopulationService(owner)
    pop = definition()
    brain = BrainAssignment(model_id="anthropic/claude-haiku-4.5", model_family="claude",
                            api_provider="openrouter", config_ref="claude")
    pop.spec.brains = [brain]
    pop.assignments = dict.fromkeys(pop.assignments, brain)
    pop.spec.budget.max_cost_usd = 0.6
    owner.store.put_population(pop)
    monkeypatch.setattr(owner, "pack", lambda _: SimpleNamespace())
    monkeypatch.setattr(service, "status", lambda: {"available": True, "initial_scale_gate": 20,
                                                   "budget": {"remaining_microdollars": 826000}})
    calls = []
    monkeypatch.setattr(service, "_start_job", lambda *args, **kwargs: calls.append(args))
    try:
        required = admission_quotes([brain.model_id], pop.spec.budget.max_output_tokens)[brain.model_id]
        assert required > 826000
        with pytest.raises(SwarmUnavailable, match="reservation per request"):
            service.submit(pop.population_id, "insufficient-budget")
        assert not calls and not owner.store.list_runs()
        pop.spec.budget.max_cost_usd = 2
        PopulationService.check_admission(pop, {"budget": {"remaining_microdollars": 2_000_000}})
    finally:
        owner.pool.shutdown(wait=True)
        owner.agent_pool.shutdown(wait=True)


@pytest.mark.parametrize("run_cap,session_remaining,spent,expected", [
    (1, 20_000_000, 0, 1), (3.5, 20_000_000, 0, 4),
    (20, 1_000_000, 0, 1), (3.5, 20_000_000, 2_500_000, 1),
    (0.8, 20_000_000, 0, 0),
])
def test_native_batch_reserves_combined_cost_and_preserves_oldest_prefix(run_cap, session_remaining, spent, expected):
    pop = definition()
    brain = BrainAssignment(model_id="anthropic/claude-haiku-4.5", model_family="claude",
                            api_provider="openrouter", config_ref="claude")
    pop.assignments = dict.fromkeys(pop.assignments, brain)
    pop.spec.budget.max_cost_usd = run_cap
    pop.spec.budget.max_concurrency = 4
    due = list(reversed(pop.assignments))
    usage = {"remaining_microdollars": session_remaining, "blocked": False,
             "run_totals": {"calls": 0, "reported_tokens": 0, "accounted_microdollars": spent}}
    assert admitted_residents(pop, due, usage) == due[:expected]
    usage["run_totals"]["calls"] = pop.spec.budget.max_calls - 1
    assert admitted_residents(pop, due, usage) == due[:min(expected, 1)]


def test_batch_does_not_skip_an_unaffordable_older_resident_for_cheaper_newer_work():
    pop = definition()
    cheap = BrainAssignment(model_id="anthropic/claude-haiku-4.5", model_family="claude",
                            api_provider="openrouter", config_ref="claude")
    costly = BrainAssignment(model_id="x-ai/grok-4.3", model_family="grok", api_provider="openrouter", config_ref="grok")
    pop.assignments = dict.fromkeys(pop.assignments, cheap)
    due = list(pop.assignments)
    pop.assignments[due[1]] = costly
    pop.spec.budget.max_cost_usd = 3.5
    usage = {"remaining_microdollars": 20_000_000, "blocked": False,
             "run_totals": {"calls": 0, "reported_tokens": 0, "accounted_microdollars": 0}}
    assert admitted_residents(pop, due, usage) == due[:1]
    assert admitted_residents(pop, due[1:], usage) == []


def test_stimuli_validate_geometry_and_semantics():
    for change in ({"lat": None}, {"radius_m": None}, {"hazard": None}, {"temperature_c": 20},
                   {"duration_s": 0}, {"lon": float("nan")}, {"stimulus_id": "../outside"}):
        with pytest.raises(ValidationError):
            warning(**change)
    PopulationStimulus(stimulus_id="weather", kind="temperature", text="Cold warning", temperature_c=-10)


def test_warning_is_scoped_durable_and_does_not_prescribe_a_response():
    pop = definition()
    pop.initial_states[0].anchor_id = "shop"
    world = SocietyWorld("society-input", pop, FixtureMobility())
    rid = pop.initial_states[0].resident_id
    before_activity = world.states[rid].activity
    assert world.apply_stimuli([warning()])
    assert world.states[rid].activity == before_activity
    assert not world.decisions and not world.messages
    assert world.stimuli[0].resident_ids == [rid]
    assert world.observation(rid)["external_observations"][0]["stimulus"]["hazard"] == "fire"
    assert world.events[-1].status == "observed"
    assert world.events[-1].cause_id == "stimulus:fire-1"
    outsider = pop.initial_states[1].resident_id
    assert not world.observation(outsider)["external_observations"]
    assert not any("Smoke" in m.text for m in world.states[outsider].memories)
    receipt = world.states[rid].memories[-1].event_id
    world.begin_epoch([rid])
    contact = pop.profiles[0].contacts[0]
    response = decision("message", "warning-response", target_id=contact, text="I saw smoke near the shops.",
                        observation_refs=[receipt])
    record = world.commit_decisions({rid: response}, source="rules")[0]
    assert record.accepted and record.proposal.observation_refs == [receipt]
    assert record.source == "rules"  # Unit-test choice is never claimed as native inference.
    world.advance(1)
    assert world.messages[0].delivered_s == 1
    assert "I saw smoke" in world.states[contact].memories[-1].text
    saved = world.checkpoint_state()
    restored = SocietyWorld.from_checkpoint(world.run_id, pop, FixtureMobility(), saved)
    assert not restored.apply_stimuli([warning()])
    assert len(restored.events) == len(world.events)
    restored.advance(60)
    assert not restored.observation(rid)["external_observations"]
    assert any("Smoke" in m.text for m in restored.states[rid].memories)


def test_input_wakes_idle_waiters_but_never_changes_an_active_epoch():
    pop = definition()
    world = SocietyWorld("society-input", pop, FixtureMobility())
    rid = pop.profiles[0].resident_id
    world.begin_epoch([rid])
    with pytest.raises(ValueError, match="active decision"):
        world.apply_stimuli([warning()])
    world.commit_decisions({rid: decision("wait", "waiting", duration_s=120)}, source="rules")
    assert rid not in world.due_residents()
    world.apply_stimuli([PopulationStimulus(stimulus_id="news", kind="announcement", text="Local service news")])
    assert rid in world.due_residents()


def test_journal_is_atomic_idempotent_and_outside_run_checkpoints(tmp_path):
    enqueue_stimuli(tmp_path, "society-input", [warning()])
    enqueue_stimuli(tmp_path, "society-input", [warning()])
    assert read_stimuli(tmp_path, "society-input") == [warning()]
    assert not (tmp_path / "society-input").exists()
    with pytest.raises(ValueError, match="different observation"):
        enqueue_stimuli(tmp_path, "society-input", [warning(text="Changed warning")])
    assert read_stimuli(tmp_path, "society-input") == [warning()]


def test_checkpoint_rejects_forged_stimulus_receipts_and_accepts_missing_legacy_field():
    pop = definition()
    world = SocietyWorld("society-input", pop, FixtureMobility())
    legacy = world.checkpoint_state()
    legacy.pop("stimuli")
    assert not SocietyWorld.from_checkpoint(world.run_id, pop, FixtureMobility(), legacy).stimuli
    world.apply_stimuli([warning()])
    saved = world.checkpoint_state()
    saved["stimuli"][0]["resident_ids"] = ["unknown"]
    with pytest.raises(ValueError, match="observation receipts"):
        SocietyWorld.from_checkpoint(world.run_id, pop, FixtureMobility(), saved)


def test_paused_inputs_and_atomic_snapshot_api(tmp_path, monkeypatch):
    from cityshift.api import population_service

    monkeypatch.setattr(population_service, "RUN_ROOT", tmp_path / "runs")
    owner = Service(Store(tmp_path / "store"))
    service = PopulationService(owner)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_population_service] = lambda: service
    pop = definition()
    owner.store.put_population(pop)
    directory = tmp_path / "runs" / "society-input"
    directory.mkdir(parents=True)
    run = SimulationRun(run_id="society-input", scenario_id=pop.population_id, population_id=pop.population_id,
                        run_kind="population", plan_id="service-ledger-v1", seed=7, status=RunStatus.paused,
                        run_dir=str(directory))
    owner.store.put_run(run)
    try:
        with TestClient(app) as client:
            path = f"/api/population/runs/{run.run_id}"
            assert client.get(path + "/snapshot").status_code == 404
            response = client.post(path + "/stimuli", json=warning().model_dump(mode="json"))
            assert response.status_code == 202 and response.json()["status"] == "queued"
            assert owner.run(run.run_id).status == RunStatus.paused
            assert client.get(path + "/stimuli").json()["queued"] == [warning().model_dump(mode="json")]
            assert client.post(path + "/stimuli", json=warning(text="different").model_dump(mode="json")).status_code == 409
            world = SocietyWorld(run.run_id, pop, FixtureMobility())
            world.apply_stimuli(read_stimuli(tmp_path / "runs", run.run_id))
            world.advance(12)
            _save(world, SimpleNamespace(tracks={}, events=[], teleports=0), run, "attempt", directory, time.monotonic())
            snapshot = client.get(path + "/snapshot").json()
            assert snapshot["run"]["progress"] == 12 / pop.spec.horizon_s
            assert snapshot["population"]["metrics"]["end_time_s"] == 12
            assert snapshot["population"]["stimuli"][0]["stimulus"]["stimulus_id"] == "fire-1"
            assert client.get(path + "/stimuli").json()["queued"] == []
            # An old sidecar changing cannot produce a torn browser snapshot.
            (directory / "population.json").write_text(json.dumps({"unexpected": "newer"}))
            assert client.get(path + "/snapshot").json() == snapshot
            run.status = RunStatus.completed
            owner.store.put_run(run)
            assert client.post(path + "/stimuli", json=warning().model_dump(mode="json")).status_code == 409
    finally:
        owner.pool.shutdown(wait=True)
        owner.agent_pool.shutdown(wait=True)


def test_real_sumo_pause_resume_delivers_queued_input_once(tmp_path):
    pack, population = network_population(tmp_path, horizon=60)
    run = SimulationRun(run_id=population_run_id(population, "input-resume"), scenario_id=population.population_id,
                        population_id=population.population_id, run_kind="population",
                        plan_id="service-ledger-v1", seed=population.spec.seed)
    root = tmp_path / "runs"
    bridges = {}
    persisted = []
    args = (run, pack, population, lambda value: persisted.append(value.model_copy(deep=True)),
            lambda key, value: bridges.__setitem__(key, value), lambda key: bridges.pop(key), "test-control")
    assert execute_population_run(*args, pause=lambda: True, run_root=root).status == RunStatus.paused
    checkpoint = (root / run.run_id / "checkpoint.json").read_bytes()
    value = PopulationStimulus(stimulus_id="paused-input", kind="announcement", text="An evening service is delayed.")
    enqueue_stimuli(root, run.run_id, [value])
    assert (root / run.run_id / "checkpoint.json").read_bytes() == checkpoint
    assert execute_population_run(*args, resume=True, run_root=root).status == RunStatus.completed
    snapshot = json.loads((root / run.run_id / "snapshot.json").read_text())
    rows = snapshot["population"]["stimuli"]
    assert len(rows) == 1 and rows[0]["stimulus"]["stimulus_id"] == "paused-input"
    events = [event for event in snapshot["population"]["events"] if event["kind"] == "external_observation"]
    assert len(events) == 1
    assert snapshot["run"]["status"] == "completed"
    assert snapshot["population"]["metrics"]["end_time_s"] == 60
    assert any(record.status == RunStatus.running and record.progress < 1 for record in persisted)
    assert not bridges


@pytest.mark.parametrize("exhausted,run_cap,batch_limit", [(False, 20, 2), (False, 1, 1), (True, 20, 2)])
def test_native_epoch_batches_and_budget_pause_without_model_calls(tmp_path, monkeypatch, exhausted, run_cap, batch_limit):
    from cityshift.domain import population_runs

    pack, pop = network_population(tmp_path, horizon=60)
    brain = BrainAssignment(model_id="anthropic/claude-haiku-4.5", model_family="claude",
                            api_provider="openrouter", config_ref="claude")
    pop.spec.brains = [brain]
    pop.assignments = dict.fromkeys(pop.assignments, brain)
    pop.spec.budget.max_concurrency = 2
    pop.spec.budget.max_cost_usd = run_cap
    run = SimulationRun(run_id=population_run_id(pop, "batch-proof"), scenario_id=pop.population_id,
                        population_id=pop.population_id, run_kind="population", plan_id="service-ledger-v1", seed=7)
    usage = {"remaining_microdollars": 600_000 if exhausted else 20_000_000, "blocked": False,
             "run_totals": {"calls": 0, "reported_tokens": 0, "reported_cost_microdollars": 0,
                            "accounted_microdollars": 0, "uncertain_requests": 0}}
    gateway = SimpleNamespace(preflight=AsyncMock(return_value={}), usage=lambda _: usage,
                              register_run=lambda *args, **kwargs: SimpleNamespace(token="local-test-token"),
                              unregister_run=lambda _: None)
    batches, checkpoints = [], []

    class NativeBoundaryDouble:
        def __init__(self, *args):
            self.health = {"native_available": True, "evidence": "local boundary double, not a model"}

        def start(self, resume=None):
            # Initial bodies already exist before startup/model work.
            snapshot = json.loads((tmp_path / "runs" / run.run_id / "snapshot.json").read_text())
            assert not snapshot["population"]["decisions"]
            assert snapshot["population"]["mobility_bindings"]

        def decide(self, packets):
            batches.append([row["resident_id"] for row in packets])
            ids = batches[-1]
            return dict.fromkeys(ids), {}, dict.fromkeys(ids, "explicit local test failure"), {}

        def close(self):
            pass

    def checkpoint(directory, attempt, world, *args):
        assert world._decision_ids is None
        checkpoints.append(world.checkpoint_state())
        return {"checkpoint_id": "cp_" + "a" * 32}

    monkeypatch.setattr(population_runs, "get_population_gateway", lambda: gateway)
    monkeypatch.setattr(population_runs, "NativePopulationClient", NativeBoundaryDouble)
    monkeypatch.setattr(population_runs, "save_checkpoint", checkpoint)
    result = execute_population_run(run, pack, pop, lambda _: None, lambda *args: None, lambda _: None,
                                    "local-test-control", run_root=tmp_path / "runs")
    snapshot = json.loads((tmp_path / "runs" / run.run_id / "snapshot.json").read_text())
    if exhausted:
        assert result.status == RunStatus.paused and result.checkpoint_available
        assert "reservation" in result.error
        assert len(checkpoints) == 1 and not batches
        assert snapshot["population"]["metrics"]["end_time_s"] == 0
        assert not snapshot["population"]["decisions"]
    else:
        assert result.status == RunStatus.completed, result.error
        assert all(0 < len(batch) <= batch_limit for batch in batches)
        assert [rid for batch in batches for rid in batch] == sorted(pop.assignments)
        assert all(row["source"] == "fallback" for row in snapshot["population"]["decisions"])
