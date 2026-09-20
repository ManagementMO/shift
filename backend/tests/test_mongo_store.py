from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import mongomock
import pytest
from pymongo.errors import ServerSelectionTimeoutError

from cityshift.contracts import (
    DemandSet,
    EvidenceBundle,
    Investigation,
    RunStatus,
    SimulationRun,
    Traveler,
    ValidationReport,
)
from cityshift.domain.compiler import baseline_plan
from cityshift.domain.developments import apply_development, prepare_development
from cityshift.mongo_store import MongoStore
from cityshift.store import StorageUnavailable, Store, create_store


@pytest.fixture
def mongo_store():
    client = mongomock.MongoClient()
    store = MongoStore(client["cityshift_test"])
    yield store
    store.close()


@pytest.fixture
def scenario_data(transport_world):
    _, scenario, _ = transport_world
    demand = DemandSet(demand_id=scenario.demand_id, seed=7, travelers=[
        Traveler(person_id="incumbent", origin_edge="e_BC", dest_edge="e_CD", dest_zone="east", depart_s=0, has_car=True),
    ])
    return scenario, demand


def test_scenario_and_demand_are_one_atomic_immutable_document(mongo_store, scenario_data):
    scenario, demand = scenario_data
    mongo_store.put_scenario(scenario, demand)
    reloaded = MongoStore(mongo_store.database)
    assert reloaded.get_scenario(scenario.scenario_id) == scenario
    assert reloaded.get_demand(scenario.scenario_id) == demand
    assert reloaded.list_scenarios() == [scenario]
    document = mongo_store.database.scenarios.find_one({"_id": scenario.scenario_id})
    assert document["demand"]["demand_id"] == demand.demand_id
    assert "demand" not in mongo_store.database.list_collection_names()
    with pytest.raises(ValueError, match="immutable"):
        reloaded.put_scenario(scenario.model_copy(update={"label": "overwrite"}), demand)
    assert mongo_store.get_scenario(scenario.scenario_id) == scenario


def test_concurrent_scenario_writers_cannot_overwrite(mongo_store, scenario_data):
    scenario, demand = scenario_data

    def insert(i):
        store = MongoStore(mongo_store.database)
        try:
            store.put_scenario(scenario.model_copy(update={"label": str(i)}), demand)
            return i
        except ValueError:
            return None

    with ThreadPoolExecutor(max_workers=4) as pool:
        winners = [i for i in pool.map(insert, range(8)) if i is not None]
    assert len(winners) == 1
    assert mongo_store.get_scenario(scenario.scenario_id).label == str(winners[0])
    assert mongo_store.database.scenarios.count_documents({}) == 1


@pytest.mark.parametrize("invalid", ["identity", "duplicate_traveler"])
def test_invalid_demand_does_not_partially_persist(mongo_store, scenario_data, invalid):
    scenario, demand = scenario_data
    if invalid == "identity":
        demand.demand_id = "wrong"
    else:
        demand.travelers.append(demand.travelers[0].model_copy())
    with pytest.raises(ValueError):
        mongo_store.put_scenario(scenario, demand)
    assert mongo_store.get_scenario(scenario.scenario_id) is None
    assert mongo_store.get_demand(scenario.scenario_id) is None


def test_document_size_limit_is_explicit_and_atomic(mongo_store, scenario_data, monkeypatch):
    from cityshift import mongo_store as module

    scenario, demand = scenario_data
    monkeypatch.setattr(module, "MAX_DOCUMENT_BYTES", 2048)
    scenario.label = "large" * 1000
    with pytest.raises(ValueError, match="document size"):
        mongo_store.put_scenario(scenario, demand)
    assert not mongo_store.list_scenarios()


def test_development_preview_writes_nothing_then_branch_reloads(mongo_store, scenario_data, transport_world, development_spec):
    pack, _, _ = transport_world
    scenario, parent_demand = scenario_data
    mongo_store.put_scenario(scenario, parent_demand)
    preview, _ = prepare_development(pack, scenario, parent_demand, development_spec)
    assert len(mongo_store.list_scenarios()) == 1
    child, child_demand = apply_development(pack, scenario, parent_demand, preview)
    mongo_store.put_scenario(child, child_demand)
    reloaded = MongoStore(mongo_store.database)
    assert reloaded.get_scenario(child.scenario_id).developments == [preview.development]
    assert reloaded.get_demand(child.scenario_id) == child_demand
    assert reloaded.get_demand(scenario.scenario_id) == parent_demand
    assert child_demand.travelers[:len(parent_demand.travelers)] == parent_demand.travelers


def test_plan_and_validation_are_atomic_and_scoped(mongo_store):
    plan = baseline_plan()
    report = ValidationReport(plan_id=plan.plan_id, valid=True)
    mongo_store.put_plan("parent", plan, report)
    other = plan.model_copy(update={"name": "Other scenario"})
    mongo_store.put_plan("child", other, report)
    assert mongo_store.get_plan("parent", plan.plan_id) == plan
    assert mongo_store.get_validation("parent", plan.plan_id) == report
    assert mongo_store.list_plans("child") == [other]
    assert mongo_store.get_plan("missing", plan.plan_id) is None
    with pytest.raises(ValueError, match="immutable"):
        mongo_store.put_plan("parent", other, report)
    with pytest.raises(ValueError, match="validation"):
        mongo_store.put_plan("invalid", plan, report.model_copy(update={"plan_id": "different"}))
    assert not mongo_store.list_plans("invalid")


def test_scoped_plan_keys_do_not_collide_at_separators(mongo_store):
    first = baseline_plan().model_copy(update={"plan_id": "c"})
    second = baseline_plan().model_copy(update={"plan_id": "b__c"})
    mongo_store.put_plan("a__b", first, ValidationReport(plan_id=first.plan_id, valid=True))
    mongo_store.put_plan("a", second, ValidationReport(plan_id=second.plan_id, valid=True))
    assert mongo_store.get_plan("a__b", "c") == first
    assert mongo_store.get_plan("a", "b__c") == second


def test_runs_and_investigations_update_without_duplicates(mongo_store):
    run = SimulationRun(run_id="run-1", scenario_id="parent", plan_id="baseline", seed=1, status=RunStatus.queued)
    mongo_store.put_run(run)
    run.status, run.progress = RunStatus.running, 0.5
    mongo_store.put_run(run)
    other = run.model_copy(update={"run_id": "run-2", "scenario_id": "child", "created_at": run.created_at + timedelta(seconds=1)})
    mongo_store.put_run(other)
    assert mongo_store.get_run(run.run_id) == run
    assert mongo_store.list_runs("parent") == [run]
    assert mongo_store.list_runs() == [run, other]
    investigation = Investigation(investigation_id="investigation-1", scenario_id="parent", problem_text="development", constraint_text="two buses")
    mongo_store.put_investigation(investigation)
    investigation.status = "completed"
    mongo_store.put_investigation(investigation)
    assert mongo_store.get_investigation(investigation.investigation_id) == investigation
    assert mongo_store.list_investigations("parent") == [investigation]
    assert mongo_store.list_investigations("child") == []


def test_evidence_remains_first_write_wins(mongo_store):
    bundle = EvidenceBundle(bundle_id="evidence-1", corpus_snapshot="fixture", source_ids=[], claims=[]).freeze()
    mongo_store.put_bundle(bundle)
    mongo_store.put_bundle(bundle.model_copy(update={"assumptions": ["replacement"]}))
    assert mongo_store.get_bundle(bundle.bundle_id) == bundle


def test_configuration_requires_atlas_uri_and_never_falls_back(monkeypatch, tmp_path):
    from cityshift import store as module

    monkeypatch.setattr(module, "load_dotenv", lambda *args, **kwargs: None)
    monkeypatch.delenv("CITYSHIFT_STORE", raising=False)
    monkeypatch.delenv("CITYSHIFT_STORAGE", raising=False)
    monkeypatch.delenv("MONGODB_URI", raising=False)
    with pytest.raises(StorageUnavailable, match="MONGODB_URI"):
        create_store(tmp_path / "offline")
    assert not (tmp_path / "offline").exists()
    monkeypatch.setenv("CITYSHIFT_STORE", "json")
    assert type(create_store(tmp_path / "offline")) is Store
    monkeypatch.setenv("CITYSHIFT_STORE", "typo")
    with pytest.raises(StorageUnavailable):
        create_store(tmp_path / "other")


def test_atlas_client_uses_verified_tls_and_majority_writes(monkeypatch):
    from cityshift import mongo_store as module

    options = {}
    database_options = {}
    client = mongomock.MongoClient()
    get_database = client.get_database

    def select_database(name, **kwargs):
        database_options.update(kwargs)
        return get_database(name)

    def connect(uri, **kwargs):
        options.update(kwargs)
        return client

    monkeypatch.setattr(client, "get_database", select_database)
    monkeypatch.setattr(module, "MongoClient", connect)
    store = MongoStore.from_env({"MONGODB_URI": "mongodb+srv://cluster.example.invalid/", "MONGODB_DATABASE": "cityshift_test"})
    assert store.database.name == "cityshift_test"
    assert options["tls"] is True
    assert options["tlsAllowInvalidCertificates"] is False
    assert options["tlsAllowInvalidHostnames"] is False
    assert options["serverSelectionTimeoutMS"] <= 10000
    assert database_options["write_concern"].document["w"] == "majority"
    assert database_options["read_concern"].document["level"] == "majority"
    assert store.ping()


@pytest.mark.parametrize("uri", [
    "http://example.invalid", "mongodb://localhost:27017", "mongodb+srv://cluster.example.invalid/?tls=false",
    "mongodb+srv://cluster.example.invalid/?tlsAllowInvalidCertificates=true",
    "mongodb+srv://cluster.example.invalid/?tlsInsecure=true",
    "mongodbmongodb+srv://cluster.example.invalid/",
    "mongodb+srv://user:<db_password>@cluster.example.invalid/",
    "mongodb+srv://user:%3Cdb_password%3E@cluster.example.invalid/",
])
def test_insecure_or_non_atlas_configuration_is_rejected(uri):
    with pytest.raises(StorageUnavailable):
        MongoStore.from_env({"MONGODB_URI": uri, "MONGODB_DATABASE": "test"})


def test_connection_errors_do_not_expose_credentials(monkeypatch):
    from cityshift import mongo_store as module

    secret = "never-return-this-password"

    def fail(*args, **kwargs):
        raise ServerSelectionTimeoutError(f"mongodb+srv://user:{secret}@cluster.example.invalid")

    monkeypatch.setattr(module, "MongoClient", fail)
    with pytest.raises(StorageUnavailable, match="Atlas is unavailable") as caught:
        MongoStore.from_env({"MONGODB_URI": f"mongodb+srv://user:{secret}@cluster.example.invalid/", "MONGODB_DATABASE": "cityshift_test"})
    assert secret not in str(caught.value)
    assert "mongodb+srv://user" not in str(caught.value)


@pytest.mark.parametrize(("storage", "legacy", "expected"), [
    ("json", None, "json"), ("json", "mongodb", "json"), ("mongodb", "json", "mongodb"),
    (None, "json", "json"), (None, None, "mongodb"),
])
def test_storage_setting_takes_precedence_without_losing_legacy_support(monkeypatch, tmp_path, storage, legacy, expected):
    from cityshift import store as module

    monkeypatch.setattr(module, "load_dotenv", lambda *args, **kwargs: None)
    for name, value in (("CITYSHIFT_STORAGE", storage), ("CITYSHIFT_STORE", legacy)):
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    atlas = object()
    monkeypatch.setattr(MongoStore, "from_env", classmethod(lambda cls: atlas))
    selected = create_store(tmp_path / "offline")
    if expected == "mongodb":
        assert selected is atlas
    else:
        assert type(selected) is Store


@pytest.mark.parametrize("value", ["typo", ""])
def test_storage_setting_does_not_fall_back_when_invalid(monkeypatch, tmp_path, value):
    from cityshift import store as module

    monkeypatch.setattr(module, "load_dotenv", lambda *args, **kwargs: None)
    monkeypatch.setenv("CITYSHIFT_STORAGE", value)
    monkeypatch.setenv("CITYSHIFT_STORE", "json")
    with pytest.raises(StorageUnavailable, match="CITYSHIFT_STORAGE"):
        create_store(tmp_path / "offline")
    assert not (tmp_path / "offline").exists()
