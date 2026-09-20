from __future__ import annotations

import asyncio
import json
import secrets
import tempfile
import threading
from pathlib import Path

from cityshift.agents.population_bridge import ScopedCityBridge
from cityshift.agents.population_client import NativePopulationClient, SwarmUnavailable
from cityshift.agents.population_gateway import GatewayError, get_population_gateway
from cityshift.api.service import Service, get_service
from cityshift.contracts import (
    BrainAssignment,
    ConstraintSet,
    DemandSet,
    PopulationDefinition,
    PopulationSpec,
    PopulationStimulus,
    RunStatus,
    ScenarioSpec,
    SimulationRun,
)
from cityshift.domain.population import district_anchors, generate_population
from cityshift.domain.population_admission import admission_quotes
from cityshift.domain.population_checkpoints import load_checkpoint
from cityshift.domain.population_runs import execute_population_run, population_run_id
from cityshift.domain.population_stimuli import enqueue_stimuli, read_stimuli
from cityshift.domain.runs import RUN_ROOT
from cityshift.providers import POPULATION_MODELS, population_provider_config
from cityshift.transport.population import PopulationMobility


class PopulationService:
    def __init__(self, owner: Service):
        self.owner = owner
        self._control_token = secrets.token_urlsafe(48)
        self._bridges: dict[str, ScopedCityBridge] = {}
        self._bridge_lock = threading.RLock()
        self.pause_flags: dict[str, threading.Event] = {}
        for run in self.owner.store.list_runs():
            if run.run_kind == "population" and run.status in {RunStatus.queued, RunStatus.running}:
                run.status = RunStatus.failed
                run.error = "Execution was interrupted; only a valid sealed checkpoint may resume."
                self.owner.store.put_run(run)
                get_population_gateway().unregister_run(run.run_id)

    def authenticate_controller(self, token: str) -> bool:
        return secrets.compare_digest(token.encode(), self._control_token.encode())

    def register_bridge(self, run_id: str, bridge: ScopedCityBridge) -> None:
        with self._bridge_lock:
            if run_id in self._bridges:
                raise ValueError("population bridge already registered")
            self._bridges[run_id] = bridge

    def release_bridge(self, run_id: str) -> None:
        with self._bridge_lock:
            self._bridges.pop(run_id, None)

    def bridge(self, run_id: str) -> ScopedCityBridge:
        with self._bridge_lock:
            return self._bridges[run_id]

    def status(self) -> dict:
        config = population_provider_config()
        installed = NativePopulationClient.installed()
        configured = config.enabled and bool(config.api_key)
        reason = None
        if not installed:
            reason = "The pinned isolated JiuwenSwarm environment is not installed."
        elif not configured:
            reason = "Configure OPENROUTER_API_KEY and enable CITYSHIFT_POPULATION_LIVE=1, then restart the backend."
        budget = {"session_limit_microdollars": 20_000_000, "blocked": True}
        try:
            gateway = get_population_gateway()
            raw_budget = gateway.usage()
            budget = {key: raw_budget[key] for key in (
                "session_limit_microdollars", "accounted_microdollars", "remaining_microdollars", "request_count", "blocked",
            )}
            if budget["blocked"] or budget["remaining_microdollars"] <= 0:
                reason = "The persistent session inference budget is blocked or exhausted."
            elif installed and configured and not gateway.readiness()["ready"]:
                asyncio.run(gateway.preflight())
        except GatewayError as exc:
            reason = str(exc)
        models = [BrainAssignment(model_family=model.family, model_id=model.model_id, api_provider="openrouter",
                                  config_ref=model.family).model_dump(mode="json") for model in POPULATION_MODELS.values()]
        quotes = admission_quotes(list(POPULATION_MODELS), 1024)
        if reason is None and min(quotes.values()) > budget.get("remaining_microdollars", 0):
            reason = (f"Remaining session budget cannot reserve one reviewed model request "
                      f"(minimum ${min(quotes.values()) / 1_000_000:.4f}). No inference was started.")
        return {"available": reason is None, "reason": reason, "models": models, "budget": budget,
                "native_proof_required": True, "initial_scale_gate": 20,
                "admission": {"request_reservation_microdollars": quotes, "max_output_tokens": 1024}}

    @staticmethod
    def check_admission(population: PopulationDefinition, status: dict) -> None:
        limit = min(int(population.spec.budget.max_cost_usd * 1_000_000),
                    status.get("budget", {}).get("remaining_microdollars", 0))
        models = sorted({brain.model_id for brain in population.assignments.values()})
        quotes = admission_quotes(models, population.spec.budget.max_output_tokens)
        for model_id, quote in quotes.items():
            if quote > limit:
                raise SwarmUnavailable(f"{model_id} requires a ${quote / 1_000_000:.4f} reservation per request; "
                                       f"the available run/session cap is ${limit / 1_000_000:.4f}. "
                                       "Select an affordable reviewed model or reduce its output cap. No inference was started.")

    def create(self, spec: PopulationSpec) -> ScenarioSpec:
        for brain in spec.brains:
            if brain.control_mode == "jiuwenswarm":
                model = POPULATION_MODELS.get(brain.model_id)
                if model is None or brain.model_family != model.family or brain.api_provider != "openrouter":
                    raise ValueError("native brain assignment does not match a reviewed model family/provider")
        pack = self.owner.pack(spec.pack_id)
        anchors = district_anchors(pack, spec)
        with (
            tempfile.TemporaryDirectory(prefix="cityshift-population-access-") as directory,
            PopulationMobility(Path(pack.net_file), Path(directory), "anchor-validation", spec.seed, 2) as mobility,
        ):
            for origin in anchors:
                for destination in anchors:
                    if origin.anchor_id == destination.anchor_id:
                        continue
                    for kind in spec.enabled_classes:
                        option = mobility.estimate_trip(origin, destination, kind)
                        if not option.get("reachable"):
                            raise ValueError(f"district anchor {origin.anchor_id} cannot reach {destination.anchor_id} using {kind}")
        population = generate_population(spec, anchors, pack.network_fingerprint)
        scenario = ScenarioSpec(
            scenario_id=population.population_id, pack_id=pack.pack_id, demand_id=f"residents-{population.population_id}",
            scenario_kind="population", population_id=population.population_id,
            constraints=ConstraintSet(fleet=[], horizon_s=spec.horizon_s, service_window_s=(0, spec.horizon_s),
                                      allowed_stop_ids=[], hard_max_fleet=0),
            label=(f"{'Toronto' if spec.pack_id == 'toronto' else pack.name} working society · "
                   f"{spec.count} persistent residents · "
                   f"{', '.join(dict.fromkeys(brain.model_family for brain in spec.brains))} · seed {spec.seed}"),
        )
        with self.owner.lock:
            self.owner.store.put_population(population)
            existing = self.owner.store.get_scenario(scenario.scenario_id)
            if existing is not None:
                return existing
            self.owner.store.put_scenario(scenario, DemandSet(
                demand_id=scenario.demand_id, seed=spec.seed, travelers=[],
                generation_method="population-envelope; resident state is in the frozen population definition",
            ))
        return scenario

    def population(self, population_id: str) -> PopulationDefinition:
        population = self.owner.store.get_population(population_id)
        if population is None:
            raise KeyError(population_id)
        return population

    def submit(self, population_id: str, idempotency_key: str,
               stimuli: list[PopulationStimulus] | None = None) -> SimulationRun:
        population = self.population(population_id)
        pack = self.owner.pack(population.spec.pack_id)
        rid = population_run_id(population, idempotency_key)
        with self.owner.lock:
            existing = self.owner.store.get_run(rid)
            if existing is not None:
                if stimuli:
                    known = {row.stimulus_id: row for row in read_stimuli(RUN_ROOT, rid)}
                    if any(known.get(row.stimulus_id) != row for row in stimuli):
                        raise ValueError("existing run submission has different initial observations")
                return existing
            if population.spec.brains[0].control_mode == "jiuwenswarm":
                status = self.status()
                if not status["available"]:
                    raise SwarmUnavailable(str(status["reason"]))
                if population.spec.count > status["initial_scale_gate"]:
                    raise SwarmUnavailable("The 12-resident native integration proof must pass before the scale gate is raised.")
                self.check_admission(population, status)
            run = SimulationRun(run_id=rid, scenario_id=population_id, population_id=population_id,
                                run_kind="population", plan_id="service-ledger-v1", seed=population.spec.seed,
                                status=RunStatus.queued)
            if stimuli:
                enqueue_stimuli(RUN_ROOT, rid, stimuli)
            self.owner.store.put_run(run)
            self.owner.cancel_flags[rid] = threading.Event()
            self.pause_flags[rid] = threading.Event()
        self._start_job(run, population, pack)
        return run

    def queue_stimulus(self, run_id: str, stimulus: PopulationStimulus) -> dict:
        with self.owner.lock:
            run = self.owner.run(run_id)
            if run.run_kind != "population" or run.status not in {RunStatus.queued, RunStatus.running, RunStatus.paused}:
                raise ValueError("observations require a queued, running, or checkpoint-paused population run")
            enqueue_stimuli(RUN_ROOT, run_id, [stimulus])
        return {"run_id": run_id, "stimulus_id": stimulus.stimulus_id, "status": "queued",
                "note": "Applied at the next execution boundary; paused runs require explicit Resume."}

    def stimuli(self, run_id: str) -> dict:
        run = self.owner.run(run_id)
        if run.run_kind != "population":
            raise ValueError("only population runs have resident observation inputs")
        applied = []
        try:
            applied = self.snapshot(run_id).get("population", {}).get("stimuli", [])
        except FileNotFoundError:
            pass
        consumed = {row["stimulus"]["stimulus_id"] for row in applied}
        return {"run_id": run_id, "applied": applied,
                "queued": [row.model_dump(mode="json") for row in read_stimuli(RUN_ROOT, run_id)
                           if row.stimulus_id not in consumed]}

    def snapshot(self, run_id: str) -> dict:
        run = self.owner.run(run_id)
        if run.run_kind != "population":
            raise ValueError("only population runs publish resident snapshots")
        directory = Path(run.run_dir) if run.run_dir else RUN_ROOT / run_id
        path = directory / "snapshot.json"
        if path.exists():
            return json.loads(path.read_text())
        if run.status in {RunStatus.queued, RunStatus.running}:
            raise FileNotFoundError("first resident decision boundary is not yet published")
        # Older sealed recordings predate the atomic endpoint and are immutable.
        result = {"run": run.model_dump(mode="json")}
        for name, filename in {"tracks": "tracks.json", "events": "events.json", "occupancy": "occupancy.json",
                               "stopQueue": "stop_queue.json", "compile": "compile.json",
                               "population": "population.json"}.items():
            result[name] = json.loads((directory / filename).read_text())
        return result

    def _start_job(self, run: SimulationRun, population: PopulationDefinition, pack, resume: bool = False) -> None:
        cancel, pause = self.owner.cancel_flags[run.run_id], self.pause_flags[run.run_id]

        def job() -> None:
            try:
                execute_population_run(run, pack, population, self.owner.store.put_run, self.register_bridge,
                                       self.release_bridge, self._control_token, cancel=cancel.is_set,
                                       pause=pause.is_set, resume=resume)
            except Exception:
                run.status = RunStatus.failed
                run.error = "Population run setup or checkpoint restoration failed; no reset was performed."
                self.owner.store.put_run(run)
                raise
            finally:
                self.owner.cancel_flags.pop(run.run_id, None)
                self.pause_flags.pop(run.run_id, None)

        self.owner.pool.submit(job)

    def pause(self, run_id: str) -> bool:
        with self.owner.lock:
            run = self.owner.run(run_id)
            if run.run_kind != "population":
                raise ValueError("checkpoint pause applies only to population runs")
            if run.status == RunStatus.paused:
                return True
            flag = self.pause_flags.get(run_id)
            if flag is None:
                raise ValueError("run is not active")
            flag.set()
            return True

    def resume(self, run_id: str) -> SimulationRun:
        with self.owner.lock:
            run = self.owner.run(run_id)
            if run.run_kind != "population" or run.population_id is None:
                raise ValueError("only a population run has coordinated checkpoints")
            if run.status in {RunStatus.queued, RunStatus.running} and run_id in self.owner.cancel_flags:
                return run
            if run.status not in {RunStatus.paused, RunStatus.failed}:
                raise ValueError("run is not paused or interrupted")
            population = self.population(run.population_id)
            load_checkpoint(RUN_ROOT / run_id, run_id, population)
            if population.spec.brains[0].control_mode == "jiuwenswarm":
                status = self.status()
                if not status["available"] or population.spec.count > status["initial_scale_gate"]:
                    raise SwarmUnavailable(status["reason"] or "native scale gate is not satisfied")
                self.check_admission(population, status)
            run.status = RunStatus.queued
            run.error = None
            self.owner.store.put_run(run)
            self.owner.cancel_flags[run_id] = threading.Event()
            self.pause_flags[run_id] = threading.Event()
        self._start_job(run, population, self.owner.pack(population.spec.pack_id), resume=True)
        return run


_population_service: PopulationService | None = None


def get_population_service() -> PopulationService:
    global _population_service
    if _population_service is None:
        _population_service = PopulationService(get_service())
    return _population_service
