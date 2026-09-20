from __future__ import annotations

import json
import os
import re
import threading
from collections.abc import Mapping
from typing import Self
from urllib.parse import parse_qsl, unquote, urlsplit

from bson import BSON
from pydantic import BaseModel
from pymongo import ASCENDING, MongoClient
from pymongo.database import Database
from pymongo.errors import DuplicateKeyError, PyMongoError
from pymongo.read_concern import ReadConcern
from pymongo.write_concern import WriteConcern

from cityshift.contracts import (
    DemandSet,
    EvidenceBundle,
    Investigation,
    ScenarioSpec,
    ServicePlan,
    SimulationRun,
    ValidationReport,
)
from cityshift.store import STORAGE_UNAVAILABLE_MESSAGE, StorageUnavailable, Store, T

MAX_DOCUMENT_BYTES = 16 * 1024 * 1024


class MongoStore(Store):
    backend = "mongodb"

    def __init__(self, database: Database):
        self.database = database
        self.lock = threading.RLock()
        database.plans.create_index([("scenario_id", ASCENDING), ("data.plan_id", ASCENDING)], unique=True)
        database.runs.create_index([("data.scenario_id", ASCENDING), ("data.created_at", ASCENDING)])
        database.investigations.create_index([("data.scenario_id", ASCENDING), ("data.created_at", ASCENDING)])

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> Self:
        env = os.environ if environ is None else environ
        uri = env.get("MONGODB_URI", "").strip()
        name = env.get("MONGODB_DATABASE", "").strip()
        if not uri:
            raise StorageUnavailable("Set MONGODB_URI to an Atlas connection string, or explicitly select CITYSHIFT_STORAGE=json for offline use")
        if not name:
            raise StorageUnavailable("Set MONGODB_DATABASE to a dedicated application database")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,63}", name) or name.lower() in {"admin", "config", "local"}:
            raise StorageUnavailable("MONGODB_DATABASE must name a dedicated application database using 1–63 letters, numbers, underscores or hyphens")
        try:
            parsed = urlsplit(uri)
        except ValueError:
            raise StorageUnavailable("MONGODB_URI must be a valid Atlas mongodb+srv connection string") from None
        if parsed.scheme != "mongodb+srv" or not parsed.hostname:
            raise StorageUnavailable("MONGODB_URI must use the Atlas mongodb+srv scheme")
        if unquote(parsed.password or "").lower() in {"<db_password>", "<password>", "<url_encoded_password>"}:
            raise StorageUnavailable("Replace the Atlas password placeholder in MONGODB_URI locally; URL-encode reserved characters")
        insecure = {"tlsinsecure", "tlsallowinvalidcertificates", "tlsallowinvalidhostnames"}
        for key, value in parse_qsl(parsed.query):
            key, value = key.lower(), value.lower()
            if (key in insecure and value != "false") or (key in {"tls", "ssl"} and value != "true"):
                raise StorageUnavailable("Atlas connections require TLS with certificate and hostname verification enabled")
        options: dict = {
            "appname": "cityshift", "serverSelectionTimeoutMS": 5000, "connectTimeoutMS": 5000,
            "socketTimeoutMS": 10000, "maxPoolSize": 20, "tls": True,
            "tlsAllowInvalidCertificates": False, "tlsAllowInvalidHostnames": False,
        }
        ca_file = env.get("MONGODB_TLS_CA_FILE", "").strip()
        if ca_file:
            options["tlsCAFile"] = ca_file
        client: MongoClient | None = None
        try:
            client = MongoClient(uri, **options)
            database = client.get_database(name, write_concern=WriteConcern(w="majority"), read_concern=ReadConcern("majority"))
            store = cls(database)
            store.ping()
            return store
        except (PyMongoError, ValueError, OSError):
            if client is not None:
                client.close()
            raise StorageUnavailable(STORAGE_UNAVAILABLE_MESSAGE) from None

    def ping(self) -> bool:
        return self.database.command("ping").get("ok") == 1

    def close(self) -> None:
        self.database.client.close()

    @staticmethod
    def _check_size(document: dict) -> None:
        if len(BSON.encode(document)) > MAX_DOCUMENT_BYTES:
            raise ValueError("MongoDB document size limit exceeded (16 MiB); reduce the scenario cohort or record size")

    def _write(self, sub: str, key: str, obj: BaseModel) -> None:
        document = {"_id": key, "data": obj.model_dump(mode="json")}
        self._check_size(document)
        self.database[sub].replace_one({"_id": key}, document, upsert=True)

    def _read(self, sub: str, key: str, cls: type[T]) -> T | None:
        document = self.database[sub].find_one({"_id": key}, {"data": 1})
        return cls.model_validate(document["data"]) if document else None

    def _list(self, sub: str, cls: type[T], query: dict | None = None) -> list[T]:
        out = []
        for document in self.database[sub].find(query or {}, {"data": 1}):
            try:
                out.append(cls.model_validate(document["data"]))
            except (ValueError, KeyError):
                continue
        return out

    def put_scenario(self, s: ScenarioSpec, demand: DemandSet) -> None:
        if s.demand_id != demand.demand_id:
            raise ValueError("scenario and demand identities do not match")
        if len({t.person_id for t in demand.travelers}) != len(demand.travelers):
            raise ValueError("traveler IDs must be unique within a demand set")
        document = {"_id": s.scenario_id, "data": s.model_dump(mode="json"), "demand": demand.model_dump(mode="json")}
        self._check_size(document)
        try:
            self.database.scenarios.insert_one(document)
        except DuplicateKeyError:
            raise ValueError(f"scenario {s.scenario_id} already exists (immutable)") from None

    def replace_scenario(self, s: ScenarioSpec, demand: DemandSet) -> None:
        if s.demand_id != demand.demand_id:
            raise ValueError("scenario and demand identities do not match")
        if len({t.person_id for t in demand.travelers}) != len(demand.travelers):
            raise ValueError("traveler IDs must be unique within a demand set")
        document = {"_id": s.scenario_id, "data": s.model_dump(mode="json"), "demand": demand.model_dump(mode="json")}
        self._check_size(document)
        if self.database.scenarios.replace_one({"_id": s.scenario_id}, document, upsert=False).matched_count == 0:
            raise KeyError(s.scenario_id)

    def get_demand(self, sid: str) -> DemandSet | None:
        document = self.database.scenarios.find_one({"_id": sid}, {"demand": 1})
        return DemandSet.model_validate(document["demand"]) if document else None

    @staticmethod
    def _plan_key(sid: str, pid: str) -> str:
        return json.dumps([sid, pid], separators=(",", ":"))

    def put_plan(self, sid: str, plan: ServicePlan, report: ValidationReport) -> None:
        if report.plan_id != plan.plan_id:
            raise ValueError("plan and validation identities do not match")
        document = {
            "_id": self._plan_key(sid, plan.plan_id), "scenario_id": sid,
            "data": plan.model_dump(mode="json"), "validation": report.model_dump(mode="json"),
        }
        self._check_size(document)
        try:
            self.database.plans.insert_one(document)
        except DuplicateKeyError:
            raise ValueError("plan already exists for this scenario (immutable)") from None

    def replace_plan(self, sid: str, plan: ServicePlan, report: ValidationReport) -> None:
        if report.plan_id != plan.plan_id:
            raise ValueError("plan and validation identities do not match")
        document = {
            "_id": self._plan_key(sid, plan.plan_id), "scenario_id": sid,
            "data": plan.model_dump(mode="json"), "validation": report.model_dump(mode="json"),
        }
        self._check_size(document)
        self.database.plans.replace_one({"_id": document["_id"]}, document, upsert=True)

    def get_plan(self, sid: str, pid: str) -> ServicePlan | None:
        return self._read("plans", self._plan_key(sid, pid), ServicePlan)

    def get_validation(self, sid: str, pid: str) -> ValidationReport | None:
        document = self.database.plans.find_one({"_id": self._plan_key(sid, pid)}, {"validation": 1})
        return ValidationReport.model_validate(document["validation"]) if document else None

    def list_plans(self, sid: str) -> list[ServicePlan]:
        return sorted(self._list("plans", ServicePlan, {"scenario_id": sid}), key=lambda p: p.plan_id)

    def put_bundle(self, b: EvidenceBundle) -> None:
        document = {"_id": b.bundle_id, "data": b.model_dump(mode="json")}
        self._check_size(document)
        try:
            self.database.evidence.insert_one(document)
        except DuplicateKeyError:
            pass

    def list_runs(self, sid: str | None = None) -> list[SimulationRun]:
        query = {"data.scenario_id": sid} if sid is not None else {}
        return sorted(self._list("runs", SimulationRun, query), key=lambda r: r.created_at)

    def list_investigations(self, sid: str | None = None) -> list[Investigation]:
        query = {"data.scenario_id": sid} if sid is not None else {}
        return sorted(self._list("investigations", Investigation, query), key=lambda i: i.created_at)
