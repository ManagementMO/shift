"""Append-only JSON store. Every object is written once under its id; runs get their own immutable directory."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import TypeVar

from pydantic import BaseModel

from cityshift.contracts import DemandSet, ScenarioSpec, ServicePlan, SimulationRun, ValidationReport

STORE_ROOT = Path(__file__).resolve().parents[2] / "var" / "store"
T = TypeVar("T", bound=BaseModel)


class Store:
    def __init__(self, root: Path = STORE_ROOT):
        self.root = root
        self.lock = threading.RLock()
        for sub in ("scenarios", "demand", "plans", "validations", "runs"):
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
            except Exception:
                continue
        return out

    # scenarios ------------------------------------------------------------------------------
    def put_scenario(self, s: ScenarioSpec, demand: DemandSet) -> None:
        if self.get_scenario(s.scenario_id) is not None:
            raise ValueError(f"scenario {s.scenario_id} already exists (immutable)")
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
