"""Append-only JSON store. Every object is written once under its id; runs get their own immutable directory."""

from __future__ import annotations

import os
import re
import tempfile
import threading
from pathlib import Path
from typing import TypeVar

from dotenv import load_dotenv
from pydantic import BaseModel

from cityshift.contracts import (
    DemandSet,
    EvidenceBundle,
    Investigation,
    PopulationDefinition,
    ScenarioSpec,
    ServicePlan,
    SimulationRun,
    ValidationReport,
)

STORE_ROOT = Path(__file__).resolve().parents[2] / "var" / "store"
T = TypeVar("T", bound=BaseModel)
STORAGE_UNAVAILABLE_MESSAGE = (
    "MongoDB Atlas is unavailable. Check MONGODB_URI, MONGODB_DATABASE, "
    "Atlas network access, TLS trust, and database-user permissions."
)


class StorageUnavailable(RuntimeError):
    pass


class Store:
    backend = "json"

    def __init__(self, root: Path = STORE_ROOT):
        self.root = root
        self.lock = threading.RLock()
        for sub in ("scenarios", "demand", "plans", "validations", "runs", "evidence", "investigations", "populations"):
            (root / sub).mkdir(parents=True, exist_ok=True)

    def ping(self) -> bool:
        return self.root.is_dir()

    def close(self) -> None:
        pass

    def _write(self, sub: str, key: str, obj: BaseModel) -> None:
        with self.lock:
            target = self.root / sub / f"{key}.json"
            with tempfile.NamedTemporaryFile(mode="w", dir=target.parent, prefix=".write-", suffix=".tmp",
                                             encoding="utf-8", delete=False) as stream:
                temporary = Path(stream.name)
                try:
                    stream.write(obj.model_dump_json(indent=1))
                    stream.flush()
                    os.fsync(stream.fileno())
                    os.replace(temporary, target)
                finally:
                    temporary.unlink(missing_ok=True)

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
        with self.lock:
            if self.get_scenario(s.scenario_id) is not None:
                raise ValueError(f"scenario {s.scenario_id} already exists (immutable)")
            if s.demand_id != demand.demand_id:
                raise ValueError("scenario and demand identities do not match")
            if len({t.person_id for t in demand.travelers}) != len(demand.travelers):
                raise ValueError("traveler IDs must be unique within a demand set")
            self._write("demand", s.scenario_id, demand)
            self._write("scenarios", s.scenario_id, s)

    def replace_scenario(self, s: ScenarioSpec, demand: DemandSet) -> None:
        """In-place edit (deleting a building): the scenario keeps its id; runs keyed on the old content go stale."""
        with self.lock:
            if self.get_scenario(s.scenario_id) is None:
                raise KeyError(s.scenario_id)
            if s.demand_id != demand.demand_id:
                raise ValueError("scenario and demand identities do not match")
            if len({t.person_id for t in demand.travelers}) != len(demand.travelers):
                raise ValueError("traveler IDs must be unique within a demand set")
            self._write("demand", s.scenario_id, demand)
            self._write("scenarios", s.scenario_id, s)

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

    def replace_plan(self, sid: str, plan: ServicePlan, report: ValidationReport) -> None:
        """Re-validate a plan after an in-place scenario edit (the JSON store overwrites by key)."""
        self.put_plan(sid, plan, report)

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

    def put_population(self, population: PopulationDefinition) -> None:
        self._population_key(population.population_id)
        with self.lock:
            existing = self.get_population(population.population_id)
            if existing is not None:
                if existing != population:
                    raise ValueError("population definitions are immutable")
                return
            self._write("populations", population.population_id, population)

    def get_population(self, population_id: str) -> PopulationDefinition | None:
        self._population_key(population_id)
        return self._read("populations", population_id, PopulationDefinition)

    def list_populations(self) -> list[PopulationDefinition]:
        return self._list("populations", PopulationDefinition)

    @staticmethod
    def _population_key(value: str) -> None:
        if re.fullmatch(r"[a-zA-Z0-9_-]{1,160}", value) is None:
            raise ValueError("invalid population identifier")


def storage_backend() -> str:
    return os.environ.get("CITYSHIFT_STORAGE", os.environ.get("CITYSHIFT_STORE", "mongodb")).strip().lower()


def create_store(root: Path = STORE_ROOT) -> Store:
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    backend = storage_backend()
    if backend == "json":
        return Store(root)
    if backend != "mongodb":
        raise StorageUnavailable("CITYSHIFT_STORAGE must be mongodb or json (explicit offline mode); CITYSHIFT_STORE is a legacy alias")
    from cityshift.mongo_store import MongoStore

    return MongoStore.from_env()
