from __future__ import annotations

import asyncio
import fcntl
import hashlib
import importlib.metadata
import json
import logging
import os
import time
import uuid
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from cityshift_swarm.checkpointing import (
    CheckpointStore,
    NativePersistence,
    adapter_hash,
    digest,
    verify_complete_native_journal,
)
from cityshift_swarm.contracts import (
    CheckpointBoundary,
    CheckpointResponse,
    DecisionRequest,
    DecisionResponse,
    RunRequest,
)
from cityshift_swarm.control import CONTEXT_KEY, NativeUnavailable, RunConflict, RunControl
from cityshift_swarm.prepare import CorePatchError, attest_core_patch, prepare_core
from cityshift_swarm.settings import CORE_SHA, MODEL_WINDOW_ROUNDS, SWARM_SHA, WORKFLOW_NAME, Settings

WORKFLOW_PATH = Path(__file__).with_name("population_workflow.py")


def installed_sources() -> dict[str, Any]:
    packages = {}
    verified = True
    for name, sha, version in (("workswarm", SWARM_SHA, "0.2.5b1"), ("openjiuwen", CORE_SHA, "0.1.17")):
        try:
            dist = importlib.metadata.distribution(name)
            direct = json.loads(dist.read_text("direct_url.json") or "{}")
            actual_sha = direct.get("vcs_info", {}).get("commit_id")
            packages[name] = {"version": dist.version, "sha": actual_sha, "expected_sha": sha}
            verified = verified and actual_sha == sha and dist.version == version
        except (importlib.metadata.PackageNotFoundError, ValueError):
            packages[name] = {"version": None, "sha": None, "expected_sha": sha}
            verified = False
    packages["openjiuwen"]["source_kind"] = "pinned_base_plus_reviewed_patch"
    try:
        packages["openjiuwen"]["patch"] = attest_core_patch()
    except (CorePatchError, OSError, ValueError) as exc:
        packages["openjiuwen"]["patch"] = {"verified": False, "reason": str(exc)}
        verified = False
    return {"verified": verified, "sources": packages}


@dataclass
class NativeRun:
    control: RunControl
    spec: Any
    stream_task: asyncio.Task | None = None
    workflow_task: asyncio.Task | None = None
    lifetime_task: asyncio.Task | None = None
    stop_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    cleaned: bool = False


class NativeHost:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.runs: dict[str, NativeRun] = {}
        self.create_lock = asyncio.Lock()
        self.available = False
        self.error: str | None = None
        self.startup_error: Exception | None = None
        self.manager: Any = None
        self.cleanup_tasks: set[asyncio.Task] = set()
        self.persistence = NativePersistence()
        self.checkpoints = CheckpointStore(settings)
        self.root_lock = None
        self.checkpoint_in_progress = False
        self.code_hash = adapter_hash()

    async def initialize(self) -> None:
        if (
            os.environ.get("JIUWENSWARM_DATA_DIR") != str(self.settings.root / "native")
            or os.environ.get("OPENJIUWEN_HOME") != str(self.settings.root / "core")
            or os.environ.get("HOME") != str(self.settings.root / "home")
        ):
            self.error = "runtime_environment_not_isolated"
            return
        try:
            prepare_core()
        except (CorePatchError, OSError, ValueError) as exc:
            self.startup_error = exc
            self.error = "native_patch_preparation_failed"
            return
        if not installed_sources()["verified"]:
            self.error = "native_source_pin_or_patch_mismatch"
            return
        try:
            self.root_lock = (self.settings.root / "adapter.lock").open("a+b")
            fcntl.flock(self.root_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            from openjiuwen.core.common.logging.log_config import configure_log_config

            configure_log_config({
                "backend": "default", "level": "CRITICAL", "log_path": str(self.settings.root / "logs"),
                "output": [], "interface_output": [], "performance_output": [], "propagate": False,
            })
            logging.disable(logging.CRITICAL)
            from loguru import logger

            logger.disable("openjiuwen")
            logger.disable("jiuwenswarm")
            from jiuwenswarm.agents.harness.team.team_manager import TeamManager

            from cityshift_swarm.capabilities import register_capabilities

            register_capabilities()
            self.manager = TeamManager()
            await self.persistence.initialize()
            self.available = True
        except Exception as exc:
            self.startup_error = exc
            self.error = "native_import_or_configuration_failed"
            await self.persistence.close()
            if self.root_lock is not None:
                self.root_lock.close()
                self.root_lock = None

    def health(self) -> dict[str, Any]:
        sources = installed_sources()
        return {
            "service": "cityshift-native-swarm-adapter",
            "native_available": self.available and sources["verified"],
            "reason": self.error or (None if sources["verified"] else "native_source_pin_or_patch_mismatch"),
            **sources,
            "workflow": WORKFLOW_NAME,
            "workflow_sha256": hashlib.sha256(WORKFLOW_PATH.read_bytes()).hexdigest(),
            "model_execution_verified": False,
            "max_active_runs": 1,
            "max_residents": 20,
            "tls_verification": True,
            "restart_policy": "sealed_coordinated_checkpoint_only",
            "resident_context": {
                "model_window_rounds": MODEL_WINDOW_ROUNDS,
                "durable_history": "private_native_session_checkpoint",
                "automatic_summaries": False,
                "recall": "actor_scoped_city_tools",
            },
        }

    async def require_sources(self, run_id: str | None = None) -> None:
        if not installed_sources()["verified"]:
            self.available = False
            self.error = "native_source_pin_or_patch_mismatch"
            if run_id in self.runs:
                self.runs[run_id].control.fail(self.error)
                await self.stop(run_id, failed=True)
            raise NativeUnavailable(self.error)

    async def start(self, request: RunRequest) -> dict[str, Any]:
        await self.require_sources()
        if not self.available:
            raise NativeUnavailable(self.error or "native_unavailable")
        self.settings.validate_request(request)
        async with self.create_lock:
            if self.checkpoint_in_progress:
                raise RunConflict("checkpoint_in_progress")
            if any(not run.cleaned for run in self.runs.values()):
                raise RunConflict("one_active_native_team_per_service")
            restored = None
            history = []
            if request.resume_checkpoint is not None:
                if self.runs:
                    raise RunConflict("resume_requires_fresh_service")
                restored, history = self.checkpoints.load(request)
                await self.checkpoints.restore(request, restored, self.persistence)
            elif (self.settings.root / "runs" / request.run_id).exists() or request.run_id in self.runs:
                raise RunConflict("run_id_exists_explicit_checkpoint_required")
            self.settings.write_native_config(request)
            control = RunControl(
                request, self.settings,
                restored["workflow_id"] if restored else f"wf_{uuid.uuid4().hex[:12]}",
                restored["team_session_id"] if restored else f"pop_{uuid.uuid4().hex}",
            )
            run = None
            try:
                spec = await self.manager.get_swarm_enriched_team_spec(
                    control.team_session_id,
                    mode="team",
                    project_dir=str(control.directory),
                    trusted_dirs=[],
                    channel_id="population",
                    request_metadata={"mode": "team"},
                    requested_model_name=request.models[0].model_id,
                    swarmflow_config={"enable_swarmflow": True, "swarmflow_budget": request.budget.max_tokens},
                )
                if restored is not None:
                    if spec.team_name != restored["team_id"]:
                        raise RunConflict("checkpoint_team_identity_mismatch")
                    control.restore(restored, history)
                else:
                    control.prepare(spec.team_name)
                self._restrict_spec(spec, control)
                run = NativeRun(control, spec)
                self.runs[request.run_id] = run
                from openjiuwen.core.runner import Runner

                await Runner.start()
                run.stream_task = asyncio.create_task(self._stream(run), name=f"population-team-{request.run_id}")
                async with asyncio.timeout(25):
                    await self._wait_ready(control.context_ready, run.stream_task)
                await self._build_native_team(control)
                control.status = "restoring" if restored else "running"
                if restored:
                    control.native_budget.add(restored["session_tokens_spent"])
                run.workflow_task = asyncio.create_task(self._workflow(run), name=f"population-flow-{request.run_id}")
                async with asyncio.timeout(45 if restored else 10):
                    await self._wait_ready(control.workflow_ready, run.workflow_task)
                control.status = "running"
                run.lifetime_task = asyncio.create_task(self._lifetime(run), name=f"population-limit-{request.run_id}")
                control.persist()
                return {
                    "run_id": request.run_id,
                    "status": "running",
                    "bindings": [binding.model_dump() for binding in control.bindings.values()],
                    "native_execution": "Runner/SwarmBuildContext/TeamWorkerBackend/agent_session",
                    "model_execution_verified": False,
                    "native_max_attempts_per_send": 3,
                    "generation": control.generation,
                    "resumed_checkpoint": request.resume_checkpoint,
                    "native_tokens_spent": control.native_budget.spent,
                    "restart_policy": "sealed_coordinated_checkpoint_only",
                }
            except BaseException:
                control.fail("native_startup_failed")
                if run is not None:
                    await self.stop(request.run_id, failed=True)
                else:
                    await control.close()
                raise

    def _restrict_spec(self, spec: Any, control: RunControl) -> None:
        from jiuwenswarm.agents.swarm.registry import SECURITY
        from openjiuwen.agent_teams.schema.deep_agent_spec import BuiltinToolSpec, RailSpec

        from cityshift_swarm.capabilities import BOUNDARY_PROVIDER, CITY_PROVIDER, IDENTITY_PROVIDER

        if not spec.enable_permissions or spec.lifecycle != "persistent":
            raise NativeUnavailable("unsafe_native_team_configuration")
        if spec.memory.enabled or spec.memory.shared_memory or spec.evolution_enabled:
            raise NativeUnavailable("shared_or_evolving_memory_not_allowed")
        spec.build_context.extras[CONTEXT_KEY] = control
        for role in ("leader", "teammate"):
            base = spec.agents[role]
            if SECURITY not in {rail.type for rail in base.rails} or not base.enable_security_rail:
                raise NativeUnavailable("upstream_security_rail_missing")
            additions = [RailSpec(type=IDENTITY_PROVIDER), RailSpec(type=BOUNDARY_PROVIDER)]
            tools = [BuiltinToolSpec(type=CITY_PROVIDER)] if role == "teammate" else []
            spec.agents[role] = base.model_copy(update={
                "tools": tools,
                "rails": [*base.rails, *additions],
                "workspace": None,
                "auto_create_workspace": False,
                "enable_sys_operation": False,
                "enable_skill_discovery": False,
            })

    async def _build_native_team(self, control: RunControl) -> None:
        from openjiuwen.agent_teams.context import reset_session_id, set_session_id
        from openjiuwen.agent_teams.rails.team_context import (
            get_swarmflow_budget,
            get_swarmflow_model_resolver,
            get_team_backend,
        )

        from cityshift_swarm.capabilities import hydrate_model

        backend = get_team_backend(control.context)
        resolver = get_swarmflow_model_resolver(control.context)
        control.native_budget = get_swarmflow_budget(control.context)
        if backend is None or resolver is None or control.native_budget.total != control.request.budget.max_tokens:
            raise NativeUnavailable("native_team_handles_missing")
        for model in control.request.models:
            config = resolver(model.model_id)
            if config is None:
                raise NativeUnavailable("native_model_override_unresolved")
            hydrate_model(config, control, model.model_id)
        token = set_session_id(control.team_session_id)
        try:
            await backend.build_team(
                display_name="CITYSHIFT Population",
                desc="Reviewed actor-isolated resident workflow; no city authority",
                leader_display_name="Population Controller",
                leader_desc="Infrastructure-only; model inference disabled",
            )
        finally:
            reset_session_id(token)

    async def _stream(self, run: NativeRun) -> None:
        from openjiuwen.agent_teams.context import reset_session_id, set_session_id
        from openjiuwen.core.runner import Runner

        control = run.control
        token = set_session_id(control.team_session_id)
        try:
            async for _ in Runner.run_agent_team_streaming(
                agent_team=run.spec, inputs={"query": ""}, session=control.team_session_id,
            ):
                pass
            if control.status in {"starting", "running"}:
                control.fail("native_team_stream_ended")
        except asyncio.CancelledError:
            raise
        except Exception:
            control.fail("native_team_runtime_failed")
        finally:
            reset_session_id(token)
            if control.status == "failed":
                self._schedule_cleanup(control.request.run_id)

    async def _workflow(self, run: NativeRun) -> None:
        from openjiuwen.agent_teams import paths
        from openjiuwen.agent_teams.context import reset_session_id, set_session_id
        from openjiuwen.agent_teams.rails.team_context import (
            get_messager,
            get_swarmflow_concurrency_governor,
            get_swarmflow_model_resolver,
            get_swarmflow_worker_base_spec,
        )
        from openjiuwen.agent_teams.workflow.backends.team_worker_backend import TeamWorkerBackend
        from openjiuwen.agent_teams.workflow.engine.budget import BudgetLedger
        from openjiuwen.agent_teams.workflow.engine.errors import BudgetExhausted, WorkflowAborted
        from openjiuwen.agent_teams.workflow.engine.runner import run_workflow
        from openjiuwen.agent_teams.workflow.engine.runtime import AbortSignal
        from openjiuwen.agent_teams.workflow.observer import WorkflowObserver
        from openjiuwen.core.context_engine.schema.config import ContextEngineConfig

        from cityshift_swarm.capabilities import hydrate_model

        control = run.control
        context = control.context
        governor = get_swarmflow_concurrency_governor(context)
        admission = await governor.admit_workflow()
        if admission is None:
            control.fail("native_workflow_admission_rejected")
            return
        resolver = get_swarmflow_model_resolver(context)
        models = {model.model_id for model in control.request.models}

        def checked_resolver(model_id: str | None) -> Any:
            if control.replaying:
                raise NativeUnavailable("checkpoint_journal_cache_miss_inference_forbidden")
            if model_id not in models:
                raise NativeUnavailable("unapproved_model_override")
            config = resolver(model_id)
            if config is None:
                raise NativeUnavailable("native_model_override_unresolved")
            return hydrate_model(config, control, model_id)

        control.backend = TeamWorkerBackend(
            model=context.extras["_parent_model"],
            team_name=control.team_id,
            language="en",
            max_iterations=control.request.budget.max_iterations,
            model_resolver=checked_resolver,
            worker_base_spec=get_swarmflow_worker_base_spec(context).model_copy(update={
                "context_engine_config": ContextEngineConfig(
                    default_window_round_num=MODEL_WINDOW_ROUNDS,
                    max_context_message_num=None,
                    default_window_message_num=None,
                    tokenizer_offline=True,
                    enable_tokenizer_download=False,
                    enable_openrouter_model_context_window_tokens=False,
                ),
            }),
            build_context=context,
            messager=get_messager(context),
            session_id=control.team_session_id,
            run_id=control.workflow_id,
            workflow_name=WORKFLOW_NAME,
        )
        control.abort_signal = AbortSignal()
        journal = paths.workflow_journal_path(control.team_id, control.team_session_id, WORKFLOW_NAME)
        journal.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        observer = WorkflowObserver()
        control.workflow_budget = BudgetLedger(total=control.request.budget.max_tokens)
        token = set_session_id(control.team_session_id)
        try:
            await run_workflow(
                str(WORKFLOW_PATH),
                args=control,
                backend=control.backend,
                strict=True,
                progress_sink=observer.emit,
                journal_path=str(journal),
                resume=str(journal) if control.resume_data is not None else None,
                agent_gate=admission.agent_gate,
                budget=control.native_budget,
                workflow_budget=control.workflow_budget,
                abort_event=control.abort_signal,
                run_id=control.workflow_id,
            )
        except BudgetExhausted:
            control.fail("native_token_budget_exhausted")
        except WorkflowAborted:
            if control.status == "running":
                control.fail("native_workflow_aborted")
        except asyncio.CancelledError:
            raise
        except Exception:
            control.fail("native_workflow_failed")
        finally:
            reset_session_id(token)
            await governor.release_workflow(admission.ticket)
            if control.status == "failed":
                self._schedule_cleanup(control.request.run_id)

    def _schedule_cleanup(self, run_id: str) -> None:
        task = asyncio.create_task(self.stop(run_id, failed=True), name=f"population-cleanup-{run_id}")
        self.cleanup_tasks.add(task)
        task.add_done_callback(self.cleanup_tasks.discard)

    async def _lifetime(self, run: NativeRun) -> None:
        remaining = self.settings.max_run_seconds - (time.monotonic() - run.control.created_at)
        await asyncio.sleep(max(0, remaining))
        run.control.fail("run_time_budget_exhausted")
        await self.stop(run.control.request.run_id, failed=True)

    @staticmethod
    async def _wait_ready(event: asyncio.Event, task: asyncio.Task) -> None:
        waiter = asyncio.create_task(event.wait())
        try:
            await asyncio.wait({waiter, task}, return_when=asyncio.FIRST_COMPLETED)
            if not event.is_set():
                raise NativeUnavailable("native_task_ended_before_ready")
        finally:
            waiter.cancel()
            with suppress(asyncio.CancelledError):
                await waiter

    def lookup(self, run_id: str) -> NativeRun:
        run = self.runs.get(run_id)
        if run is None:
            raise RunConflict("run_unknown_or_restart_requires_new_run")
        return run

    async def decisions(self, run_id: str, request: DecisionRequest) -> DecisionResponse:
        await self.require_sources(run_id)
        run = self.lookup(run_id)
        control = run.control
        cached = control.accept_epoch(request)
        if cached is not None:
            return cached
        if control.status != "running":
            if control.status == "failed" and not run.cleaned:
                await self.stop(run_id, failed=True)
            return control.response(request)
        work = control.begin_work(request)
        control.queue.put_nowait(work)
        try:
            async with asyncio.timeout(control.request.budget.decision_timeout_s):
                await asyncio.wait({work.result, run.workflow_task}, return_when=asyncio.FIRST_COMPLETED)
                if not work.result.done():
                    raise NativeUnavailable("native_workflow_ended")
                rows = work.result.result()
            if control.native_budget.exhausted:
                control.fail("native_token_budget_exhausted")
            if control.status == "failed":
                await self.stop(run_id, failed=True)
                if control.failure == "essential_city_tools_missing":
                    self.available = False
                    self.error = control.failure
            return control.response(request, rows)
        except asyncio.CancelledError:
            control.fail("controller_request_cancelled")
            await self.stop(run_id, failed=True)
            control.response(request)
            raise
        except Exception as exc:
            control.fail("decision_timeout" if isinstance(exc, TimeoutError) else "native_boundary_failed")
            await self.stop(run_id, failed=True)
            return control.response(request)

    async def checkpoint(self, run_id: str, boundary: CheckpointBoundary) -> CheckpointResponse:
        await self.require_sources(run_id)
        run = self.lookup(run_id)
        control = run.control
        if control.status == "checkpointed" and control.last_checkpoint is not None:
            previous = control.last_checkpoint.model_dump(include=set(CheckpointBoundary.model_fields))
            if previous != boundary.model_dump():
                raise RunConflict("checkpoint_boundary_mismatch")
            return control.last_checkpoint.model_copy(deep=True)
        if self.code_hash != adapter_hash():
            raise RunConflict("adapter_source_changed")
        if control.named_members:
            raise RunConflict("named_capability_probes_cannot_checkpoint")
        if (
            control.inflight or control.active_work is not None or control.status != "running"
            or control.last_response is None or run.cleaned
        ):
            raise RunConflict("checkpoint_requires_completed_boundary")
        if (boundary.epoch, boundary.t, boundary.world_version) != (
            control.last_epoch, control.last_t, control.last_world_version,
        ):
            raise RunConflict("checkpoint_boundary_mismatch")
        for turn in control.history:
            due = {packet["resident_id"] for packet in turn["request"]["observations"]}
            if set(turn["native_results"]) != due:
                raise RunConflict("checkpoint_requires_complete_native_journal")
        control.status = "checkpointing"
        self.checkpoint_in_progress = True
        contexts = dict(control.expected_contexts)
        try:
            await verify_complete_native_journal(control)
            for resident_id, session in control.native_sessions.items():
                context = session.get_state("context")
                if not context:
                    raise NativeUnavailable("native_private_context_missing")
                await session.commit()
                contexts[resident_id] = digest(context)
            expected = {rid for rid, binding in control.bindings.items() if binding.session_id is not None}
            if set(contexts) != expected:
                raise NativeUnavailable("native_private_context_set_incomplete")
            await self.stop(run_id, checkpoint=True)
            if control.status != "checkpointed":
                raise NativeUnavailable("native_checkpoint_quiescence_failed")
            from openjiuwen.core.session.agent import create_agent_session
            from openjiuwen.core.single_agent import AgentCard

            for resident_id, expected_hash in contexts.items():
                binding = control.bindings[resident_id]
                session = create_agent_session(
                    session_id=binding.session_id,
                    card=AgentCard(id=f"{binding.team_id}_{binding.worker_id}", name=binding.worker_id),
                )
                await session.pre_run()
                if digest(session.get_state("context")) != expected_hash:
                    raise NativeUnavailable("native_checkpoint_flush_verification_failed")
                await session.close_stream()
            from openjiuwen.agent_teams.runtime.metadata import read_team_namespace
            from openjiuwen.core.session.agent_team import Session as TeamSession

            team_session = TeamSession(session_id=control.team_session_id, source_metadata_enabled=False)
            await team_session.pre_run()
            team_state = read_team_namespace(team_session, control.team_id)
            if not team_state or not team_state.get("spec"):
                raise NativeUnavailable("native_team_checkpoint_missing")
            team_hash = digest(team_state)
            await team_session.close_stream()
            response = self.checkpoints.seal(control, boundary, contexts, team_hash)
            control.last_checkpoint = response
            control.persist()
            return response
        except BaseException:
            control.fail("native_checkpoint_failed")
            if not run.cleaned:
                await self.stop(run_id, failed=True)
            raise
        finally:
            self.checkpoint_in_progress = False

    async def stop(self, run_id: str, failed: bool = False, checkpoint: bool = False) -> dict[str, Any]:
        run = self.lookup(run_id)
        control = run.control
        async with run.stop_lock:
            if run.cleaned:
                return {"run_id": run_id, "status": control.status}
            if control.status == "checkpointing" and not checkpoint:
                raise RunConflict("checkpoint_in_progress")
            control.status = "checkpointing" if checkpoint else "stopping"
            for scope in control.scopes.values():
                scope.epoch = None
            await control.close()
            abort_signal = getattr(control, "abort_signal", None)
            if abort_signal is not None:
                abort_signal.set("pause" if checkpoint else "stop")
            try:
                async with asyncio.timeout(15):
                    if control.backend is not None:
                        await control.backend.abort_sessions()
                    if run.workflow_task is not None and not run.workflow_task.done():
                        run.workflow_task.cancel()
                        with suppress(asyncio.CancelledError):
                            await run.workflow_task
                    from openjiuwen.core.runner import Runner

                    await Runner.stop_agent_team(team_name=control.team_id, session_id=control.team_session_id)
                    if run.stream_task is not None and not run.stream_task.done():
                        run.stream_task.cancel()
                        with suppress(asyncio.CancelledError):
                            await run.stream_task
                    if await Runner.stop() is False or await Runner.list_active_teams():
                        raise NativeUnavailable("native_runner_cleanup_incomplete")
                    from openjiuwen.core.foundation.llm.model_clients.openai_model_client import OpenAIModelClient

                    await OpenAIModelClient.aclose()
            except Exception:
                control.failure = "native_cleanup_failed_restart_service_required"
                self.available = False
                self.error = control.failure
            finally:
                if run.lifetime_task is not None and run.lifetime_task is not asyncio.current_task():
                    run.lifetime_task.cancel()
                    with suppress(asyncio.CancelledError):
                        await run.lifetime_task
                terminal = "checkpointed" if checkpoint else "stopped"
                control.status = "failed" if failed or control.failure else terminal
                run.cleaned = True
                control.persist()
            return {"run_id": run_id, "status": control.status}

    async def close(self) -> None:
        for run_id in list(self.runs):
            await self.stop(run_id)
        pending = list(self.cleanup_tasks)
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        await self.persistence.close()
        if self.root_lock is not None:
            self.root_lock.close()
            self.root_lock = None
