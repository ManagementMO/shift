"""Application services shared by API routers: store, run executor, plan registry."""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

from cityshift.agents.orchestrator import InvestigationRunner, new_investigation
from cityshift.contracts import (
    CityPack,
    DemandSet,
    HazardDraft,
    InterventionProposal,
    Investigation,
    InvestigationOptions,
    RunStatus,
    ScenarioSpec,
    ServicePlan,
    SimulationRun,
    ValidationReport,
)
from cityshift.domain import edits
from cityshift.domain.compiler import baseline_plan, heuristic_plans
from cityshift.domain.hazards import validate_scenario_restrictions
from cityshift.domain.network import PACK_ROOT, load_pack
from cityshift.domain.runs import execute_run, run_id_for
from cityshift.domain.scenarios import flagship_scenario
from cityshift.domain.validators import validate_plan
from cityshift.providers import LLMClient
from cityshift.store import MongoStore, Store


class Service:
    def __init__(self, store: Store | None = None, workers: int = 2):
        self.store = store if store is not None else MongoStore.from_env()
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="sumo")
        self.agent_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="agents")
        self.cancel_flags: dict[str, threading.Event] = {}
        self.lock = threading.Lock()

    # packs ---------------------------------------------------------------------------------------
    def list_packs(self) -> list[CityPack]:
        out = []
        for p in sorted(PACK_ROOT.glob("*/pack.json")):
            out.append(load_pack(p.parent.name))
        return out

    def pack(self, pack_id: str) -> CityPack:
        return load_pack(pack_id)

    # scenarios ----------------------------------------------------------------------------------
    def create_flagship(self, pack_id: str, seed: int, cohort_size: int, horizon_s: int) -> ScenarioSpec:
        pack = self.pack(pack_id)
        scenario, demand = flagship_scenario(pack, seed=seed, cohort_size=cohort_size, horizon_s=horizon_s)
        existing = self.store.get_scenario(scenario.scenario_id)
        if existing is not None:
            return existing
        self.store.put_scenario(scenario, demand)
        for plan in [baseline_plan(), *heuristic_plans(pack, scenario, demand)]:
            self.register_plan(scenario, plan)
        return scenario

    def register_scenario(self, scenario: ScenarioSpec, demand: DemandSet) -> ScenarioSpec:
        pack = self.pack(scenario.pack_id)
        validate_scenario_restrictions(pack, scenario)
        existing = self.store.get_scenario(scenario.scenario_id)
        if existing is not None:
            if existing.model_dump(exclude={"created_at"}) != scenario.model_dump(exclude={"created_at"}):
                raise ValueError("scenario_id already exists with different content; scenarios are immutable")
            return existing
        self.store.put_scenario(scenario, demand)
        for plan in [baseline_plan(), *heuristic_plans(pack, scenario, demand)]:
            self.register_plan(scenario, plan)
        return scenario

    def scenario(self, sid: str) -> ScenarioSpec:
        s = self.store.get_scenario(sid)
        if s is None:
            raise KeyError(sid)
        return s

    def demand(self, sid: str) -> DemandSet:
        d = self.store.get_demand(sid)
        if d is None:
            raise KeyError(sid)
        return d

    # plans ---------------------------------------------------------------------------------------
    def register_plan(self, scenario: ScenarioSpec, plan: ServicePlan) -> ValidationReport:
        pack = self.pack(scenario.pack_id)
        report = validate_plan(pack, scenario, plan, self.store.get_demand(scenario.scenario_id))
        self.store.put_plan(scenario.scenario_id, plan, report)
        return report

    def plan(self, sid: str, pid: str) -> ServicePlan:
        p = self.store.get_plan(sid, pid)
        if p is None:
            raise KeyError(pid)
        return p

    # runs ----------------------------------------------------------------------------------------
    def submit_run(self, sid: str, pid: str, seed: int) -> SimulationRun:
        scenario = self.scenario(sid)
        plan = self.plan(sid, pid)
        demand = self.demand(sid)
        pack = self.pack(scenario.pack_id)
        rid = run_id_for(scenario, plan, seed)
        with self.lock:
            existing = self.store.get_run(rid)
            if existing is not None and existing.status in (
                RunStatus.queued, RunStatus.running, RunStatus.completed, RunStatus.invalid,
            ):
                return existing
            run = SimulationRun(run_id=rid, scenario_id=sid, plan_id=pid, seed=seed, status=RunStatus.queued)
            self.store.put_run(run)
            flag = threading.Event()
            self.cancel_flags[rid] = flag

        def job() -> None:
            try:
                execute_run(run, pack, scenario, demand, plan, persist=self.store.put_run, cancel=flag.is_set)
            finally:
                self.cancel_flags.pop(rid, None)

        self.pool.submit(job)
        return run

    def cancel_run(self, rid: str) -> bool:
        flag = self.cancel_flags.get(rid)
        if flag is None:
            return False
        flag.set()
        return True

    def run(self, rid: str) -> SimulationRun:
        r = self.store.get_run(rid)
        if r is None:
            raise KeyError(rid)
        return r

    # prompt-to-edit ------------------------------------------------------------------------------
    def preview_edit(self, sid: str, prompt: str, use_ai: bool = True) -> InterventionProposal:
        scenario = self.scenario(sid)
        return edits.preview(self.pack(scenario.pack_id), scenario, prompt, llm=LLMClient() if use_ai else None)

    def preview_hazard(self, sid: str, draft: HazardDraft) -> InterventionProposal:
        scenario = self.scenario(sid)
        return edits.preview_hazard(self.pack(scenario.pack_id), scenario, draft)

    def preview_hazard_removal(self, sid: str, track_id: str) -> InterventionProposal:
        scenario = self.scenario(sid)
        return edits.preview_hazard_removal(self.pack(scenario.pack_id), scenario, track_id)

    def preview_hazard_replacement(self, sid: str, track_id: str, draft: HazardDraft) -> InterventionProposal:
        scenario = self.scenario(sid)
        return edits.preview_hazard_replacement(self.pack(scenario.pack_id), scenario, track_id, draft)

    def apply_edit(self, sid: str, proposal: InterventionProposal) -> ScenarioSpec:
        scenario = self.scenario(sid)
        child = edits.apply(self.pack(scenario.pack_id), scenario, proposal)
        child = self.register_scenario(child, self.demand(sid))
        for plan in self.store.list_plans(sid):
            if self.store.get_plan(child.scenario_id, plan.plan_id) is None:
                self.register_plan(child, plan.model_copy(deep=True))
        return child

    # agents --------------------------------------------------------------------------------------
    def investigate(self, sid: str, problem: str, constraint: str, options: InvestigationOptions | None = None) -> Investigation:
        scenario = self.scenario(sid)
        demand = self.demand(sid)
        pack = self.pack(scenario.pack_id)
        inv = new_investigation(sid, problem, constraint, options)
        self.store.put_investigation(inv)
        runner = InvestigationRunner(self.store)
        self.agent_pool.submit(runner.run, inv, pack, scenario, demand)
        return inv

    def investigation(self, iid: str) -> Investigation:
        inv = self.store.get_investigation(iid)
        if inv is None:
            raise KeyError(iid)
        return inv

    def close(self) -> None:
        self.pool.shutdown(wait=True)
        self.agent_pool.shutdown(wait=True)
        self.store.close()


_service: Service | None = None
_service_lock = threading.Lock()


def get_service() -> Service:
    global _service
    with _service_lock:
        if _service is None:
            _service = Service()
        return _service


def close_service() -> None:
    global _service
    with _service_lock:
        if _service is not None:
            _service.close()
            _service = None
