import mongomock
import pytest
from fastapi.testclient import TestClient
from pymongo.errors import AutoReconnect, ServerSelectionTimeoutError

from cityshift import providers
from cityshift.api import service as service_module
from cityshift.api.app import app
from cityshift.api.service import Service
from cityshift.contracts import DemandSet, RunStatus, SimulationRun, Traveler
from cityshift.domain.runs import run_id_for
from cityshift.mongo_store import MongoStore


@pytest.fixture
def atlas_api(transport_world, monkeypatch):
    pack, scenario, _ = transport_world
    store = MongoStore(mongomock.MongoClient()["cityshift_api_test"])
    service = Service(store=store)
    monkeypatch.setattr(service, "pack", lambda _: pack)
    monkeypatch.setattr(service_module, "_service", service)
    monkeypatch.setattr(providers, "provider_status", dict)
    demand = DemandSet(demand_id=scenario.demand_id, seed=7, travelers=[
        Traveler(person_id="incumbent", origin_edge="e_BC", dest_edge="e_CD", dest_zone="east", depart_s=0, has_car=True),
    ])
    with TestClient(app) as client:
        yield client, service, scenario, demand
    service.close()


def test_api_development_preview_cancel_apply_and_reload(atlas_api, development_spec):
    client, service, parent, demand = atlas_api
    base = f"/api/scenarios/{parent.scenario_id}"
    response = client.post("/api/scenarios", json={"scenario": parent.model_dump(mode="json"), "demand": demand.model_dump(mode="json")})
    assert response.status_code == 200
    response = client.post(f"{base}/developments/preview", json=development_spec.model_dump(mode="json"))
    assert response.status_code == 200, response.text
    proposal = response.json()
    assert len(client.get("/api/scenarios").json()) == 1
    assert client.get(f"{base}/demand").json() == demand.model_dump(mode="json")
    response = client.post(f"{base}/developments/apply", json=proposal)
    assert response.status_code == 200, response.text
    child = response.json()
    assert child["parent_scenario_id"] == parent.scenario_id
    assert child["developments"][0]["spec"] == development_spec.model_dump(mode="json")
    assert client.post(f"{base}/developments/apply", json=proposal).json() == child
    assert len(client.get("/api/scenarios").json()) == 2
    reloaded = Service(store=MongoStore(service.store.database))
    assert reloaded.scenario(child["scenario_id"]).model_dump(mode="json") == child
    assert reloaded.demand(parent.scenario_id) == demand
    assert reloaded.demand(child["scenario_id"]).travelers[:1] == demand.travelers
    assert reloaded.plan(child["scenario_id"], "baseline").plan_id == "baseline"
    reloaded.close()


def test_api_deletes_in_place_and_hides_stale_runs(atlas_api, development_spec):
    client, service, parent, demand = atlas_api
    service.register_scenario(parent, demand)
    base = f"/api/scenarios/{parent.scenario_id}"
    proposal = client.post(f"{base}/developments/preview", json=development_spec.model_dump(mode="json")).json()
    child = client.post(f"{base}/developments/apply", json=proposal).json()
    sid = child["scenario_id"]
    # A run recorded against the pre-edit content is listed as current...
    plan = service.plan(sid, "baseline")
    stale = SimulationRun(run_id=run_id_for(service.scenario(sid), plan, 1, service.demand(sid)), scenario_id=sid, plan_id="baseline", seed=1, status=RunStatus.completed)
    service.store.put_run(stale)
    assert [r["run_id"] for r in client.get("/api/runs", params={"scenario_id": sid}).json()] == [stale.run_id]
    # ...demolishing a base building is visual only, so the run stays current...
    response = client.post(f"{base.replace(parent.scenario_id, sid)}/demolitions", json={"building_id": "w42"})
    assert response.status_code == 200, response.text
    assert response.json()["demolished"] == ["w42"]
    assert [r["run_id"] for r in client.get("/api/runs", params={"scenario_id": sid}).json()] == [stale.run_id]
    # ...but removing the development changes the demand, so the old run is no longer current (yet still fetchable).
    response = client.delete(f"/api/scenarios/{sid}/developments/{child['developments'][0]['development_id']}")
    assert response.status_code == 200, response.text
    updated = response.json()
    assert updated["scenario_id"] == sid and updated["developments"] == [] and updated["demolished"] == ["w42"]
    assert client.get(f"/api/scenarios/{sid}/demand").json()["travelers"] == demand.model_dump(mode="json")["travelers"]
    assert client.get("/api/runs", params={"scenario_id": sid}).json() == []
    assert client.get(f"/api/runs/{stale.run_id}").status_code == 200
    assert client.get("/api/runs").json()[0]["run_id"] == stale.run_id
    assert service.plan(sid, "baseline").plan_id == "baseline"  # plans re-validated, not lost
    assert client.delete(f"/api/scenarios/{sid}/developments/missing").status_code == 404
    reloaded = Service(store=MongoStore(service.store.database))
    assert reloaded.scenario(sid).model_dump(mode="json") == updated
    reloaded.close()


def test_api_revalidates_tampered_preview_without_persisting(atlas_api, development_spec):
    client, service, parent, demand = atlas_api
    service.register_scenario(parent, demand)
    base = f"/api/scenarios/{parent.scenario_id}/developments"
    proposal = client.post(f"{base}/preview", json=development_spec.model_dump(mode="json")).json()
    proposal["development"]["access"][0]["edge_id"] = "fabricated-road"
    response = client.post(f"{base}/apply", json=proposal)
    assert response.status_code == 422
    assert len(service.store.list_scenarios()) == 1


def test_retry_after_database_failure_recovers_missing_plans(atlas_api, monkeypatch):
    client, service, parent, demand = atlas_api
    write_plan = service.store.put_plan
    attempts = 0

    def fail_once(*args):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise AutoReconnect("transient database outage")
        return write_plan(*args)

    monkeypatch.setattr(service.store, "put_plan", fail_once)
    body = {"scenario": parent.model_dump(mode="json"), "demand": demand.model_dump(mode="json")}
    assert client.post("/api/scenarios", json=body).status_code == 503
    assert client.post("/api/scenarios", json=body).status_code == 200
    assert service.store.get_plan(parent.scenario_id, "baseline") is not None


def test_database_outage_is_503_without_connection_details(atlas_api, monkeypatch):
    client, service, _, _ = atlas_api
    secret = "never-return-this-password"

    def unavailable():
        raise ServerSelectionTimeoutError(f"mongodb+srv://user:{secret}@cluster.example.invalid")

    monkeypatch.setattr(service.store, "list_scenarios", unavailable)
    response = client.get("/api/scenarios")
    assert response.status_code == 503
    assert "MongoDB Atlas" in response.json()["detail"]
    assert secret not in response.text and "cluster.example.invalid" not in response.text
    monkeypatch.setattr(service.store, "ping", unavailable)
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["ok"] is False
    assert response.json()["storage"]["available"] is False
    assert secret not in response.text


def test_health_identifies_mongodb_storage(atlas_api):
    client, _, _, _ = atlas_api
    health = client.get("/api/health").json()
    assert health["storage"] == {"backend": "mongodb", "configured": True, "available": True}
    assert health["ok"] is True


def test_missing_atlas_configuration_is_explicit(atlas_api, monkeypatch):
    from cityshift import store as store_module

    client, _, _, _ = atlas_api
    monkeypatch.setattr(service_module, "_service", None)
    monkeypatch.setattr(store_module, "load_dotenv", lambda *args, **kwargs: None)
    monkeypatch.setenv("CITYSHIFT_STORAGE", "mongodb")
    monkeypatch.delenv("MONGODB_URI", raising=False)
    monkeypatch.delenv("MONGODB_DATABASE", raising=False)
    response = client.get("/api/scenarios")
    assert response.status_code == 503
    assert "MONGODB_URI" in response.json()["detail"]
    health = client.get("/api/health").json()
    assert health["storage"]["configured"] is False
    assert health["storage"]["available"] is False
