from __future__ import annotations

import threading

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_population_bridge import observation
from test_population_world import definition

from cityshift.agents.population_bridge import ScopedCityBridge
from cityshift.api.population_router import router
from cityshift.api.population_service import PopulationService, get_population_service
from cityshift.api.service import PopulationScenarioError, Service
from cityshift.contracts import ConstraintSet, DemandSet, RunStatus, ScenarioSpec, SimulationRun
from cityshift.store import Store


@pytest.fixture
def api_world(tmp_path):
    owner = Service(Store(tmp_path))
    service = PopulationService(owner)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_population_service] = lambda: service
    with TestClient(app) as client:
        yield client, service
    owner.pool.shutdown(wait=True)
    owner.agent_pool.shutdown(wait=True)


def test_http_bridge_rejects_controller_impersonation_and_forged_resident(api_world):
    client, service = api_world
    bridge = ScopedCityBridge("population-test")
    bridge.begin_epoch(1, [observation("r1"), observation("r2")])
    service.register_bridge("population-test", bridge)
    path = "/api/population/bridge/population-test"
    assert client.post(path + "/bind", json={"resident_id": "r1", "worker_id": "w1"}).status_code == 401
    assert client.post(path + "/bind", headers={"Authorization": "Bearer fake"},
                       json={"resident_id": "r1", "worker_id": "w1"}).status_code == 403
    response = client.post(path + "/bind", headers={"Authorization": f"Bearer {service._control_token}"},
                           json={"resident_id": "r1", "worker_id": "w1"})
    token = response.json()["capability"]
    headers = {"Authorization": f"Bearer {token}"}
    request = {"worker_id": "w1", "epoch": 1, "name": "observe_local_state", "arguments": {}}
    assert client.post(path + "/tool", headers=headers, json=request).json()["resident_id"] == "r1"
    assert client.post(path + "/tool", headers=headers, json=request | {"arguments": {"resident_id": "r2"}}).status_code == 403
    assert client.post(path + "/tool", headers=headers, json=request | {"worker_id": "w2"}).status_code == 403
    assert client.post(path + "/tool", headers=headers, json=request | {"epoch": 0}).status_code == 403
    bridge.end_epoch(1)
    assert client.post(path + "/tool", headers=headers, json=request).status_code == 403
    assert token not in str(bridge.audit())
    assert "private-r1" not in str(bridge.audit())
    service.release_bridge("population-test")


def test_pause_is_only_requested_until_checkpoint_is_committed(api_world):
    client, service = api_world
    population = definition()
    service.owner.store.put_population(population)
    run = SimulationRun(run_id="society-test", scenario_id=population.population_id, population_id=population.population_id,
                        run_kind="population", plan_id="service-ledger-v1", seed=7, status=RunStatus.running)
    service.owner.store.put_run(run)
    service.pause_flags[run.run_id] = threading.Event()
    response = client.post(f"/api/population/runs/{run.run_id}/pause", json={})
    assert response.status_code == 202
    assert response.json() == {"run_id": run.run_id, "requested": True}
    assert service.pause_flags[run.run_id].is_set()
    assert service.owner.run(run.run_id).status == RunStatus.running
    run.status = RunStatus.failed
    service.owner.store.put_run(run)
    response = client.post(f"/api/population/runs/{run.run_id}/resume", json={})
    assert response.status_code == 409
    assert "checkpoint" in response.json()["detail"]


def test_population_runs_are_not_filtered_out_as_stale_transport_plans(api_world):
    _, service = api_world
    scenario = ScenarioSpec(scenario_id="population-view", pack_id="fixture", demand_id="empty",
                            scenario_kind="population", population_id="population-view",
                            constraints=ConstraintSet(fleet=[], horizon_s=600, service_window_s=(0, 600),
                                                      allowed_stop_ids=[], hard_max_fleet=0))
    service.owner.store.put_scenario(scenario, DemandSet(demand_id="empty", seed=1, travelers=[]))
    run = SimulationRun(run_id="society-recorded", scenario_id=scenario.scenario_id,
                        population_id=scenario.population_id, run_kind="population", plan_id="service-ledger-v1",
                        seed=7, status=RunStatus.completed)
    service.owner.store.put_run(run)
    service.owner.store.put_run(run.model_copy(update={"run_id": "society-wrong", "population_id": "another-population"}))
    assert service.owner.current_runs(scenario.scenario_id) == [run]


@pytest.mark.parametrize("method, argument", [
    ("preview_development", None), ("apply_development", None),
    ("remove_development", "development-id"), ("demolish_building", "building-id"),
])
def test_new_transport_development_operations_reject_population_scenarios(api_world, method, argument):
    _, service = api_world
    scenario = ScenarioSpec(scenario_id="population-locked", pack_id="fixture", demand_id="empty",
                            scenario_kind="population", population_id="population-locked",
                            constraints=ConstraintSet(fleet=[], horizon_s=600, service_window_s=(0, 600),
                                                      allowed_stop_ids=[], hard_max_fleet=0))
    service.owner.store.put_scenario(scenario, DemandSet(demand_id="empty", seed=1, travelers=[]))
    with pytest.raises(PopulationScenarioError):
        getattr(service.owner, method)(scenario.scenario_id, argument)
    assert service.owner.scenario(scenario.scenario_id) == scenario


def test_population_cannot_trigger_legacy_analysts_or_interventions(api_world):
    _, service = api_world
    scenario = ScenarioSpec(scenario_id="population-view", pack_id="fixture", demand_id="empty",
                            scenario_kind="population", population_id="population-view",
                            constraints=ConstraintSet(fleet=[], horizon_s=600, service_window_s=(0, 600),
                                                      allowed_stop_ids=[], hard_max_fleet=0))
    service.owner.store.put_scenario(scenario, DemandSet(demand_id="empty", seed=1, travelers=[]))
    with pytest.raises(PopulationScenarioError):
        service.owner.investigate(scenario.scenario_id, "solve something", "one budget")
    with pytest.raises(PopulationScenarioError):
        service.owner.preview_edit(scenario.scenario_id, "create a disaster")
    with pytest.raises(PopulationScenarioError):
        service.owner.submit_run(scenario.scenario_id, "baseline", 1)


def test_brain_family_cannot_mislabel_a_reviewed_model(api_world):
    client, _ = api_world
    spec = definition().spec.model_dump(mode="json")
    spec["brains"] = [{"model_id": "openai/gpt-4.1-mini", "model_family": "claude", "api_provider": "openrouter",
                       "config_ref": "wrong", "control_mode": "jiuwenswarm"}]
    response = client.post("/api/population/scenarios", json=spec)
    assert response.status_code == 422
    assert "family/provider" in response.json()["detail"]
