from __future__ import annotations

import asyncio
import hashlib
import time
import traceback
import uuid
from collections.abc import Callable
from contextlib import ExitStack, suppress
from pathlib import Path

import httpx

from cityshift.agents.population_baseline import baseline_decision
from cityshift.agents.population_bridge import ScopedCityBridge
from cityshift.agents.population_client import NativePopulationClient, SwarmUnavailable
from cityshift.agents.population_gateway import RunLimits, get_population_gateway
from cityshift.contracts import (
    CityPack,
    PopulationArtifact,
    PopulationDefinition,
    ResidentDecision,
    RunStatus,
    SimulationRun,
    content_hash,
    utcnow,
)
from cityshift.domain.population_admission import admitted_residents, boundary_budget_reason
from cityshift.domain.population_checkpoints import (
    atomic_json,
    consume_checkpoint,
    file_hash,
    load_checkpoint,
    save_checkpoint,
)
from cityshift.domain.population_stimuli import read_stimuli
from cityshift.domain.runs import RUN_ROOT
from cityshift.domain.society import SocietyWorld
from cityshift.providers import API_PORT, POPULATION_GATEWAY_BASE
from cityshift.transport.population import PopulationMobility
from cityshift.transport.sumo_env import sumo_version

ARTIFACT_INTERVAL_S = 300


def population_run_id(population: PopulationDefinition, idempotency_key: str) -> str:
    return "society-" + content_hash({"population": population.population_id, "submission": idempotency_key})


def _save(world: SocietyWorld, mobility: PopulationMobility, run: SimulationRun, attempt: str,
          out_dir: Path, started: float, usage: dict | None = None) -> PopulationArtifact:
    artifact = world.artifact(attempt)
    artifact.metrics.wall_time_s = round(time.monotonic() - started, 3)
    if usage:
        totals = usage["run_totals"]
        artifact.metrics.calls = totals["calls"]
        artifact.metrics.tokens = totals["reported_tokens"]
        artifact.metrics.cost_usd = totals["reported_cost_microdollars"] / 1_000_000
        artifact.metrics.reserved_cost_usd = totals["accounted_microdollars"] / 1_000_000
        if totals["uncertain_requests"]:
            artifact.metrics.warnings.append("Some provider charges remain conservatively reserved because usage was unavailable.")
    if world.definition.spec.brains[0].control_mode == "rules":
        artifact.metrics.warnings.append("Deterministic rules fixture; this is not evidence of native JiuwenSwarm cognition.")
    else:
        fallbacks = artifact.metrics.decision_source_counts.get("fallback", 0)
        if fallbacks:
            artifact.metrics.warnings.append(f"{fallbacks} decision(s) used explicit fallback, not fresh model choices.")
        if not any(record.source == "jiuwenswarm" and record.accepted for record in world.decisions):
            artifact.metrics.warnings.append("No native resident action was accepted; this recording does not prove working live cognition.")
    if mobility.teleports:
        artifact.metrics.warnings.append(f"{mobility.teleports} SUMO teleport(s); failed positions are not fabricated.")
    if run.status in {RunStatus.failed, RunStatus.canceled}:
        artifact.metrics.warnings.append("Partial recorded execution; only an explicitly sealed paired checkpoint can resume.")
    elif run.status == RunStatus.paused:
        artifact.metrics.warnings.append("Execution paused at a sealed, coordinated world/transport/cognition boundary.")
    data = {
        "tracks.json": {key: track.model_dump(mode="json") for key, track in mobility.tracks.items()},
        "events.json": [event.model_dump(mode="json") for event in mobility.events],
        "occupancy.json": {}, "stop_queue.json": {},
        "cohort.json": {"cohort": list(world.states), "desired_depart": {}, "arrived": {},
                        "population_lifecycle": "persistent; transport arrival is not resident completion"},
        "compile.json": {"ok": True, "errors": [], "notes": ["Explicit population scenario; no transport flagship closures."],
                         "mode_assignment": {}, "unroutable": {}, "line_schedule": {}, "duties": []},
    }
    for name, value in data.items():
        atomic_json(out_dir / name, value)
    for _ in range(3):
        encoded = artifact.model_dump_json()
        artifact.metrics.artifact_bytes = len(encoded.encode()) + sum((out_dir / name).stat().st_size for name in data)
    atomic_json(out_dir / "population.json", artifact.model_dump(mode="json"))
    atomic_json(out_dir / "metrics.json", artifact.metrics.model_dump(mode="json"))
    run.progress = world.t / world.definition.spec.horizon_s
    run.warnings = list(artifact.metrics.warnings)
    # The viewer reads one atomically replaced file, never a mixture of epochs.
    atomic_json(out_dir / "snapshot.json", {
        "run": run.model_dump(mode="json"), "tracks": data["tracks.json"], "events": data["events.json"],
        "occupancy": {}, "stopQueue": {}, "compile": data["compile.json"],
        "population": artifact.model_dump(mode="json"),
    })
    return artifact


def execute_population_run(run: SimulationRun, pack: CityPack, population: PopulationDefinition,
                           persist: Callable[[SimulationRun], None], register_bridge: Callable[[str, ScopedCityBridge], None],
                           release_bridge: Callable[[str], None], control_token: str,
                           cancel: Callable[[], bool] | None = None, run_root: Path = RUN_ROOT,
                           pause: Callable[[], bool] | None = None, resume: bool = False) -> SimulationRun:
    out_dir = run_root / run.run_id
    checkpoint = load_checkpoint(out_dir, run.run_id, population) if resume else None
    out_dir.mkdir(parents=True, exist_ok=resume)
    run.run_dir = str(out_dir)
    run.status = RunStatus.running
    run.started_at = run.started_at or utcnow()
    run.ended_at = None
    run.error = None
    run.engine_version = f"SUMO {sumo_version()}; service-ledger-v1"
    attempt = checkpoint["manifest"]["attempt_id"] if checkpoint else uuid.uuid4().hex
    started = time.monotonic() - (checkpoint["manifest"]["wall_time_s"] if checkpoint else 0)
    bridge = ScopedCityBridge(run.run_id)
    prior_audit = checkpoint["bridge_audit"] if checkpoint else []
    resources = ExitStack()
    resources.callback(bridge.close)
    client: NativePopulationClient | None = None
    gateway = None
    world: SocietyWorld | None = None
    mobility: PopulationMobility | None = None
    try:
        register_bridge(run.run_id, bridge)
        resources.callback(release_bridge, run.run_id)
        if (population.spec.pack_id != pack.pack_id or population.network_fingerprint != pack.network_fingerprint
                or file_hash(Path(pack.net_file))[:16] != pack.network_fingerprint):
            raise ValueError("frozen population network does not match the current city pack")
        mobility = PopulationMobility(Path(pack.net_file), out_dir, run.run_id, population.spec.seed, population.spec.horizon_s)
        resources.callback(mobility.close)
        persist(run)
        with mobility:
            if checkpoint is not None:
                mobility.restore_checkpoint(checkpoint["sumo_path"], checkpoint["mobility"])
                world = SocietyWorld.from_checkpoint(run.run_id, population, mobility, checkpoint["world"])
            else:
                world = SocietyWorld(run.run_id, population, mobility)
            native = population.spec.brains[0].control_mode == "jiuwenswarm"
            if native:
                # Publish truthful bodies before slow worker startup. No model
                # execution or initial decision is implied by this snapshot.
                _save(world, mobility, run, attempt, out_dir, started)
                persist(run)
                gateway = get_population_gateway()
                asyncio.run(gateway.preflight())
                budget = population.spec.budget
                registration = gateway.register_run(run.run_id, [brain.model_id for brain in population.assignments.values()],
                    limits=RunLimits(max_calls=budget.max_calls, max_tokens=budget.max_tokens,
                                     max_cost_microdollars=int(budget.max_cost_usd * 1_000_000),
                                     requests_per_minute=budget.requests_per_minute,
                                     tokens_per_minute=budget.tokens_per_minute, max_output_tokens=budget.max_output_tokens,
                                     request_timeout_seconds=budget.decision_timeout_s),
                    allowed_tools={"observe_local_state", "recall_experience", "view_tasks", "estimate_trip",
                                   "propose_message", "propose_action", "structured_output"})
                resources.callback(gateway.unregister_run, run.run_id)
                client = NativePopulationClient(run.run_id, population, control_token, registration.token,
                                                POPULATION_GATEWAY_BASE, f"http://127.0.0.1:{API_PORT}")
                resources.callback(client.close)
                client.start(resume=checkpoint["manifest"]["native"] if checkpoint else None)
                atomic_json(out_dir / "native.json", client.health)
            if checkpoint is not None:
                consume_checkpoint(checkpoint)
                run.checkpoint_available = False
                persist(run)
            last_published_t = world.t - ARTIFACT_INTERVAL_S
            while world.t < population.spec.horizon_s:
                if cancel and cancel():
                    run.status = RunStatus.canceled
                    break
                if pause and pause():
                    saved = save_checkpoint(out_dir, attempt, world, mobility, client, time.monotonic() - started,
                                            prior_audit + bridge.audit())
                    run.checkpoint_id = saved["checkpoint_id"]
                    run.checkpoint_available = True
                    run.status = RunStatus.paused
                    break
                inputs_changed = world.apply_stimuli(read_stimuli(run_root, run.run_id))
                due = sorted(world.due_residents(), key=lambda rid: (world.states[rid].next_decision_s, rid))
                if native and gateway is not None and due:
                    boundary_usage = gateway.usage(run.run_id)
                    reason = boundary_budget_reason(population, due[:1], boundary_usage)
                    if reason:
                        saved = save_checkpoint(out_dir, attempt, world, mobility, client, time.monotonic() - started,
                                                prior_audit + bridge.audit())
                        run.checkpoint_id = saved["checkpoint_id"]
                        run.checkpoint_available = True
                        run.status = RunStatus.paused
                        run.error = reason
                        break
                    due = admitted_residents(population, due, boundary_usage)
                # A native epoch has one shared deadline. Do not enqueue additional
                # waves behind the SDK's worker limit under that same deadline.
                packets = world.begin_epoch(due if native else None)
                if packets:
                    if native:
                        if client is None:
                            raise SwarmUnavailable("native controller missing; rules substitution is forbidden")
                        bridge.begin_epoch(world.epoch, packets)
                        try:
                            results, bindings, failures, usage = client.decide(packets)
                        finally:
                            staged = bridge.end_epoch(world.epoch)
                        rejections = {}
                        for rid, choice in results.items():
                            if choice is None:
                                continue
                            submitted = next((intent for intent in staged if intent.resident_id == rid
                                              and intent.idempotency_key == choice.proposal.idempotency_key), None)
                            if submitted is None:
                                rejections[rid] = "actor-bound proposal was not submitted through the city bridge"
                                continue
                            expected = choice.proposal.model_dump(mode="json")
                            actual = {key: submitted.model_dump(mode="json")[key] for key in expected}
                            if expected != actual:
                                rejections[rid] = "structured decision differs from the actor's staged proposal"
                        records = world.commit_decisions(
                            results, source="jiuwenswarm", bindings=bindings, failures=failures,
                            usage=usage, staged_messages=[i for i in staged if i.action == "message"],
                            rejections=rejections, staged_intents=staged,
                        )
                        atomic_json(out_dir / "native_tools.json", prior_audit + bridge.audit())
                        reported_calls = [record.usage.get("reported_model_calls", 0) for record in records]
                        if (all(record.source == "fallback" for record in records)
                                and not any(isinstance(value, (int, float)) and not isinstance(value, bool)
                                            and value > 0 for value in reported_calls)):
                            # A running SDK can still reject every model request before
                            # dispatch. Keep this failed boundary inspectable, but never
                            # turn it into a whole simulated day of automatic fallback waits.
                            saved = save_checkpoint(out_dir, attempt, world, mobility, client, time.monotonic() - started,
                                                    prior_audit + bridge.audit())
                            run.checkpoint_id = saved["checkpoint_id"]
                            run.checkpoint_available = True
                            run.status = RunStatus.paused
                            run.error = ("Native decision batch produced only fallback records and no reported provider "
                                         "model calls. Execution paused before advancing city time; inspect model-request "
                                         "validation and provider errors before resuming.")
                            break
                    else:
                        choices: dict[str, ResidentDecision | None] = {
                            packet["resident_id"]: baseline_decision(packet) for packet in packets
                        }
                        world.commit_decisions(choices, source="rules")
                periodic = world.t - last_published_t >= ARTIFACT_INTERVAL_S
                if inputs_changed or (native and packets) or periodic:
                    _save(world, mobility, run, attempt, out_dir, started, gateway.usage(run.run_id) if gateway else None)
                    if periodic:
                        last_published_t = world.t
                    persist(run)
                outcomes = mobility.step()
                world.advance(mobility.t, outcomes)
                if world.t % 30 == 0:
                    run.progress = world.t / population.spec.horizon_s
                    persist(run)
            if run.status == RunStatus.running:
                run.status = RunStatus.completed
    except Exception as exc:
        run.status = RunStatus.failed
        run.error = f"Population execution stopped ({type(exc).__name__}); partial records remain inspectable."
        with suppress(OSError):
            atomic_json(out_dir / "error.json", {"type": type(exc).__name__, "stack": traceback.format_tb(exc.__traceback__)})
        if not isinstance(exc, (OSError, ValueError, RuntimeError, httpx.HTTPError)):
            raise
    finally:
        try:
            resources.close()
        except (OSError, RuntimeError, httpx.HTTPError) as exc:
            run.status = RunStatus.failed
            run.error = f"Population resource cleanup failed ({type(exc).__name__})."
        run.ended_at = utcnow()
        try:
            usage_snapshot = gateway.usage(run.run_id) if gateway else None
            if world is not None and mobility is not None:
                artifact = _save(world, mobility, run, attempt, out_dir, started, usage_snapshot)
                run.warnings = list(artifact.metrics.warnings)
                run.progress = world.t / population.spec.horizon_s
            manifest = {
                "version": "population-1", "run_id": run.run_id, "attempt_id": attempt,
                "population_id": population.population_id, "spec_hash": content_hash(population.spec),
                "network_fingerprint": pack.network_fingerprint, "engine": run.engine_version,
                "rules_version": population.spec.rules_version, "generator_version": population.spec.generator_version,
                "control_mode": population.spec.brains[0].control_mode, "status": run.status.value,
                "artifacts": {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                              for path in sorted(out_dir.glob("*.json")) if path.name != "manifest.json"},
            }
            run.manifest_hash = content_hash(manifest)
            atomic_json(out_dir / "manifest.json", manifest | {"manifest_hash": run.manifest_hash})
        except (OSError, ValueError, RuntimeError) as exc:
            run.status = RunStatus.failed
            run.manifest_hash = ""
            run.error = f"Population replay publication failed ({type(exc).__name__}); no complete artifact is claimed."
        finally:
            persist(run)
    return run
