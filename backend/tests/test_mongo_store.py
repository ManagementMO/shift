from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import Mock

import mongomock
import pytest
from fastapi.testclient import TestClient
from pymongo.errors import ConfigurationError, ServerSelectionTimeoutError

from cityshift import store as stores
from cityshift.contracts import (
    ConstraintSet,
    DemandSet,
    EvidenceBundle,
    Investigation,
    RunStatus,
    ScenarioSpec,
    ServicePlan,
    SimulationRun,
    ValidationReport,
)


@pytest.fixture
def mongo():
    return stores.MongoStore(mongomock.MongoClient(tz_aware=True).cityshift_test)


def scenario(sid="s", label="base"):
    return ScenarioSpec(
        scenario_id=sid, pack_id="p", demand_id="d", label=label,
        constraints=ConstraintSet(fleet=[], horizon_s=600, service_window_s=(0, 600), allowed_stop_ids=[]),
    )


def demand(seed=1):
    return DemandSet(demand_id="d", seed=seed, travelers=[])


def plan(pid="baseline"):
    return ServicePlan(plan_id=pid, name="Baseline", family="none", duties=[])


def report(pid="baseline"):
    return ValidationReport(plan_id=pid, valid=True)


def run(rid="r", sid="s", status=RunStatus.queued):
    return SimulationRun(run_id=rid, scenario_id=sid, plan_id="baseline", seed=1, status=status)


def test_default_service_requires_mongodb_without_silent_json_fallback(monkeypatch):
    from cityshift.api.service import Service

    monkeypatch.delenv("MONGODB_URI", raising=False)
    svc = None
    try:
        with pytest.raises(RuntimeError, match="MONGODB_URI"):
            svc = Service()
    finally:
        if svc is not None:
            svc.pool.shutdown()
            svc.agent_pool.shutdown()


def test_scenario_and_demand_are_stored_atomically_and_immutable(mongo):
    s, d = scenario(), demand()
    mongo.put_scenario(s, d)
    assert mongo.get_scenario("s") == s
    assert mongo.get_demand("s") == d
    assert mongo.database.scenarios.count_documents({}) == 1
    assert mongo.database.scenarios.find_one({"_id": "s"})["demand"] == d.model_dump(mode="json")
    with pytest.raises(ValueError, match="immutable"):
        mongo.put_scenario(scenario(label="replacement"), demand(2))
    assert mongo.get_scenario("s").label == "base"
    assert mongo.get_demand("s").seed == 1
    assert mongo.get_scenario("missing") is None
    assert mongo.get_demand("missing") is None


def test_scenario_write_rejects_mismatched_cohort_identity(mongo):
    d = demand()
    d.demand_id = "different"
    with pytest.raises(ValueError, match="demand"):
        mongo.put_scenario(scenario(), d)
    assert mongo.list_scenarios() == []


def test_concurrent_scenario_writes_cannot_mix_parent_spec_and_cohort(mongo):
    def write(seed):
        try:
            mongo.put_scenario(scenario(label=str(seed)), demand(seed))
            return True
        except ValueError:
            return False
    with ThreadPoolExecutor(max_workers=6) as pool:
        written = list(pool.map(write, range(6)))
    assert sum(written) == 1
    assert mongo.get_scenario("s").label == str(mongo.get_demand("s").seed)
    assert mongo.database.scenarios.count_documents({}) == 1


def test_child_lineage_and_created_time_survive_a_new_store_instance(mongo):
    parent = scenario()
    child = parent.model_copy(deep=True, update={"scenario_id": "child", "parent_scenario_id": "s", "created_at": parent.created_at + timedelta(seconds=1)})
    mongo.put_scenario(child, demand())
    mongo.put_scenario(parent, demand())
    reloaded = stores.MongoStore(mongo.database)
    assert reloaded.list_scenarios() == [parent, child]
    assert reloaded.get_scenario("s").parent_scenario_id is None
    assert reloaded.get_scenario("child").parent_scenario_id == "s"
    assert reloaded.get_scenario("child").created_at.tzinfo is not None


def test_plan_and_validation_are_atomic_scoped_and_immutable(mongo):
    a, b = plan("b"), plan("a")
    mongo.put_plan("s", a, report("b"))
    mongo.put_plan("s", b, report("a"))
    mongo.put_plan("other", a, report("b"))
    assert mongo.list_plans("s") == [b, a]
    assert mongo.get_plan("s", "b") == a
    assert mongo.get_validation("s", "b") == report("b")
    assert mongo.get_plan("missing", "b") is None
    assert mongo.get_validation("s", "missing") is None
    mongo.put_plan("s", a, report("b"))
    with pytest.raises(ValueError, match="immutable"):
        mongo.put_plan("s", a.model_copy(update={"name": "Changed"}), report("b"))
    assert mongo.get_plan("s", "b").name == "Baseline"


def test_composite_plan_ids_do_not_collide(mongo):
    mongo.put_plan("a__b", plan("c"), report("c"))
    mongo.put_plan("a", plan("b__c"), report("b__c"))
    assert len(mongo.list_plans("a__b")) == len(mongo.list_plans("a")) == 1
    assert mongo.get_plan("a__b", "c").plan_id == "c"
    assert mongo.get_plan("a", "b__c").plan_id == "b__c"


def test_plan_validation_id_must_match(mongo):
    with pytest.raises(ValueError, match="validation"):
        mongo.put_plan("s", plan(), report("different"))
    assert mongo.list_plans("s") == []


def test_run_lifecycle_updates_are_persisted_but_completed_results_are_immutable(mongo):
    r = run()
    mongo.put_run(r)
    r.status = RunStatus.running
    r.progress = 0.4
    mongo.put_run(r)
    assert mongo.get_run("r").progress == 0.4
    r.status = RunStatus.completed
    r.progress = 1
    mongo.put_run(r)
    mongo.put_run(r)
    with pytest.raises(ValueError, match="immutable"):
        mongo.put_run(r.model_copy(update={"status": RunStatus.running, "progress": 0}))
    assert mongo.get_run("r") == r
    other = run("other", "another")
    other.created_at = r.created_at + timedelta(seconds=1)
    mongo.put_run(other)
    assert mongo.list_runs("s") == [r]
    assert mongo.list_runs() == [r, other]


def test_failed_runs_can_be_retried_under_the_same_identity(mongo):
    r = run(status=RunStatus.failed)
    mongo.put_run(r)
    r.status = RunStatus.queued
    mongo.put_run(r)
    assert mongo.get_run("r").status == RunStatus.queued


def test_frozen_evidence_keeps_first_write_and_investigations_can_progress(mongo):
    bundle = EvidenceBundle(bundle_id="e", corpus_snapshot="fixture", source_ids=["a"], claims=[]).freeze()
    mongo.put_bundle(bundle)
    changed = bundle.model_copy(deep=True, update={"source_ids": ["b"]})
    mongo.put_bundle(changed)
    assert mongo.get_bundle("e") == bundle
    assert mongo.get_bundle("missing") is None
    inv = Investigation(investigation_id="i", scenario_id="s", problem_text="p", constraint_text="c")
    mongo.put_investigation(inv)
    inv.status = "completed"
    mongo.put_investigation(inv)
    mongo.put_investigation(inv.model_copy(update={"investigation_id": "other", "scenario_id": "another"}))
    assert mongo.get_investigation("i").status == "completed"
    assert mongo.list_investigations("s") == [inv]
    assert len(mongo.list_investigations()) == 2


def test_indexes_are_created_without_dropping_existing_data(mongo):
    mongo.put_scenario(scenario(), demand())
    assert any(info["key"] == [("data.scenario_id", 1), ("data.created_at", 1)] for info in mongo.database.runs.index_information().values())
    assert any(info["key"] == [("_id.scenario_id", 1), ("_id.plan_id", 1)] for info in mongo.database.plans.index_information().values())
    assert mongo.database.scenarios.count_documents({}) == 1


@pytest.mark.parametrize("uri", ["", "mongodb+srv://user:<db_password>@cluster.example.invalid/", "https://example.invalid"])
def test_missing_placeholder_or_wrong_scheme_is_rejected_before_connection(monkeypatch, uri):
    monkeypatch.setenv("MONGODB_URI", uri)
    client = Mock()
    monkeypatch.setattr(stores, "MongoClient", client)
    with pytest.raises(RuntimeError, match="MONGODB_URI"):
        stores.MongoStore.from_env()
    client.assert_not_called()


def test_config_uses_backend_environment_and_never_falls_back_to_localhost(monkeypatch):
    uri = "mongodb+srv://example:fake-password@cluster.example.invalid/?appName=Cluster0"
    monkeypatch.setenv("MONGODB_URI", uri)
    monkeypatch.setenv("MONGODB_DATABASE", "cityshift_test")
    client = mongomock.MongoClient()
    factory = Mock(return_value=client)
    monkeypatch.setattr(stores, "MongoClient", factory)
    store = stores.MongoStore.from_env()
    assert store.database.name == "cityshift_test"
    assert factory.call_args.args == (uri,)
    assert factory.call_args.kwargs["serverSelectionTimeoutMS"] == 5000
    assert factory.call_args.kwargs["connectTimeoutMS"] == 5000
    assert factory.call_args.kwargs["tz_aware"] is True
    assert client.cityshift_test.list_collection_names() == []


def test_invalid_connection_errors_do_not_echo_credentials(monkeypatch):
    uri = "mongodb+srv://example:fake-password@cluster.example.invalid/"
    monkeypatch.setenv("MONGODB_URI", uri)
    monkeypatch.setattr(stores, "MongoClient", Mock(side_effect=ConfigurationError(f"bad URI: {uri}")))
    with pytest.raises(RuntimeError) as exc:
        stores.MongoStore.from_env()
    assert "fake-password" not in str(exc.value)
    assert uri not in str(exc.value)


def test_api_database_outage_is_a_sanitized_503(monkeypatch):
    from cityshift.api import app as api

    fake_service = Mock()
    fake_service.store.list_scenarios.side_effect = ServerSelectionTimeoutError("private diagnostic fake-password")
    monkeypatch.setattr(api, "get_service", lambda: fake_service)
    with TestClient(api.app) as client:
        response = client.get("/api/scenarios")
    assert response.status_code == 503
    assert "MongoDB" in response.text
    assert "fake-password" not in response.text


def test_api_missing_database_configuration_has_a_clear_503(monkeypatch):
    from cityshift.api import app as api
    from cityshift.api import service

    monkeypatch.delenv("MONGODB_URI", raising=False)
    monkeypatch.setattr(service, "_service", None)
    with TestClient(api.app) as client:
        response = client.get("/api/scenarios")
    assert response.status_code == 503
    assert "MONGODB_URI" in response.text


def test_health_reports_read_only_mongodb_connectivity_without_creating_collections(mongo, monkeypatch):
    from cityshift import providers
    from cityshift.api import app as api

    monkeypatch.setattr(api, "get_service", lambda: Mock(store=mongo))
    monkeypatch.setattr(api, "sumo_version", lambda: "test")
    monkeypatch.setattr(providers, "provider_status", dict)
    with TestClient(api.app) as client:
        response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert response.json()["storage"] == {"backend": "mongodb", "configured": True, "available": True, "database": "cityshift_test"}
    assert mongo.database.list_collection_names() == []


def test_health_reports_missing_configuration_without_claiming_readiness(monkeypatch):
    from cityshift import providers
    from cityshift.api import app as api
    from cityshift.api import service

    monkeypatch.delenv("MONGODB_URI", raising=False)
    monkeypatch.setattr(service, "_service", None)
    monkeypatch.setattr(api, "sumo_version", lambda: "test")
    monkeypatch.setattr(providers, "provider_status", dict)
    with TestClient(api.app) as client:
        response = client.get("/api/health")
    assert response.json()["ok"] is False
    assert response.json()["storage"]["configured"] is False
    assert response.json()["storage"]["available"] is False
    assert "MONGODB_URI" in response.json()["storage"]["message"]


def test_health_does_not_expose_driver_diagnostics(monkeypatch):
    from cityshift import providers
    from cityshift.api import app as api

    svc = Mock()
    svc.store.ping.side_effect = ServerSelectionTimeoutError("private diagnostic fake-password")
    monkeypatch.setattr(api, "get_service", lambda: svc)
    monkeypatch.setattr(api, "sumo_version", lambda: "test")
    monkeypatch.setattr(providers, "provider_status", dict)
    with TestClient(api.app) as client:
        response = client.get("/api/health")
    assert response.json()["ok"] is False
    assert response.json()["storage"]["configured"] is True
    assert "fake-password" not in response.text


def test_primary_mongodb_client_is_shared_and_closed_on_shutdown(mongo, monkeypatch):
    from cityshift.api import service

    factory = Mock(return_value=mongo)
    close = Mock()
    monkeypatch.setattr(stores.MongoStore, "from_env", factory)
    monkeypatch.setattr(mongo, "close", close)
    monkeypatch.setattr(service, "_service", None)
    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            services = list(pool.map(lambda _: service.get_service(), range(4)))
        assert all(svc is services[0] for svc in services)
        assert services[0].store is mongo
        factory.assert_called_once()
    finally:
        service.close_service()
    close.assert_called_once()
    assert service._service is None


@pytest.mark.parametrize("name", ["", "admin", "config", "local"])
def test_application_database_name_cannot_target_internal_databases(monkeypatch, name):
    monkeypatch.setenv("MONGODB_URI", "mongodb://example.invalid")
    monkeypatch.setenv("MONGODB_DATABASE", name)
    factory = Mock()
    monkeypatch.setattr(stores, "MongoClient", factory)
    with pytest.raises(stores.StorageConfigurationError, match="MONGODB_DATABASE"):
        stores.MongoStore.from_env()
    factory.assert_not_called()
