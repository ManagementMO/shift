from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from cityshift_swarm.bridge import BridgeFailure, CityBridge, WorkerScope
from cityshift_swarm.contracts import (
    Binding,
    CheckpointResponse,
    DecisionRequest,
    DecisionResponse,
    DecisionRow,
    ResidentDecision,
    RunRequest,
    Usage,
)
from cityshift_swarm.settings import WORKFLOW_NAME, Settings

CONTEXT_KEY = "cityshift.population_control.v1"


def model_observation(packet: dict[str, Any]) -> dict[str, Any]:
    visible = deepcopy(packet)
    for key, limit in (("memories", 8), ("messages", 4)):
        if isinstance(visible.get(key), list):
            visible[key] = visible[key][-limit:]
    tasks = visible.get("tasks")
    if isinstance(tasks, list):
        state = visible.get("state") or {}
        current = state.get("current_task_id")
        commitments = set(state.get("commitments", []))
        required, own, public = [], [], []
        for task in tasks:
            task_id = task.get("task_id")
            if task_id is not None and (task_id == current or task_id in commitments):
                required.append(task)
            elif visible["resident_id"] in (task.get("requester_id"), task.get("provider_id"), task.get("assignee_id")):
                own.append(task)
            else:
                public.append(task)
        visible["tasks"] = required + (own + public)[:max(0, 8 - len(required))]
    return visible


class RunConflict(ValueError):
    pass


class NativeUnavailable(RuntimeError):
    pass


@dataclass
class EpochWork:
    request: DecisionRequest
    result: asyncio.Future
    started: float = field(default_factory=time.monotonic)
    replay: bool = False
    expected: dict[str, Any] = field(default_factory=dict)


class RunControl:
    def __init__(self, request: RunRequest, settings: Settings, workflow_id: str, session_id: str):
        self.request = request.model_copy(deep=True)
        self.settings = settings
        self.workflow_id = workflow_id
        self.team_session_id = session_id
        self.team_id = ""
        self.status = "starting"
        self.failure: str | None = None
        self.created_at = time.monotonic()
        self.roster = {resident.resident_id: resident for resident in self.request.residents}
        self.labels = {f"resident-{index}": resident for index, resident in enumerate(self.request.residents)}
        self.bindings: dict[str, Binding] = {}
        self.scopes: dict[str, WorkerScope] = {}
        self.usage: dict[str, Usage] = {}
        self.fallbacks: dict[str, str] = {}
        self.context: Any = None
        self.backend: Any = None
        self.native_budget: Any = None
        self.context_ready = asyncio.Event()
        self.workflow_ready = asyncio.Event()
        self.queue: asyncio.Queue[EpochWork | None] = asyncio.Queue(maxsize=1)
        self.active_work: EpochWork | None = None
        self.inflight = False
        self.last_epoch = -1
        self.last_t = -1
        self.last_world_version = -1
        self.last_digest: str | None = None
        self.last_response: DecisionResponse | None = None
        self.last_checkpoint: CheckpointResponse | None = None
        self.epoch_count = 0
        self.generation = 0
        self.history: list[dict[str, Any]] = []
        self.native_results: dict[str, Any] = {}
        self.native_sessions: dict[str, Any] = {}
        self.expected_contexts: dict[str, str] = {}
        self.restored_workers: set[str] = set()
        self.resume_data: dict[str, Any] | None = None
        self.replaying = False
        self.replay_index = 0
        self.replay_work: EpochWork | None = None
        self.workflow_budget: Any = None
        self.named_members: dict[str, str] = {}
        self.named_agents: dict[str, Any] = {}
        self.bridge = CityBridge(
            request.run_id, settings.city_bridge_url, settings.control_token,
            request.budget.decision_timeout_s,
        )

    def __repr__(self) -> str:
        return "PopulationWorkflowControl()"

    @property
    def directory(self) -> Path:
        return self.settings.root / "runs" / self.request.run_id

    def prepare(self, team_id: str) -> None:
        self.team_id = team_id
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=False)
        for resident in self.request.residents:
            self.bindings[resident.resident_id] = Binding(
                team_id=team_id,
                workflow_id=self.workflow_id,
                requested_model_id=resident.model_id,
            )
        self.persist()

    def restore(self, data: dict[str, Any], history: list[dict[str, Any]]) -> None:
        self.team_id = data["team_id"]
        self.resume_data = data
        self.history = history
        self.generation = data["generation"] + 1
        self.bindings = {key: Binding.model_validate(value) for key, value in data["bindings"].items()}
        if set(self.bindings) != set(self.roster):
            raise RunConflict("checkpoint_resident_bindings_mismatch")
        self.expected_contexts = dict(data["context_hashes"])
        self.last_epoch = data["boundary"]["epoch"]
        self.last_t = data["boundary"]["t"]
        self.last_world_version = data["boundary"]["world_version"]
        self.epoch_count = data["epoch_count"]
        self.last_response = DecisionResponse.model_validate(data["last_response"])
        self.created_at = time.monotonic() - data["elapsed_seconds"]
        self.replaying = True
        self.persist()

    async def next_work(self) -> EpochWork | None:
        if self.replaying and self.replay_index < len(self.history):
            saved = self.history[self.replay_index]
            self.replay_index += 1
            work = EpochWork(
                DecisionRequest.model_validate(saved["request"]), asyncio.get_running_loop().create_future(),
                replay=True, expected=saved["native_results"],
            )
            self.replay_work = work
            return work
        if self.replaying:
            spent = self.resume_data["workflow_tokens_spent"]
            if self.workflow_budget.spent > spent:
                raise NativeUnavailable("checkpoint_budget_mismatch")
            self.workflow_budget.add(spent - self.workflow_budget.spent)
            self.replaying = False
            self.replay_work = None
        self.workflow_ready.set()
        return await self.queue.get()

    def persist(self) -> None:
        data = {
            "run_id": self.request.run_id,
            "team_id": self.team_id,
            "team_session_id": self.team_session_id,
            "workflow_id": self.workflow_id,
            "workflow_name": WORKFLOW_NAME,
            "status": self.status,
            "failure": self.failure,
            "last_epoch": self.last_epoch,
            "restart_policy": "sealed_coordinated_checkpoint_only",
            "generation": self.generation,
            "last_checkpoint": self.last_checkpoint.model_dump() if self.last_checkpoint is not None else None,
            "bindings": {key: value.model_dump() for key, value in self.bindings.items()},
        }
        path = self.directory / "manifest.json"
        temp = self.directory / "manifest.tmp"
        temp.write_text(json.dumps(data, sort_keys=True))
        temp.replace(path)

    def attach_leader(self, context: Any) -> None:
        if str(context.role) != "leader" or context.team_id != self.team_id:
            raise NativeUnavailable("untrusted_leader_context")
        if self.context is not None and self.context.member_card_id != context.member_card_id:
            raise NativeUnavailable("leader_identity_changed")
        self.context = context
        self.context_ready.set()

    def resident_for_context(self, context: Any) -> str:
        if (
            context.team_id != self.team_id
            or context.member_card_id != f"{self.team_id}_{context.member_name}"
            or context.extras.get(CONTEXT_KEY) is not self
        ):
            raise NativeUnavailable("untrusted_worker_context")
        if str(context.role) == "teammate":
            resident_id = self.named_members.get(context.member_name)
            if resident_id not in self.roster:
                raise NativeUnavailable("unapproved_named_capability_probe")
            return resident_id
        match = re.fullmatch(r"wf-sess-(resident-[0-9]+)-[0-9]+", str(context.member_name))
        if str(context.role) != "worker" or match is None or match.group(1) not in self.labels:
            raise NativeUnavailable("untrusted_worker_context")
        return self.labels[match.group(1)].resident_id

    def attach_worker(self, context: Any) -> WorkerScope:
        resident_id = self.resident_for_context(context)
        binding = self.bindings[resident_id]
        if binding.worker_id is not None and binding.worker_id != context.member_name:
            raise NativeUnavailable("worker_identity_changed_reconstruction_required")
        binding.worker_id = context.member_name
        scope = self.scopes.setdefault(resident_id, WorkerScope(resident_id, context.member_name))
        if self.active_work is not None:
            due = {packet["resident_id"] for packet in self.active_work.request.observations}
            if resident_id in due:
                scope.epoch = self.active_work.request.epoch
        self.persist()
        return scope

    def record_session(self, resident_id: str, session: Any) -> None:
        from cityshift_swarm.checkpointing import digest

        session_id = session.get_session_id()
        binding = self.bindings[resident_id]
        if binding.session_id is not None and binding.session_id != session_id:
            raise NativeUnavailable("native_session_changed_reconstruction_required")
        binding.session_id = session_id
        if resident_id in self.expected_contexts and resident_id not in self.restored_workers:
            if digest(session.get_state("context")) != self.expected_contexts[resident_id]:
                self.fail("native_private_context_restore_mismatch")
                raise NativeUnavailable("native_private_context_restore_mismatch")
            self.restored_workers.add(resident_id)
        self.native_sessions[resident_id] = session
        self.persist()

    def active_scope(self, resident_id: str) -> WorkerScope:
        scope = self.scopes.get(resident_id)
        work = self.active_work
        if (
            self.status != "running" or scope is None or work is None
            or scope.epoch != work.request.epoch
            or resident_id not in self.usage
            or time.monotonic() - work.started >= self.request.budget.decision_timeout_s
        ):
            raise BridgeFailure("inactive_worker")
        return scope

    def record_model_call(self, resident_id: str) -> bool:
        self.active_scope(resident_id)
        usage = self.usage[resident_id]
        if usage.model_calls >= self.request.budget.max_iterations:
            self.fallbacks[resident_id] = "iteration_budget_exhausted"
            return False
        usage.model_calls += 1
        return True

    def record_usage(self, resident_id: str, response: Any) -> None:
        usage = self.usage.get(resident_id)
        if usage is None:
            return
        reported = getattr(response, "usage_metadata", None)
        if reported is None:
            usage.usage_missing = True
            return
        incoming = max(0, int(getattr(reported, "input_tokens", 0) or 0))
        outgoing = max(0, int(getattr(reported, "output_tokens", 0) or 0))
        total = max(0, int(getattr(reported, "total_tokens", 0) or incoming + outgoing))
        usage.reported_model_calls += 1
        usage.input_tokens += incoming
        usage.output_tokens += outgoing
        usage.total_tokens += total
        if total == 0:
            usage.usage_missing = True

    def accept_epoch(self, request: DecisionRequest) -> DecisionResponse | None:
        if self.status in {"checkpointing", "checkpointed", "restoring"}:
            raise RunConflict("native_run_sealed_or_restoring")
        encoded = json.dumps(request.model_dump(), sort_keys=True, separators=(",", ":"), allow_nan=False)
        digest = hashlib.sha256(encoded.encode()).hexdigest()
        if request.epoch == self.last_epoch and digest == self.last_digest and self.last_response is not None:
            return self.last_response.model_copy(deep=True)
        if self.inflight:
            raise RunConflict("decision_boundary_already_active")
        if (
            request.epoch <= self.last_epoch or request.t < self.last_t
            or request.world_version < self.last_world_version
        ):
            raise RunConflict("stale_or_out_of_order_boundary")
        for packet in request.observations:
            if packet.get("run_id") != self.request.run_id or packet["resident_id"] not in self.roster:
                raise RunConflict("observation_scope_mismatch")
        if self.epoch_count >= self.settings.max_epochs:
            self.fail("epoch_budget_exhausted")
        if time.monotonic() - self.created_at >= self.settings.max_run_seconds:
            self.fail("run_time_budget_exhausted")
        self.inflight = True
        self.last_epoch = request.epoch
        self.last_t = request.t
        self.last_world_version = request.world_version
        self.last_digest = digest
        self.epoch_count += 1
        self.usage = {packet["resident_id"]: Usage() for packet in request.observations}
        self.fallbacks = {}
        self.native_results = {}
        self.persist()
        return None

    def begin_work(self, request: DecisionRequest) -> EpochWork:
        work = EpochWork(request.model_copy(deep=True), asyncio.get_running_loop().create_future())
        self.active_work = work
        for packet in request.observations:
            scope = self.scopes.get(packet["resident_id"])
            if scope is not None:
                scope.epoch = request.epoch
        return work

    async def decide_one(self, session: Any, packet: dict[str, Any]) -> DecisionRow:
        resident_id = packet["resident_id"]
        started = time.monotonic()
        decision = None
        reason = None
        try:
            prompt = json.dumps({
                "observation": model_observation(packet),
                "instruction": (
                    "Decide only for yourself using this immutable observation and your own recent turns. "
                    "Your model-visible dialogue is bounded; recall_experience retrieves your actor-scoped city "
                    "memories, not the entire archived native transcript. "
                    "This model-visible snapshot contains only the most recent 8 memories and 4 messages, and up to "
                    "8 task-board entries unless current/committed tasks require more; those are never omitted. "
                    "Own tasks precede public entries. "
                    "Absence here does not mean absence from the complete actor-scoped snapshot: "
                    "use recall_experience, "
                    "view_tasks, or estimate_trip for omitted history, tasks, or estimates when needed. "
                    "The supplied observation is already available; do not call observe_local_state or view_tasks "
                    "solely to reread its facts. Use city tools for additional scoped retrieval or estimates "
                    "when needed. "
                    "Choose your own eligible action, stage its JSON object with propose_action, then call "
                    "structured_output with the same proposal as a nested JSON object, not a string, Python repr, "
                    "or plain prose. Format-only proposal example: "
                    '{"action":"wait","duration_s":30,"idempotency_key":"fresh-epoch-key"}. '
                    "Choose your own action and key, not the example key. travel/request_service target_id uses an "
                    "accessible anchor_id; accept/decline/prepare/pickup/deliver/visit/serve/report_delay/"
                    "revise_commitment "
                    "uses an actual visible task_id; message uses a known contact's resident_id. "
                    "Proposals are not committed world outcomes. Do not invent completion or advance city time."
                ),
            }, sort_keys=True, allow_nan=False)
            result = await session.send(prompt, schema=ResidentDecision)
            native_value = result.model_dump() if isinstance(result, ResidentDecision) else None
            if self.replaying:
                expected = self.replay_work.expected
                if resident_id not in expected or native_value != expected[resident_id]:
                    raise NativeUnavailable("checkpoint_journal_replay_mismatch")
                return DecisionRow(
                    resident_id=resident_id, decision=result, binding=self.bindings[resident_id],
                    fallback_reason="native_journaled_failure" if result is None else None,
                )
            self.native_results[resident_id] = native_value
            if result is None:
                reason = self.fallbacks.get(resident_id, "native_turn_failed_or_no_structured_result")
            else:
                decision = ResidentDecision.model_validate(result)
                scope = self.active_scope(resident_id)
                await self.bridge.call(scope, "propose_action", decision.proposal.model_dump(exclude_none=True))
        except asyncio.CancelledError:
            raise
        except Exception:
            if self.replaying:
                raise
            reason = self.fallbacks.get(resident_id, "native_or_bridge_failure")
            decision = None
        finally:
            if resident_id in self.usage:
                self.usage[resident_id].latency_ms = int((time.monotonic() - started) * 1000)
        return DecisionRow(
            resident_id=resident_id,
            decision=decision,
            binding=self.bindings[resident_id].model_copy(deep=True),
            fallback_reason=reason,
            usage=self.usage[resident_id].model_copy(deep=True),
        )

    def response(self, request: DecisionRequest, rows: list[DecisionRow] | None = None) -> DecisionResponse:
        for usage in self.usage.values():
            usage.usage_missing = usage.usage_missing or usage.model_calls > usage.reported_model_calls
        if rows is None:
            rows = [DecisionRow(
                resident_id=packet["resident_id"],
                binding=self.bindings[packet["resident_id"]].model_copy(deep=True),
                fallback_reason=self.failure or ("run_stopped" if self.status == "stopped" else "native_unavailable"),
                usage=self.usage.get(packet["resident_id"], Usage()).model_copy(deep=True),
            ) for packet in request.observations]
        if [row.resident_id for row in rows] != [packet["resident_id"] for packet in request.observations]:
            raise NativeUnavailable("native_result_cardinality_mismatch")
        for row in rows:
            if row.resident_id in self.usage:
                row.usage = self.usage[row.resident_id].model_copy(deep=True)
        response = DecisionResponse(
            run_id=self.request.run_id,
            epoch=request.epoch,
            decisions=rows,
            native_tokens_spent=int(self.native_budget.spent) if self.native_budget is not None else 0,
            generation=self.generation,
        )
        self.history.append({"request": request.model_dump(), "native_results": dict(self.native_results)})
        self.last_response = response.model_copy(deep=True)
        self.active_work = None
        self.inflight = False
        for scope in self.scopes.values():
            scope.epoch = None
        self.persist()
        return response

    def fail(self, reason: str) -> None:
        self.failure = self.failure or reason
        if self.status != "stopped":
            self.status = "failed"
        for scope in self.scopes.values():
            scope.epoch = None
        if self.directory.exists():
            self.persist()

    async def close(self) -> None:
        for scope in self.scopes.values():
            scope.epoch = None
            scope.capability = None
        await self.bridge.close()
