from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from test_population_run import network_population

from cityshift.contracts import (
    ActionProposal,
    BrainAssignment,
    ResidentDecision,
    RunStatus,
    SimulationRun,
    SwarmBinding,
)
from cityshift.domain import population_runs
from cityshift.domain.population_checkpoints import load_checkpoint


@pytest.mark.parametrize("mode", ["zero", "missing", "attempts_only", "later_zero", "reported_failure", "mixed", "checkpoint_failure"])
def test_native_unproductive_batch_pauses_at_paired_boundary_without_advancing_sumo(tmp_path, monkeypatch, mode):
    pack, population = network_population(tmp_path, horizon=60)
    brain = BrainAssignment(model_id="anthropic/claude-haiku-4.5", model_family="claude",
                            api_provider="openrouter", config_ref="guard-test")
    population.spec.brains = [brain]
    population.assignments = dict.fromkeys(population.assignments, brain)
    population.spec.budget.max_concurrency = 2
    run = SimulationRun(run_id=population_runs.population_run_id(population, mode), scenario_id=population.population_id,
                        population_id=population.population_id, run_kind="population", plan_id="service-ledger-v1", seed=7)
    totals = {"calls": 0, "reported_tokens": 0, "reported_cost_microdollars": 0,
              "accounted_microdollars": 0, "uncertain_requests": 0}
    gateway = SimpleNamespace(preflight=AsyncMock(return_value={}),
                              usage=lambda _: {"remaining_microdollars": 20_000_000, "blocked": False, "run_totals": totals},
                              register_run=lambda *a, **k: SimpleNamespace(token="local-guard-test-token"),
                              unregister_run=lambda _: None)
    bridges, capabilities, batches, sealed, persisted = {}, {}, [], [], []

    class BoundaryDouble:
        """Synthetic decisions and usage only; never calls an inference service."""

        def __init__(self, *args):
            self.health = {"native_available": True, "evidence": "local boundary double, not model verification"}

        def start(self, resume=None):
            pass

        def decide(self, packets):
            batches.append(packets)
            ids = [packet["resident_id"] for packet in packets]
            results, bindings = dict.fromkeys(ids), {}
            failures = dict.fromkeys(ids, "local pre-dispatch request rejection")
            usage = {} if mode == "missing" else {
                rid: {"model_calls": 3 if mode == "attempts_only" else 0,
                      "reported_model_calls": 1 if mode == "reported_failure" else 0} for rid in ids
            }
            if mode == "mixed" or (mode == "later_zero" and len(batches) == 1):
                packet = packets[0]
                rid = packet["resident_id"]
                worker = f"local-worker-{rid}"
                bridge = bridges[run.run_id]
                if rid not in capabilities:
                    capabilities[rid] = bridge.bind_worker(rid, worker)
                proposal = ActionProposal(action="wait", duration_s=60, idempotency_key=f"test-{packet['epoch']}-{rid}")
                bridge.call(capabilities[rid], worker, packet["epoch"], "propose_action", proposal.model_dump())
                results[rid] = ResidentDecision(proposal=proposal, summary="Synthetic boundary decision for regression test.")
                bindings[rid] = SwarmBinding(resident_id=rid, run_id=run.run_id, team_id="local-team",
                                            workflow_id="local-workflow", session_id=f"local-session-{rid}", worker_id=worker,
                                            requested_model_id=brain.model_id, resolved_model_id=brain.model_id)
                failures.pop(rid)
            return results, bindings, failures, usage

        def align_boundary(self, **boundary):
            sealed.append(boundary)

        def checkpoint(self, boundary):
            if mode == "checkpoint_failure":
                raise RuntimeError("synthetic checkpoint failure")
            return boundary | {"run_id": run.run_id, "checkpoint_id": "local-native-checkpoint"}

        def close(self):
            pass

    monkeypatch.setattr(population_runs, "get_population_gateway", lambda: gateway)
    monkeypatch.setattr(population_runs, "NativePopulationClient", BoundaryDouble)
    result = population_runs.execute_population_run(
        run, pack, population, lambda value: persisted.append(value.model_copy(deep=True)),
        lambda key, value: bridges.__setitem__(key, value), lambda key: bridges.pop(key),
        "local-guard-test-control", run_root=tmp_path / "runs",
    )
    directory = Path(result.run_dir)
    snapshot = json.loads((directory / "snapshot.json").read_text())
    records = snapshot["population"]["decisions"]
    assert not bridges
    assert totals == {"calls": 0, "reported_tokens": 0, "reported_cost_microdollars": 0,
                      "accounted_microdollars": 0, "uncertain_requests": 0}
    if mode in {"reported_failure", "mixed"}:
        assert result.status == RunStatus.completed, result.error
        assert not sealed and not result.checkpoint_available
        assert snapshot["population"]["metrics"]["end_time_s"] == 60
        assert any(row["source"] == "fallback" for row in records)
        if mode == "mixed":
            assert any(row["source"] == "jiuwenswarm" for row in records)
        return
    stopped_t = 1 if mode == "later_zero" else 0
    assert len(batches) == (2 if mode == "later_zero" else 1)
    assert snapshot["population"]["metrics"]["end_time_s"] == stopped_t
    assert len(records) == 2 * len(batches)
    assert all(row["source"] == "fallback" and row["t"] == stopped_t for row in records[-2:])
    assert all(row["fallback_reason"] == "local pre-dispatch request rejection" for row in records[-2:])
    assert result.progress == stopped_t / 60
    assert persisted[-1].status == result.status
    if mode == "checkpoint_failure":
        assert result.status == RunStatus.failed
        assert not result.checkpoint_available
        assert not (directory / "checkpoint.json").exists()
        return
    assert result.status == RunStatus.paused and result.checkpoint_available
    assert "no reported provider model calls" in result.error
    assert "before advancing city time" in result.error
    assert snapshot["run"]["status"] == "paused"
    saved = load_checkpoint(directory, run.run_id, population)
    assert saved["world"]["t"] == saved["mobility"]["t"] == saved["manifest"]["native"]["t"] == stopped_t
    assert len(saved["world"]["decisions"]) == len(records)
    assert saved["sumo_path"].is_file()
