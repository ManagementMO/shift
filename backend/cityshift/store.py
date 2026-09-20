"""Metadata persistence: primary MongoDB store and an explicit legacy JSON store for artifacts and tests."""

from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import TypeVar

from dotenv import load_dotenv
from pydantic import BaseModel
from pymongo import MongoClient
from pymongo.database import Database
from pymongo.errors import DuplicateKeyError, PyMongoError

from cityshift.contracts import (
    DemandSet,
    EvidenceBundle,
    Investigation,
    ScenarioSpec,
    ServicePlan,
    SimulationRun,
    ValidationReport,
)

STORE_ROOT = Path(__file__).resolve().parents[2] / "var" / "store"
T = TypeVar("T", bound=BaseModel)
load_dotenv(Path(__file__).resolve().parents[1] / ".env")


class StorageConfigurationError(RuntimeError):
    pass


class StoreConflictError(ValueError):
    pass


class Store:
    def __init__(self, root: Path = STORE_ROOT):
        self.root = root
        self.lock = threading.RLock()
        for sub in ("scenarios", "demand", "plans", "validations", "runs", "evidence", "investigations"):
            (root / sub).mkdir(parents=True, exist_ok=True)

    def _write(self, sub: str, key: str, obj: BaseModel) -> None:
        with self.lock:
            (self.root / sub / f"{key}.json").write_text(obj.model_dump_json(indent=1))

    def _read(self, sub: str, key: str, cls: type[T]) -> T | None:
        p = self.root / sub / f"{key}.json"
        if not p.exists():
            return None
        return cls.model_validate_json(p.read_text())

    def _list(self, sub: str, cls: type[T]) -> list[T]:
        out = []
        for p in sorted((self.root / sub).glob("*.json")):
            try:
                out.append(cls.model_validate_json(p.read_text()))
            except ValueError:  # skip a corrupt file rather than hide the rest
                continue
        return out

    # scenarios ------------------------------------------------------------------------------
    def put_scenario(self, s: ScenarioSpec, demand: DemandSet) -> None:
        if self.get_scenario(s.scenario_id) is not None:
            raise StoreConflictError(f"scenario {s.scenario_id} already exists (immutable)")
        self._write("scenarios", s.scenario_id, s)
        self._write("demand", s.scenario_id, demand)

    def get_scenario(self, sid: str) -> ScenarioSpec | None:
        return self._read("scenarios", sid, ScenarioSpec)

    def get_demand(self, sid: str) -> DemandSet | None:
        return self._read("demand", sid, DemandSet)

    def list_scenarios(self) -> list[ScenarioSpec]:
        return sorted(self._list("scenarios", ScenarioSpec), key=lambda s: s.created_at)

    # plans ------------------------------------------------------------------------------------
    def put_plan(self, sid: str, plan: ServicePlan, report: ValidationReport) -> None:
        self._write("plans", f"{sid}__{plan.plan_id}", plan)
        self._write("validations", f"{sid}__{plan.plan_id}", report)

    def get_plan(self, sid: str, pid: str) -> ServicePlan | None:
        return self._read("plans", f"{sid}__{pid}", ServicePlan)

    def get_validation(self, sid: str, pid: str) -> ValidationReport | None:
        return self._read("validations", f"{sid}__{pid}", ValidationReport)

    def list_plans(self, sid: str) -> list[ServicePlan]:
        out = []
        for p in sorted((self.root / "plans").glob(f"{sid}__*.json")):
            out.append(ServicePlan.model_validate_json(p.read_text()))
        return out

    # evidence / investigations -------------------------------------------------------------
    def put_bundle(self, b: EvidenceBundle) -> None:
        if self.get_bundle(b.bundle_id) is None:  # frozen: first write wins, identical hash anyway
            self._write("evidence", b.bundle_id, b)

    def get_bundle(self, bid: str) -> EvidenceBundle | None:
        return self._read("evidence", bid, EvidenceBundle)

    def put_investigation(self, inv: Investigation) -> None:
        self._write("investigations", inv.investigation_id, inv)

    def get_investigation(self, iid: str) -> Investigation | None:
        return self._read("investigations", iid, Investigation)

    def list_investigations(self, sid: str | None = None) -> list[Investigation]:
        out = self._list("investigations", Investigation)
        if sid:
            out = [i for i in out if i.scenario_id == sid]
        return sorted(out, key=lambda i: i.created_at)

    # runs -------------------------------------------------------------------------------------
    def put_run(self, r: SimulationRun) -> None:
        self._write("runs", r.run_id, r)

    def get_run(self, rid: str) -> SimulationRun | None:
        return self._read("runs", rid, SimulationRun)

    def list_runs(self, sid: str | None = None) -> list[SimulationRun]:
        runs = self._list("runs", SimulationRun)
        if sid:
            runs = [r for r in runs if r.scenario_id == sid]
        return sorted(runs, key=lambda r: r.created_at)

    def ping(self) -> None:
        return None

    def close(self) -> None:
        return None


class MongoStore(Store):
    def __init__(self, database: Database):
        self.database = database
        self.lock = threading.RLock()
        self._indexes_ready = False

    @classmethod
    def from_env(cls) -> MongoStore:
        uri = os.environ.get("MONGODB_URI", "").strip()
        name = os.environ.get("MONGODB_DATABASE", "cityshift").strip()
        if not uri or not uri.startswith(("mongodb://", "mongodb+srv://")) or "<" in uri or ">" in uri:
            raise StorageConfigurationError("Set MONGODB_URI to a complete MongoDB connection string in backend/.env or the server environment; no JSON fallback is used.")
        if not name or name in {"admin", "config", "local"}:
            raise StorageConfigurationError("Set MONGODB_DATABASE to an application database name (default: cityshift).")
        client: MongoClient | None = None
        try:
            client = MongoClient(uri, tz_aware=True, serverSelectionTimeoutMS=5000, connectTimeoutMS=5000, connect=False)
            return cls(client.get_database(name))
        except (PyMongoError, ValueError):
            if client is not None:
                client.close()
            raise StorageConfigurationError("MongoDB configuration could not be initialized. Check MONGODB_URI, MONGODB_DATABASE, and DNS access.") from None

    def _ensure_indexes(self) -> None:
        with self.lock:
            if self._indexes_ready:
                return
            self.database.scenarios.create_index("data.created_at")
            self.database.plans.create_index([("_id.scenario_id", 1), ("_id.plan_id", 1)])
            for name in ("runs", "investigations"):
                self.database[name].create_index([("data.scenario_id", 1), ("data.created_at", 1)])
            self._indexes_ready = True

    def _write(self, sub: str, key: str, obj: BaseModel) -> None:
        self._ensure_indexes()
        self.database[sub].replace_one({"_id": key}, {"_id": key, "schema_version": 1, "data": obj.model_dump(mode="json")}, upsert=True)

    def _read(self, sub: str, key: str, cls: type[T]) -> T | None:
        doc = self.database[sub].find_one({"_id": key})
        return cls.model_validate(doc["data"]) if doc is not None else None

    def _list(self, sub: str, cls: type[T], query: dict | None = None) -> list[T]:
        return [cls.model_validate(doc["data"]) for doc in self.database[sub].find(query or {})]

    def put_scenario(self, s: ScenarioSpec, demand: DemandSet) -> None:
        if s.demand_id != demand.demand_id:
            raise ValueError("scenario demand_id must match its demand set")
        self._ensure_indexes()
        doc = {"_id": s.scenario_id, "schema_version": 1, "data": s.model_dump(mode="json"), "demand": demand.model_dump(mode="json")}
        try:
            self.database.scenarios.insert_one(doc)
        except DuplicateKeyError:
            raise StoreConflictError(f"scenario {s.scenario_id} already exists (immutable)") from None

    def get_demand(self, sid: str) -> DemandSet | None:
        doc = self.database.scenarios.find_one({"_id": sid}, {"demand": 1})
        return DemandSet.model_validate(doc["demand"]) if doc is not None else None

    def put_plan(self, sid: str, plan: ServicePlan, report: ValidationReport) -> None:
        if report.plan_id != plan.plan_id:
            raise ValueError("plan and validation ids must match")
        self._ensure_indexes()
        key = {"scenario_id": sid, "plan_id": plan.plan_id}
        doc = {"_id": key, "schema_version": 1, "data": plan.model_dump(mode="json"), "validation": report.model_dump(mode="json")}
        try:
            self.database.plans.insert_one(doc)
        except DuplicateKeyError:
            existing = self.database.plans.find_one({"_id": key})
            if existing != doc:
                raise StoreConflictError(f"plan {plan.plan_id} already exists in scenario {sid} (immutable)") from None

    def get_plan(self, sid: str, pid: str) -> ServicePlan | None:
        doc = self.database.plans.find_one({"_id": {"scenario_id": sid, "plan_id": pid}})
        return ServicePlan.model_validate(doc["data"]) if doc is not None else None

    def get_validation(self, sid: str, pid: str) -> ValidationReport | None:
        doc = self.database.plans.find_one({"_id": {"scenario_id": sid, "plan_id": pid}}, {"validation": 1})
        return ValidationReport.model_validate(doc["validation"]) if doc is not None else None

    def list_plans(self, sid: str) -> list[ServicePlan]:
        return sorted(self._list("plans", ServicePlan, {"_id.scenario_id": sid}), key=lambda p: p.plan_id)

    def put_bundle(self, b: EvidenceBundle) -> None:
        self._ensure_indexes()
        self.database.evidence.update_one({"_id": b.bundle_id}, {"$setOnInsert": {"schema_version": 1, "data": b.model_dump(mode="json")}}, upsert=True)

    def list_investigations(self, sid: str | None = None) -> list[Investigation]:
        query = {"data.scenario_id": sid} if sid is not None else {}
        return sorted(self._list("investigations", Investigation, query), key=lambda inv: inv.created_at)

    def put_run(self, r: SimulationRun) -> None:
        self._ensure_indexes()
        doc = {"_id": r.run_id, "schema_version": 1, "data": r.model_dump(mode="json")}
        try:
            self.database.runs.replace_one({"_id": r.run_id, "data.status": {"$nin": ["completed", "invalid"]}}, doc, upsert=True)
        except DuplicateKeyError:
            if self.get_run(r.run_id) != r:
                raise StoreConflictError(f"run {r.run_id} already has an immutable terminal result") from None

    def list_runs(self, sid: str | None = None) -> list[SimulationRun]:
        query = {"data.scenario_id": sid} if sid is not None else {}
        return sorted(self._list("runs", SimulationRun, query), key=lambda r: r.created_at)

    def ping(self) -> None:
        self.database.command("ping")

    def close(self) -> None:
        self.database.client.close()
