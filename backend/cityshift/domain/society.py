from __future__ import annotations

import hashlib
import math
from collections import Counter
from collections.abc import Iterable
from copy import deepcopy
from typing import Any, Literal, Protocol

from cityshift.contracts import (
    ActionIntent,
    ActivityAnchor,
    MemoryEntry,
    MobilityBinding,
    PopulationArtifact,
    PopulationDecisionRecord,
    PopulationDefinition,
    PopulationEvent,
    PopulationMetrics,
    ResidentDecision,
    ResidentSnapshot,
    SocialMessage,
    SocietyTask,
    SwarmBinding,
    TaskSnapshot,
    TravelClass,
    content_hash,
)
from cityshift.domain.population_checkpoint_state import PendingActivity, PendingKind, SavedSociety
from cityshift.transport.population import MobilityOutcome

TERMINAL_TASKS = frozenset({"completed", "declined", "failed", "expired"})
ActivityKind = Literal["prepare", "pickup", "deliver", "serve"]


class Mobility(Protocol):
    def estimate_trip(self, origin: ActivityAnchor, destination: ActivityAnchor, travel_class: TravelClass) -> dict: ...
    def start_trip(self, resident_id: str, origin: ActivityAnchor, destination: ActivityAnchor,
                   travel_class: TravelClass) -> str: ...


class SocietyWorld:
    def __init__(self, run_id: str, definition: PopulationDefinition, mobility: Mobility):
        self.run_id = run_id
        self.definition = definition.model_copy(deep=True)
        self.mobility = mobility
        self.profiles = {p.resident_id: p.model_copy(deep=True) for p in self.definition.profiles}
        self.states = {s.resident_id: s.model_copy(deep=True) for s in self.definition.initial_states}
        self.tasks = {task.task_id: task.model_copy(deep=True) for task in self.definition.initial_tasks}
        self.anchors = {a.anchor_id: a.model_copy(deep=True) for a in self.definition.anchors}
        if set(self.profiles) != set(self.states) or set(self.states) != set(definition.assignments):
            raise ValueError("population identities, initial states, and brains must match")
        self.t = 0
        self.version = 0
        self.epoch = 0
        self.events: list[PopulationEvent] = []
        self.messages: list[SocialMessage] = []
        self.decisions: list[PopulationDecisionRecord] = []
        self.mobility_bindings: list[MobilityBinding] = []
        self.swarm_bindings: list[SwarmBinding] = []
        self.state_history: list[ResidentSnapshot] = []
        self.task_history: list[TaskSnapshot] = []
        self.completed_trips = 0
        self.failed_trips = 0
        self._state_hashes: dict[str, str] = {}
        self._task_hashes: dict[str, str] = {}
        self._pending: dict[str, tuple[PendingKind, int, str | None, str | None]] = {}
        self._trip_causes: dict[str, str | None] = {}
        self._task_causes: dict[str, str] = {}
        self._decision_ids: list[str] | None = None
        self._decision_version = 0
        self._observation_refs: dict[str, set[str]] = {}
        self._seen_intents: set[tuple[str, str]] = set()
        self._records: dict[str, PopulationDecisionRecord] = {}
        self._dirty_residents = set(self.states)
        self._dirty_tasks = set(self.tasks)
        for rid, state in self.states.items():
            if state.anchor_id not in self.anchors:
                raise ValueError("resident starts at an unknown anchor")
            self._bind_stationary(rid)
        self._snapshot()

    def _snapshot(self) -> None:
        for rid in sorted(self._dirty_residents):
            state = self.states[rid]
            digest = content_hash(state)
            if self._state_hashes.get(rid) != digest:
                self.state_history.append(ResidentSnapshot(t=self.t, state=state.model_copy(deep=True)))
                self._state_hashes[rid] = digest
        for tid in sorted(self._dirty_tasks):
            task = self.tasks[tid]
            digest = content_hash(task)
            if self._task_hashes.get(tid) != digest:
                self.task_history.append(TaskSnapshot(t=self.t, task=task.model_copy(deep=True)))
                self._task_hashes[tid] = digest
        self._dirty_residents.clear()
        self._dirty_tasks.clear()

    def _emit(self, kind: str, residents: list[str], text: str, task: SocietyTask | None = None,
              cause: str | None = None, status: Literal["proposed", "committed", "observed"] = "committed") -> str:
        participants = sorted({r for r in residents if r in self.states})
        self._dirty_residents.update(participants)
        if task is not None:
            self._dirty_tasks.add(task.task_id)
            task.version += 1
        event_id = f"{self.run_id}:event:{len(self.events) + 1}"
        self.events.append(PopulationEvent(event_id=event_id, t=self.t, epoch=self.epoch, kind=kind,
                                           resident_ids=participants, task_id=task.task_id if task else None,
                                           cause_id=cause, text=text[:600], status=status))
        for rid in participants:
            state = self.states[rid]
            state.memories.append(MemoryEntry(event_id=event_id, t=self.t,
                                               kind="outcome" if status == "committed" else "observation",
                                               text=text[:600], related_residents=[p for p in participants if p != rid]))
            state.memories = state.memories[-64:]
            state.version += 1
            for other in participants:
                if other != rid:
                    state.relationships.setdefault(other, 0.5)
            if kind in {"service_accepted", "task_ready", "task_completed", "task_failed", "message_received",
                        "recipient_absent", "report_delay", "revise_commitment", "recurring_need"}:
                self._wake(rid)
            elif state.busy_until_s <= self.t and state.activity != "traveling" and state.anchor_id in self.anchors:
                state.next_decision_s = min(state.next_decision_s, self.t)
        if task is not None and kind not in {"activity_waiting", "recipient_absent", "delivery_delayed"}:
            self._wake_roles(task)
        if cause in self._records:
            self._records[cause].outcome_event_ids.append(event_id)
        return event_id

    @staticmethod
    def _participants(task: SocietyTask) -> list[str]:
        return [rid for rid in (task.requester_id, task.provider_id, task.assignee_id) if rid is not None]

    def _contacts(self, rid: str) -> list[str]:
        return sorted(set(self.profiles[rid].contacts) | set(self.states[rid].relationships))

    def _task_visible(self, rid: str, task: SocietyTask) -> bool:
        profile = self.profiles[rid]
        return rid in self._participants(task) or (task.status not in TERMINAL_TASKS and (
            ("shop_worker" in profile.roles and task.kind == "delivery"
             and profile.work_anchor_id == task.service_anchor_id)
            or ("service_worker" in profile.roles and task.kind == "visit"
                and profile.work_anchor_id == task.service_anchor_id)
            or (any(role in profile.roles for role in ("courier", "driver"))
                and task.kind == "delivery" and task.status == "ready")
        ))

    def _visible_tasks(self, rid: str) -> list[SocietyTask]:
        visible = [task for task in self.tasks.values() if self._task_visible(rid, task)]
        state = self.states[rid]
        selected = sorted(visible, key=lambda task: (
            task.task_id == state.current_task_id, task.task_id in state.commitments, task.created_s, task.task_id,
        ))[-32:]
        return sorted(selected, key=lambda task: (task.created_s, task.task_id))

    def _accessible(self, rid: str, tasks: list[SocietyTask] | None = None) -> set[str]:
        profile = self.profiles[rid]
        ids = {profile.home_anchor_id, *(a.anchor_id for a in self.anchors.values()
                                       if a.purpose in {"shop", "service", "rest", "work"})}
        if profile.work_anchor_id:
            ids.add(profile.work_anchor_id)
        for task in self._visible_tasks(rid) if tasks is None else tasks:
            ids.add(task.service_anchor_id)
            if rid in self._participants(task) or task.status == "ready":
                ids.add(task.destination_anchor_id)
        return ids

    def available_classes(self, rid: str) -> list[TravelClass]:
        state = self.states[rid]
        if state.anchor_id not in self.anchors:
            return []
        return [kind for kind in self.profiles[rid].available_classes
                if kind == "pedestrian" or state.vehicle_locations.get(kind) == state.anchor_id]

    def _estimate_trip(self, origin_id: str, target_id: str, kind: TravelClass,
                       estimates: dict[tuple[str, str, TravelClass], dict] | None = None) -> dict:
        key = (origin_id, target_id, kind)
        if estimates is not None and key in estimates:
            return estimates[key]
        try:
            option = self.mobility.estimate_trip(self.anchors[origin_id], self.anchors[target_id], kind)
        except ValueError:
            option = {"target_id": target_id, "travel_class": kind, "reachable": False, "reason": "route unavailable"}
        if estimates is not None:
            estimates[key] = option
        return option

    def observation(self, rid: str) -> dict[str, Any]:
        return self._observation(rid, {})

    def _observation(self, rid: str, estimates: dict[tuple[str, str, TravelClass], dict]) -> dict[str, Any]:
        state = self.states[rid]
        tasks = self._visible_tasks(rid)
        accessible = self._accessible(rid, tasks)
        visible_anchors = [a for aid, a in self.anchors.items() if aid in accessible]
        classes = self.available_classes(rid)
        trip_options = []
        if state.anchor_id in self.anchors:
            for anchor in visible_anchors:
                if anchor.anchor_id == state.anchor_id:
                    continue
                for kind in classes:
                    trip_options.append(deepcopy(self._estimate_trip(state.anchor_id, anchor.anchor_id, kind, estimates)))
        activity_options = []
        current = self.tasks.get(state.current_task_id or "")
        activity = self._next_activity(current) if current is not None else None
        if current is not None and activity is not None:
            owner = current.assignee_id if activity in {"pickup", "deliver"} else current.provider_id
            if owner == rid:
                error = self._activity_error(current, activity)
                activity_options.append({"task_id": current.task_id, "action": activity,
                                         "eligible": error is None, "reason": error})
        memories = [m.model_dump(mode="json") for m in state.memories if m.t <= self.t][-64:]
        return {
            "run_id": self.run_id, "resident_id": rid, "epoch": self.epoch, "world_version": self.version,
            "t": self.t, "observation_id": f"observation:{self.epoch}:{rid}",
            "profile": self.profiles[rid].model_dump(mode="json"),
            "state": state.model_dump(mode="json", exclude={"memories"}),
            "memories": memories, "contacts": self._contacts(rid),
            "tasks": [task.model_dump(mode="json") for task in tasks],
            "messages": [m.model_dump(mode="json") for m in self.messages if m.sent_s <= self.t and (
                m.sender_id == rid or (m.recipient_id == rid and m.delivered_s is not None and m.delivered_s <= self.t)
            )][-24:],
            "anchors": [a.model_dump(mode="json") for a in visible_anchors], "trip_options": trip_options,
            "available_classes": classes, "activity_options": activity_options,
            "scheduling_policy": "event-driven-after-empty-wait-v1",
        }

    def record_swarm_binding(self, binding: SwarmBinding) -> None:
        if (binding.run_id != self.run_id or binding.resident_id not in self.states
                or binding.requested_model_id != self.definition.assignments[binding.resident_id].model_id):
            raise ValueError("swarm binding does not match the authoritative population")
        previous = next((item for item in reversed(self.swarm_bindings) if item.resident_id == binding.resident_id), None)
        if previous is not None and previous.model_dump(exclude={"bound_s"}) == binding.model_dump(exclude={"bound_s"}):
            return
        self.swarm_bindings.append(binding.model_copy(update={"bound_s": self.t}, deep=True))

    def align_epoch(self) -> dict[str, int]:
        if self._decision_ids is not None:
            raise ValueError("checkpoint cannot overlap an active decision epoch")
        self.epoch += 1
        return {"epoch": self.epoch, "t": self.t, "world_version": self.version}

    def checkpoint_state(self) -> dict[str, Any]:
        if self._decision_ids is not None:
            raise ValueError("checkpoint requires a completed decision epoch")
        self._snapshot()
        saved = SavedSociety(
            run_id=self.run_id, population_id=self.definition.population_id,
            definition_hash=hashlib.sha256(self.definition.model_dump_json().encode()).hexdigest(),
            t=self.t, world_version=self.version, epoch=self.epoch, states=self.states, tasks=self.tasks,
            events=self.events, messages=self.messages, decisions=self.decisions,
            mobility_bindings=self.mobility_bindings, swarm_bindings=self.swarm_bindings,
            state_history=self.state_history, task_history=self.task_history,
            pending={rid: PendingActivity.model_validate({"kind": item[0], "until_s": item[1],
                     "task_id": item[2], "cause_id": item[3]}) for rid, item in self._pending.items()},
            trip_causes=self._trip_causes, task_causes=self._task_causes, seen_intents=sorted(self._seen_intents),
            completed_trips=self.completed_trips, failed_trips=self.failed_trips,
        )
        return saved.model_dump(mode="json")

    @classmethod
    def from_checkpoint(cls, run_id: str, definition: PopulationDefinition, mobility: Mobility,
                        data: dict[str, Any]) -> SocietyWorld:
        saved = SavedSociety.model_validate(data)
        expected = hashlib.sha256(definition.model_dump_json().encode()).hexdigest()
        ids = {profile.resident_id for profile in definition.profiles}
        if (saved.run_id != run_id or saved.population_id != definition.population_id or saved.definition_hash != expected
                or set(saved.states) != ids or saved.t > definition.spec.horizon_s):
            raise ValueError("checkpoint population, run, or time mismatch")
        if any(key != state.resident_id for key, state in saved.states.items()):
            raise ValueError("checkpoint resident identity mismatch")
        if any(key != task.task_id or set(cls._participants(task)) - ids for key, task in saved.tasks.items()):
            raise ValueError("checkpoint task identity mismatch")
        if (set(saved.pending) - ids or any(rid not in ids for rid, _ in saved.seen_intents)
                or any(record.resident_id not in ids or record.t > saved.t for record in saved.decisions)
                or any(event.t > saved.t or set(event.resident_ids) - ids for event in saved.events)
                or any(memory.t > saved.t for state in saved.states.values() for memory in state.memories)
                or any(item.t > saved.t or item.state.resident_id not in ids for item in saved.state_history)
                or any(item.t > saved.t for item in saved.task_history)
                or any(message.sender_id not in ids or message.recipient_id not in ids or message.sent_s > saved.t
                       or (message.delivered_s is not None and message.delivered_s > saved.t) for message in saved.messages)):
            raise ValueError("checkpoint contains invalid identities or future records")
        anchors = {anchor.anchor_id for anchor in definition.anchors}
        for rid, state in saved.states.items():
            active = [b for b in saved.mobility_bindings if b.resident_id == rid and b.end_s is None]
            if len(active) > 1 or (state.anchor_id is not None and state.anchor_id not in anchors):
                raise ValueError("checkpoint contains conflicting or unknown presence")
            if state.activity == "traveling":
                if len(active) != 1 or not active[0].measured or state.anchor_id is not None or state.destination_id not in anchors:
                    raise ValueError("checkpoint travel body mismatch")
            elif state.anchor_id is not None and (
                len(active) != 1 or active[0].measured or active[0].anchor_id != state.anchor_id
            ):
                raise ValueError("checkpoint abstract presence mismatch")
            if set(state.commitments) - set(saved.tasks) or (state.current_task_id and state.current_task_id not in saved.tasks):
                raise ValueError("checkpoint commitment references an unknown task")
        if any(item.until_s < saved.t or (item.task_id and item.task_id not in saved.tasks) for item in saved.pending.values()):
            raise ValueError("checkpoint contains an invalid pending activity")
        saved.validate_consistency(definition)
        world = cls(run_id, definition, mobility)
        world.t, world.version, world.epoch = saved.t, saved.world_version, saved.epoch
        world.states, world.tasks = saved.states, saved.tasks
        world.events, world.messages, world.decisions = saved.events, saved.messages, saved.decisions
        world.mobility_bindings, world.swarm_bindings = saved.mobility_bindings, saved.swarm_bindings
        world.state_history, world.task_history = saved.state_history, saved.task_history
        world._pending = {rid: (item.kind, item.until_s, item.task_id, item.cause_id) for rid, item in saved.pending.items()}
        world._trip_causes, world._task_causes = saved.trip_causes, saved.task_causes
        world._seen_intents = set(saved.seen_intents)
        world.completed_trips, world.failed_trips = saved.completed_trips, saved.failed_trips
        world._records = {record.decision_id: record for record in world.decisions}
        world._state_hashes = {rid: content_hash(state) for rid, state in world.states.items()}
        world._task_hashes = {tid: content_hash(task) for tid, task in world.tasks.items()}
        world._dirty_residents.clear()
        world._dirty_tasks.clear()
        return world

    def due_residents(self) -> list[str]:
        return sorted(rid for rid, state in self.states.items()
                      if state.next_decision_s <= self.t and state.busy_until_s <= self.t
                      and state.activity != "traveling" and state.anchor_id in self.anchors)

    def begin_epoch(self, resident_ids: list[str] | None = None) -> list[dict[str, Any]]:
        if self._decision_ids is not None:
            raise ValueError("decision epoch already active")
        due = self.due_residents()
        if resident_ids is not None:
            if set(resident_ids) - set(due):
                raise ValueError("resident is not eligible for this decision epoch")
            due = sorted(set(resident_ids))
        if not due:
            return []
        self.epoch += 1
        self._decision_ids = due
        self._decision_version = self.version
        estimates: dict[tuple[str, str, TravelClass], dict] = {}
        observations = [self._observation(rid, estimates) for rid in due]
        self._observation_refs = {item["resident_id"]: {
            item["observation_id"], *(memory["event_id"] for memory in item["memories"]),
        } for item in observations}
        return observations

    def validate_intent(self, intent: ActionIntent) -> str | None:
        if intent.run_id != self.run_id or intent.resident_id not in self.states:
            return "wrong run or resident identity"
        if self._decision_ids is None or intent.resident_id not in self._decision_ids or intent.epoch != self.epoch:
            return "inactive or stale decision epoch"
        if intent.world_version != self._decision_version:
            return "stale world version"
        if intent.effective_t != self.t or intent.expires_t < self.t:
            return "intent outside its simulated time window"
        if (intent.resident_id, intent.idempotency_key) in self._seen_intents:
            return "duplicate submission"
        if set(intent.observation_refs) - self._observation_refs.get(intent.resident_id, set()):
            return "unknown or private supporting observation"
        return None

    def commit_decisions(self, results: dict[str, ResidentDecision | None], *,
                         source: Literal["rules", "jiuwenswarm"], failures: dict[str, str] | None = None,
                         bindings: dict[str, SwarmBinding] | None = None,
                         usage: dict[str, dict[str, int | float | str]] | None = None,
                         staged_messages: list[ActionIntent] | None = None,
                         rejections: dict[str, str] | None = None,
                         staged_intents: list[ActionIntent] | None = None) -> list[PopulationDecisionRecord]:
        if self._decision_ids is None:
            raise ValueError("no active decision epoch")
        if set(results) - set(self._decision_ids):
            raise ValueError("unexpected resident decision")
        records = []
        for rid in self._decision_ids:
            brain = self.definition.assignments[rid]
            choice = results.get(rid)
            binding = (bindings or {}).get(rid)
            failure = (failures or {}).get(rid)
            valid_binding = (source == brain.control_mode == "jiuwenswarm" and binding is not None
                             and binding.run_id == self.run_id and binding.resident_id == rid
                             and binding.requested_model_id == brain.model_id and bool(binding.resolved_model_id))
            if valid_binding and binding is not None:
                self.record_swarm_binding(binding)
            if choice is not None and source == "jiuwenswarm" and not valid_binding:
                choice, failure = None, "missing or invalid native swarm provenance"
            if choice is not None and source != brain.control_mode:
                choice, failure = None, "decision source does not match assigned control mode"
            did = f"{self.run_id}:decision:{self.epoch}:{rid}"
            record = PopulationDecisionRecord(
                decision_id=did, resident_id=rid, t=self.t, epoch=self.epoch,
                source=source if choice is not None else "fallback", assigned_model_id=brain.model_id,
                actual_model_id=binding.resolved_model_id if source == "jiuwenswarm" and binding and choice is not None else None,
                summary=choice.summary if choice else "No usable model decision; retain a valid commitment or wait.",
                fallback_reason=None if choice else failure or "resident decision unavailable",
                plan=list(choice.plan) if choice else list(self.states[rid].plan),
                beliefs=list(choice.beliefs) if choice else list(self.states[rid].beliefs),
                usage=(usage or {}).get(rid, {}),
            )
            records.append(record)
            self.decisions.append(record)
            self._records[did] = record
            state = self.states[rid]
            self._dirty_residents.add(rid)
            state.last_decision_s = self.t
            state.fallback_reason = record.fallback_reason
            if choice is None:
                record.reason = record.fallback_reason or "unavailable"
                for proposed in staged_intents if staged_intents is not None else staged_messages or []:
                    if proposed.resident_id != rid:
                        continue
                    if record.proposal is None and self.validate_intent(proposed) is None:
                        record.proposal = proposed.model_copy(deep=True)
                    self._emit("message_rejected" if proposed.action == "message" else "action_rejected", [rid],
                               f"Staged {proposed.action} was not committed because the decision did not complete.",
                               cause=did, status="observed")
                state.activity = "waiting"
                state.busy_until_s = self.t + max(60, self.definition.spec.decision_interval_s)
                state.next_decision_s = state.busy_until_s
                self._pending[rid] = ("wait", state.busy_until_s, None, did)
                continue
            intent = ActionIntent(**choice.proposal.model_dump(), run_id=self.run_id, resident_id=rid,
                                  epoch=self.epoch, world_version=self._decision_version,
                                  effective_t=self.t, expires_t=self.t)
            record.proposal = intent
            reason = self.validate_intent(intent) or (rejections or {}).get(rid)
            if reason is None:
                self._seen_intents.add((rid, intent.idempotency_key))
                reason = self._apply(intent, did)
            record.accepted = reason is None
            record.reason = reason or "accepted; physical and service outcomes remain separately validated"
            if reason:
                self._emit("action_rejected", [rid], f"Proposed {intent.action} rejected: {reason}", cause=did,
                           status="observed")
            else:
                state.plan = list(choice.plan) or state.plan
                state.beliefs = list(choice.beliefs)
            for message in staged_messages or []:
                if message.resident_id != rid or message.action != "message" or message.idempotency_key == intent.idempotency_key:
                    continue
                message_error = self.validate_intent(message)
                if message_error is None:
                    self._seen_intents.add((rid, message.idempotency_key))
                    message_error = self._apply(message, did)
                if message_error:
                    self._emit("message_rejected", [rid], f"Staged message rejected: {message_error}", cause=did, status="observed")
            state.next_decision_s = max(state.next_decision_s, self.t + self.definition.spec.decision_interval_s)
        self._decision_ids = None
        self._observation_refs.clear()
        self.version += 1
        self._snapshot()
        return records

    def _travel_error(self, rid: str, target: str | None, kind: TravelClass | None,
                      task: SocietyTask | None = None, activity: ActivityKind | None = None,
                      estimates: dict[tuple[str, str, TravelClass], dict] | None = None) -> str | None:
        state = self.states[rid]
        if target not in self._accessible(rid) or target not in self.anchors:
            return "destination is not an accessible anchor"
        if state.anchor_id not in self.anchors or state.activity == "traveling":
            return "resident already traveling or without a known access anchor"
        if kind not in self.available_classes(rid):
            return "transport class unavailable here or not owned"
        origin, destination = self.anchors[state.anchor_id], self.anchors[target]
        if kind not in origin.access or kind not in destination.access:
            return "travel class lacks anchor access"
        arrival = self.t
        if origin.anchor_id != destination.anchor_id:
            option = self._estimate_trip(origin.anchor_id, destination.anchor_id, kind, estimates)
            if not option.get("reachable"):
                return "route unavailable for the selected origin, destination, and class"
            duration = option.get("duration_s")
            if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration < 0:
                return "route estimate has no valid duration"
            arrival += math.ceil(duration)
        if task is not None and activity is not None:
            return self._window_error(task, activity, arrival)
        return None

    def _class_for(self, rid: str, requested: TravelClass | None = None) -> TravelClass:
        if requested is not None:
            return requested
        available = self.available_classes(rid)
        return available[-1] if available else "pedestrian"

    def _apply(self, intent: ActionIntent, cause: str) -> str | None:
        rid, action = intent.resident_id, intent.action
        state, profile = self.states[rid], self.profiles[rid]
        task = self.tasks.get(intent.target_id or "")
        if (state.activity == "traveling" or state.busy_until_s > self.t) and action not in {
            "message", "report_delay", "revise_commitment",
        }:
            return "resident is occupied by an authoritative activity"
        if action in {"wait", "rest"}:
            if action == "rest" and state.current_task_id:
                return "revise or release the current commitment before resting"
            state.activity = "resting" if action == "rest" else "waiting"
            state.busy_until_s = self.t + intent.duration_s
            state.next_decision_s = state.busy_until_s
            self._pending[rid] = (action, state.busy_until_s, None, cause)
            self._emit(action, [rid], f"{action} at the declared anchor for {intent.duration_s} seconds.", cause=cause)
            return None
        if action == "message":
            if intent.target_id not in self._contacts(rid) or not intent.text.strip():
                return "message needs an eligible contact and nonempty text"
            self.messages.append(SocialMessage(message_id=f"message-{len(self.messages) + 1}", sender_id=rid,
                                               recipient_id=intent.target_id, sent_s=self.t, text=intent.text, cause_id=cause))
            self._emit("message_sent", [rid], f"Message proposed for delivery to {intent.target_id}: {intent.text}", cause=cause)
            return None
        if action == "travel":
            if state.current_task_id:
                return "current commitment owns the travel plan; revise it first"
            kind = self._class_for(rid, intent.travel_class)
            error = self._travel_error(rid, intent.target_id, kind)
            if error:
                return error
            self._travel(rid, str(intent.target_id), kind, cause)
            return None
        if action == "request_service":
            request_kind = intent.request_kind
            anchor = self.anchors.get(intent.target_id or "")
            if request_kind is None or anchor is None or anchor.purpose != ("shop" if request_kind == "delivery" else "service"):
                return "request needs a compatible declared service anchor"
            if state.anchor_id is None or not anchor.opens_s <= self.t < anchor.closes_s:
                return "request location or service availability invalid"
            if any(t.requester_id == rid and t.kind == request_kind and t.status not in TERMINAL_TASKS for t in self.tasks.values()):
                return "an unfulfilled request of this kind already exists"
            tid = f"request-{rid}-{len(self.tasks) + 1:05d}"
            new_task = SocietyTask(task_id=tid, kind=request_kind, requester_id=rid, service_anchor_id=anchor.anchor_id,
                                   destination_anchor_id=profile.home_anchor_id, created_s=self.t,
                                   deadline_s=self.t + max(600, int(profile.preferences["patience_s"]) * 3), cause_id=cause)
            self.tasks[tid] = new_task
            state.needs[request_kind] = 1
            state.commitments.append(tid)
            self._emit("request_created", [rid], f"Created {request_kind} request {tid}.", new_task, cause)
            self._wake_roles(new_task)
            return None
        if task is None:
            return "unknown task"
        if task.status in TERMINAL_TASKS:
            return "task is already terminal"
        if self.t > task.deadline_s:
            return "task deadline passed"
        if action == "accept":
            if state.current_task_id:
                return "resident already has an active service or transport commitment"
            if rid == task.requester_id:
                return "request needs an independent provider or carrier"
            if rid in task.declined_by:
                return "resident previously declined this task"
            worker_role = "shop_worker" if task.kind == "delivery" else "service_worker"
            if task.status == "requested" and worker_role in profile.roles:
                if profile.work_anchor_id != task.service_anchor_id:
                    return "worker does not serve this location"
                kind = self._class_for(rid, intent.travel_class)
                error = self._travel_error(rid, task.service_anchor_id, kind, task,
                                           "prepare" if task.kind == "delivery" else "serve")
                if error:
                    return error
                if not self._service_capacity(task.service_anchor_id):
                    return "service capacity already reserved"
                task.provider_id = rid
                task.status = "accepted"
                state.current_task_id = task.task_id
                state.commitments.append(task.task_id)
                self._task_causes[task.task_id] = cause
                self._emit("service_accepted", self._participants(task), f"{rid} accepted service for {task.task_id}.", task, cause)
                if state.anchor_id == task.service_anchor_id:
                    self._resume_task(task, cause)
                else:
                    self._travel(rid, task.service_anchor_id, kind, cause)
                return None
            if task.kind == "delivery" and task.status == "ready" and any(r in profile.roles for r in ("courier", "driver")):
                if task.required_capacity > profile.carrying_capacity:
                    return "carrying capacity insufficient"
                kind = self._class_for(rid, intent.travel_class)
                error = self._travel_error(rid, task.service_anchor_id, kind, task, "pickup")
                if error:
                    return error
                task.assignee_id = rid
                task.status = "assigned"
                state.current_task_id = task.task_id
                state.commitments.append(task.task_id)
                self._task_causes[task.task_id] = cause
                self._emit("transport_accepted", self._participants(task), f"{rid} accepted transport for {task.task_id}.", task, cause)
                if state.anchor_id == task.service_anchor_id:
                    self._resume_task(task, cause)
                else:
                    self._travel(rid, task.service_anchor_id, kind, cause)
                return None
            return "task not eligible for this role or already claimed"
        if action == "visit":
            if task.kind != "visit" or task.requester_id != rid or task.status != "accepted":
                return "no accepted service visit for this resident"
            if state.current_task_id not in {None, task.task_id}:
                return "another commitment already owns this resident's activity"
            kind = self._class_for(rid, intent.travel_class)
            error = self._travel_error(rid, task.service_anchor_id, kind, task, "serve")
            if error:
                return error
            state.current_task_id = task.task_id
            self._task_causes[task.task_id] = cause
            if state.anchor_id == task.service_anchor_id:
                self._resume_task(task, cause)
            else:
                self._travel(rid, task.service_anchor_id, kind, cause)
            return None
        if action in {"pickup", "deliver", "prepare", "serve"}:
            expected = task.assignee_id if action in {"pickup", "deliver"} else task.provider_id
            if expected != rid:
                return "action requires the assigned actor at the required location"
            return self._start_activity(task, action, cause)
        if action == "decline":
            if task.status == "picked_up" or task.status == "serving":
                return "in-progress physical service cannot be erased"
            if rid == task.requester_id:
                self._fail_task(task, "declined", "requester declined", cause)
            elif rid in self._participants(task):
                if state.current_task_id != task.task_id or task.task_id not in state.commitments:
                    return "resident has no active commitment to release"
                self._fail_task(task, "failed", "assigned actor released its commitment", cause)
            elif task in self._visible_tasks(rid):
                task.declined_by.append(rid)
                self._emit("task_declined", [rid, task.requester_id], f"{rid} declined {task.task_id}; request remains unfulfilled.", task, cause)
            else:
                return "task not visible to this resident"
            return None
        if action in {"report_delay", "revise_commitment"}:
            if rid not in self._participants(task):
                return "not a participant in this commitment"
            if action == "revise_commitment":
                if rid != task.requester_id:
                    return "only the requester may accept a revised deadline"
                task.deadline_s += intent.duration_s
            self._emit(action, self._participants(task), intent.text or f"{action} for {task.task_id}.", task, cause)
            return None
        return "unsupported population action"

    def _service_capacity(self, anchor_id: str, task_id: str | None = None) -> bool:
        reserved = {task.task_id for task in self.tasks.values()
                    if task.service_anchor_id == anchor_id and task.status in {"accepted", "preparing", "serving"}}
        for kind, _, tid, _ in self._pending.values():
            task = self.tasks.get(tid or "")
            if task is not None and kind in {"pickup", "deliver"}:
                target = task.destination_anchor_id if kind == "deliver" else task.service_anchor_id
                if target == anchor_id:
                    reserved.add(task.task_id)
        return len(reserved - {task_id}) < self.anchors[anchor_id].capacity

    def _wake(self, rid: str) -> None:
        state = self.states[rid]
        if state.anchor_id not in self.anchors:
            return
        pending = self._pending.get(rid)
        if state.activity == "waiting" and pending and pending[0] == "wait":
            self._pending.pop(rid)
            state.activity = "idle"
            state.busy_until_s = self.t
        if state.busy_until_s <= self.t and state.activity != "traveling":
            state.next_decision_s = min(state.next_decision_s, self.t)
            self._dirty_residents.add(rid)

    def _wake_roles(self, task: SocietyTask) -> None:
        worker_role = "shop_worker" if task.kind == "delivery" else "service_worker"
        for rid, profile in self.profiles.items():
            if (rid in self._participants(task)
                    or (worker_role in profile.roles and profile.work_anchor_id == task.service_anchor_id)
                    or (task.kind == "delivery" and task.ready_s is not None
                        and any(role in profile.roles for role in ("courier", "driver")))):
                self._wake(rid)

    def _next_known_decision(self, rid: str) -> int:
        state, profile = self.states[rid], self.profiles[rid]
        if state.anchor_id not in self.anchors:
            return self.definition.spec.horizon_s + 1
        tasks = self._visible_tasks(rid)
        times = [max(self.t + 1, self.definition.spec.horizon_s + 1), state.next_need_s]
        times.extend(step.earliest_s for step in profile.routine)
        times.extend(task.deadline_s for task in tasks if task.status not in TERMINAL_TASKS)
        for aid in self._accessible(rid, tasks):
            times.append(self.anchors[aid].opens_s)
        return min(t for t in times if t > self.t)

    def _has_actionable_option(self, rid: str) -> bool:
        state, profile = self.states[rid], self.profiles[rid]
        if state.anchor_id not in self.anchors:
            return False
        estimates: dict[tuple[str, str, TravelClass], dict] = {}
        classes = self.available_classes(rid)

        def reachable(target: str, task: SocietyTask | None = None, activity: ActivityKind | None = None) -> bool:
            return any(self._travel_error(rid, target, mode, task, activity, estimates) is None for mode in classes)

        active = [task for task in self._visible_tasks(rid) if task.status not in TERMINAL_TASKS]
        own = [task for task in active if task.requester_id == rid]
        if any(task.deadline_s <= self.t + self.definition.spec.decision_interval_s for task in own):
            return True
        current = self.tasks.get(state.current_task_id or "")
        if current is not None and current.status not in TERMINAL_TASKS:
            kind = self._next_activity(current)
            if kind is not None and self._activity_error(current, kind) is None:
                return True
        for task in own:
            if (task.kind == "visit" and task.status == "accepted" and state.current_task_id in {None, task.task_id}
                    and (state.current_task_id is None or state.anchor_id != task.service_anchor_id)
                    and reachable(task.service_anchor_id, task, "serve")):
                return True
            if (task.kind == "delivery" and state.current_task_id is None and state.anchor_id != task.destination_anchor_id
                    and reachable(task.destination_anchor_id)):
                return True
        if state.current_task_id is None:
            for task in active:
                if rid == task.requester_id or rid in task.declined_by:
                    continue
                role = "shop_worker" if task.kind == "delivery" else "service_worker"
                if (task.status == "requested" and role in profile.roles
                        and profile.work_anchor_id == task.service_anchor_id
                        and self._service_capacity(task.service_anchor_id)
                        and reachable(task.service_anchor_id, task, "prepare" if task.kind == "delivery" else "serve")):
                    return True
                if (task.kind == "delivery" and task.status == "ready"
                        and any(role in profile.roles for role in ("courier", "driver"))
                        and task.required_capacity <= profile.carrying_capacity
                        and self._service_capacity(task.service_anchor_id)
                        and reachable(task.service_anchor_id, task, "pickup")):
                    return True
            due_routine = [step for step in profile.routine if step.earliest_s <= self.t]
            if due_routine:
                target = max(due_routine, key=lambda step: step.earliest_s).anchor_id
                if target != state.anchor_id and reachable(target):
                    return True
            if state.needs.get("rest", 0) >= 0.75:
                return True
        for need, purpose in (("delivery", "shop"), ("visit", "service")):
            if (state.needs.get(need, 0) >= 0.75 and not any(task.kind == need for task in own)
                    and any(a.purpose == purpose and a.opens_s <= self.t < a.closes_s for a in self.anchors.values())):
                return True
        return False

    def _close_binding(self, rid: str) -> None:
        for binding in reversed(self.mobility_bindings):
            if binding.resident_id == rid and binding.end_s is None:
                binding.end_s = self.t
                break

    def _bind_stationary(self, rid: str) -> None:
        self._close_binding(rid)
        self.mobility_bindings.append(MobilityBinding(resident_id=rid, entity_id=None, mode="stationary",
                                                     anchor_id=self.states[rid].anchor_id, start_s=self.t,
                                                     ownership="abstract", measured=False))

    def _travel(self, rid: str, target: str, kind: TravelClass, cause: str | None) -> None:
        state = self.states[rid]
        if state.anchor_id == target:
            return
        if state.anchor_id is None:
            raise ValueError("cannot start travel without an authoritative origin")
        origin = self.anchors[state.anchor_id]
        try:
            entity_id = self.mobility.start_trip(rid, origin, self.anchors[target], kind)
        except ValueError:
            self._emit("trip_failed", [rid], "Transport rejected the proposed trip.", cause=cause)
            if state.current_task_id:
                self._fail_task(self.tasks[state.current_task_id], "failed", "transport rejected trip", cause)
            self.failed_trips += 1
            return
        self._close_binding(rid)
        mode: Literal["walk", "cycle", "drive"] = "walk" if kind == "pedestrian" else "cycle" if kind == "bicycle" else "drive"
        self.mobility_bindings.append(MobilityBinding(resident_id=rid, entity_id=entity_id, mode=mode,
                                                     vehicle_class=kind, start_s=self.t,
                                                     capacity=self.profiles[rid].carrying_capacity))
        state.anchor_id = None
        state.destination_id = target
        state.mobility_mode = mode
        state.travel_class = kind
        state.activity = "traveling"
        self._trip_causes[entity_id] = cause
        self._emit("trip_started", [rid], f"Started {kind} trip to {target}; arrival not yet measured.", cause=cause)

    def _active_body(self, rid: str) -> MobilityBinding | None:
        return next((b for b in reversed(self.mobility_bindings)
                     if b.resident_id == rid and b.end_s is None and b.measured), None)

    def _validate_outcomes(self, t: int, outcomes: Iterable[MobilityOutcome]) -> list[MobilityOutcome]:
        if self._decision_ids is not None:
            raise ValueError("mobility outcomes cannot overlap an active decision epoch")
        batch = list(outcomes)
        seen: set[str] = set()
        for outcome in batch:
            if not isinstance(outcome, MobilityOutcome) or outcome.t != t or outcome.status not in {"arrived", "failed"}:
                raise ValueError("mobility outcome type, time, or status mismatch")
            rid = outcome.resident_id
            if rid not in self.states or rid in seen:
                raise ValueError("unknown or duplicate resident in mobility outcomes")
            seen.add(rid)
            state, binding = self.states[rid], self._active_body(rid)
            if (binding is None or binding.entity_id != outcome.entity_id or state.activity != "traveling"
                    or state.destination_id != outcome.destination_id or outcome.destination_id not in self.anchors):
                raise ValueError("mobility outcome does not match the authoritative body and destination")
        return sorted(batch, key=lambda item: (item.resident_id, item.entity_id))

    def _apply_mobility_outcome(self, outcome: MobilityOutcome) -> None:
        rid, entity_id = outcome.resident_id, outcome.entity_id
        state = self.states[rid]
        cause = self._trip_causes.pop(entity_id, None)
        state.destination_id = None
        state.mobility_mode = "stationary"
        state.busy_until_s = self.t
        if outcome.status == "arrived":
            state.anchor_id = outcome.destination_id
            state.activity = "idle"
            state.next_decision_s = self.t
            if state.travel_class and state.travel_class != "pedestrian":
                state.vehicle_locations[state.travel_class] = outcome.destination_id
            self._bind_stationary(rid)
            self.completed_trips += 1
            self._emit("trip_arrived", [rid], f"SUMO measured arrival at {outcome.destination_id}.", cause=cause)
        else:
            self._close_binding(rid)
            state.activity = "waiting"
            self.failed_trips += 1
            self._emit("trip_failed", [rid], f"Trip failed: {outcome.reason}", cause=cause)
            if state.current_task_id:
                self._fail_task(self.tasks[state.current_task_id], "failed", outcome.reason, cause)
            state.next_decision_s = self.definition.spec.horizon_s + 1
            state.fallback_reason = "physical location unknown after failed trip; no fabricated relocation"

    def mobility_arrived(self, rid: str, entity_id: str, destination_id: str) -> None:
        batch = self._validate_outcomes(self.t, [MobilityOutcome(rid, entity_id, destination_id, self.t, "arrived")])
        self._apply_mobility_outcome(batch[0])
        self._resume_present_tasks({rid})
        self.version += 1
        self._snapshot()

    def mobility_failed(self, rid: str, entity_id: str, reason: str) -> None:
        state = self.states.get(rid)
        destination = state.destination_id if state is not None else None
        batch = self._validate_outcomes(self.t, [MobilityOutcome(rid, entity_id, destination or "", self.t, "failed", reason)])
        self._apply_mobility_outcome(batch[0])
        self._resume_present_tasks({rid})
        self.version += 1
        self._snapshot()

    @staticmethod
    def _next_activity(task: SocietyTask) -> ActivityKind | None:
        if task.status == "accepted":
            return "prepare" if task.kind == "delivery" else "serve"
        if task.kind == "delivery" and task.status in {"assigned", "picked_up"}:
            return "pickup" if task.status == "assigned" else "deliver"
        return None

    def _activity_anchor(self, task: SocietyTask, kind: ActivityKind) -> ActivityAnchor:
        return self.anchors[task.destination_anchor_id if kind == "deliver" else task.service_anchor_id]

    def _activity_duration(self, task: SocietyTask, kind: ActivityKind) -> int:
        return 10 if kind in {"pickup", "deliver"} else self._activity_anchor(task, kind).service_duration_s

    def _window_error(self, task: SocietyTask, kind: ActivityKind, start_s: int | None = None) -> str | None:
        start = self.t if start_s is None else start_s
        anchor = self._activity_anchor(task, kind)
        end = start + self._activity_duration(task, kind)
        if start < anchor.opens_s:
            return "required anchor is not open yet"
        if start >= anchor.closes_s or end > anchor.closes_s:
            return "activity duration does not fit the anchor opening window"
        if end > task.deadline_s:
            return "activity duration cannot finish before the task deadline"
        return None

    def _activity_error(self, task: SocietyTask, kind: ActivityKind, *, finishing: bool = False) -> str | None:
        expected = {"prepare": "preparing" if finishing else "accepted", "pickup": "assigned",
                    "deliver": "picked_up", "serve": "serving" if finishing else "accepted"}[kind]
        if task.status != expected or task.kind != ("visit" if kind == "serve" else "delivery"):
            return "task transition is not eligible"
        owner = task.assignee_id if kind in {"pickup", "deliver"} else task.provider_id
        if owner is None or owner == task.requester_id:
            return "activity requires an independent assigned actor"
        state, profile = self.states[owner], self.profiles[owner]
        if state.current_task_id != task.task_id or task.task_id not in state.commitments:
            return "another commitment owns the assigned actor's activity"
        if kind in {"pickup", "deliver"}:
            if not any(role in profile.roles for role in ("courier", "driver")):
                return "assigned actor lacks transport capability"
            if profile.carrying_capacity < task.required_capacity:
                return "carrying capacity insufficient"
            if task.ready_s is None or task.ready_s > self.t:
                return "pickup requires actually prepared goods"
        elif (profile.work_anchor_id != task.service_anchor_id
              or ("service_worker" if kind == "serve" else "shop_worker") not in profile.roles):
            return "assigned worker does not serve this location"
        anchor = self._activity_anchor(task, kind)
        actors = [owner, task.requester_id] if kind in {"deliver", "serve"} else [owner]
        for rid in actors:
            participant = self.states[rid]
            if participant.anchor_id != anchor.anchor_id or participant.activity == "traveling":
                return "required participant is absent from the activity anchor"
            if (participant.current_task_id not in {None, task.task_id}
                    or task.task_id not in participant.commitments):
                return "another commitment owns a required participant's activity"
            if (kind == "serve" or finishing) and participant.current_task_id != task.task_id:
                return "required participant has not committed to this service activity"
            pending = self._pending.get(rid)
            if not finishing and ((pending is not None and pending[0] != "wait")
                                  or (participant.busy_until_s > self.t and not (pending and pending[0] == "wait"))):
                return "required participant is occupied by another activity"
        duration = self._activity_duration(task, kind)
        error = self._window_error(task, kind, self.t - duration if finishing else self.t)
        if error:
            return error
        if not self._service_capacity(anchor.anchor_id, task.task_id):
            return "activity anchor capacity already reserved"
        return None

    def _start_activity(self, task: SocietyTask, kind: ActivityKind, cause: str | None) -> str | None:
        error = self._activity_error(task, kind)
        if error:
            return error
        owner = task.assignee_id if kind in {"pickup", "deliver"} else task.provider_id
        assert owner is not None
        actors = [owner, task.requester_id] if kind in {"deliver", "serve"} else [owner]
        end = self.t + self._activity_duration(task, kind)
        for rid in actors:
            state = self.states[rid]
            self._pending.pop(rid, None)
            state.current_task_id = task.task_id
            state.activity = "preparing" if kind == "prepare" else "serving" if kind == "serve" else "working"
            state.busy_until_s = end
            state.next_decision_s = end
        if kind == "prepare":
            task.status = "preparing"
        elif kind == "serve":
            task.status = "serving"
        self._pending[owner] = (kind, end, task.task_id, cause)
        event = {"prepare": "preparation_started", "pickup": "pickup_started",
                 "deliver": "delivery_started", "serve": "service_started"}[kind]
        self._emit(event, self._participants(task), f"{kind} started for {task.task_id}; completion remains pending.", task, cause)
        return None

    def _resume_task(self, task: SocietyTask, cause: str | None) -> None:
        kind = self._next_activity(task)
        if kind is None:
            return
        owner = task.assignee_id if kind in {"pickup", "deliver"} else task.provider_id
        if owner is None:
            return
        state = self.states[owner]
        if state.anchor_id != self._activity_anchor(task, kind).anchor_id or state.current_task_id != task.task_id:
            return
        pending = self._pending.get(owner)
        if pending is not None and pending[0] != "wait":
            return
        error = self._start_activity(task, kind, cause)
        if error:
            anchor = self._activity_anchor(task, kind)
            earliest = max(self.t, anchor.opens_s)
            impossible = self._window_error(task, kind, earliest)
            if impossible is not None:
                status: Literal["failed", "expired"] = "expired" if earliest + self._activity_duration(task, kind) > task.deadline_s else "failed"
                self._fail_task(task, status, impossible, cause)
            else:
                if pending is None or pending[0] == "wait":
                    self._pending.pop(owner, None)
                    state.activity = "waiting"
                    state.busy_until_s = self.t
                event = "recipient_absent" if kind == "deliver" and self.states[task.requester_id].anchor_id != anchor.anchor_id else "activity_waiting"
                self._emit(event, self._participants(task), f"{kind} for {task.task_id} waits: {error}.", task, cause)
                state.next_decision_s = self._next_known_decision(owner)

    def _resume_present_tasks(self, residents: set[str]) -> None:
        if not residents:
            return
        for task in sorted(self.tasks.values(), key=lambda task: task.task_id):
            actors = {task.requester_id, task.assignee_id if task.status in {"assigned", "picked_up"} else task.provider_id}
            if residents & actors:
                self._resume_task(task, self._task_causes.get(task.task_id))

    def _release(self, task: SocietyTask) -> None:
        for rid in self._participants(task):
            state = self.states[rid]
            if task.task_id in state.commitments:
                state.commitments.remove(task.task_id)
            if state.current_task_id == task.task_id:
                state.current_task_id = None
                if state.activity != "traveling":
                    state.activity = "idle"
                    state.busy_until_s = self.t
                self._pending.pop(rid, None)
            if state.anchor_id in self.anchors:
                state.next_decision_s = min(state.next_decision_s, self.t)

    def _complete(self, task: SocietyTask, cause: str | None) -> None:
        if task.status in TERMINAL_TASKS:
            return
        if self.t > task.deadline_s:
            self._fail_task(task, "expired", "completion missed the declared deadline", cause)
            return
        task.status = "completed"
        task.completed_s = self.t
        task.version += 1
        requester = self.states[task.requester_id]
        requester.needs[task.kind] = 0
        requester.next_need_s = self.t + self.definition.spec.recurring_need_s
        self._release(task)
        self._emit("task_completed", self._participants(task), f"{task.kind} request {task.task_id} completed.", task, cause)
        for rid in self._participants(task):
            for other in self._participants(task):
                if rid != other:
                    old = self.states[rid].relationships.get(other, 0.5)
                    self.states[rid].relationships[other] = min(1, round(old + 0.05, 2))

    def _fail_task(self, task: SocietyTask, status: Literal["failed", "expired", "declined"], reason: str,
                   cause: str | None) -> None:
        if task.status in TERMINAL_TASKS:
            return
        task.status = status
        task.failure_reason = reason
        task.version += 1
        self._release(task)
        self._emit("task_failed", self._participants(task), f"Request {task.task_id} {status}: {reason}", task, cause)

    def advance(self, t: int, outcomes: Iterable[MobilityOutcome] | None = None) -> None:
        if self._decision_ids is not None:
            raise ValueError("cannot advance simulated time during an active decision epoch")
        if t < self.t:
            raise ValueError("simulation time cannot move backwards")
        batch = self._validate_outcomes(t, outcomes if outcomes is not None else ())
        self.t = t
        self.version += 1
        for outcome in batch:
            self._apply_mobility_outcome(outcome)
        self._resume_present_tasks({outcome.resident_id for outcome in batch})
        for message in self.messages:
            if message.delivered_s is None and message.sent_s < t:
                message.delivered_s = t
                self._emit("message_received", [message.recipient_id],
                           f"{message.sender_id}: {message.text}", cause=message.cause_id)
        due = [(rid, value) for rid, value in self._pending.items() if value[1] <= t]
        available = set()
        for rid, pending in sorted(due, key=lambda item: (item[1][1], item[0])):
            if self._pending.get(rid) != pending:
                continue
            kind, _, task_id, cause = self._pending.pop(rid)
            state = self.states[rid]
            self._dirty_residents.add(rid)
            if kind in {"wait", "rest"}:
                state.activity = "idle"
                state.busy_until_s = t
                if kind == "rest":
                    state.needs["rest"] = 0
                    available.add(rid)
                elif not self._has_actionable_option(rid):
                    state.next_decision_s = self._next_known_decision(rid)
                continue
            task = self.tasks.get(task_id or "")
            if task is None or task.status in TERMINAL_TASKS:
                continue
            if kind not in {"prepare", "pickup", "deliver", "serve"}:
                raise ValueError("unknown pending activity")
            error = self._activity_error(task, kind, finishing=True)
            if error:
                if kind == "deliver" and error == "required participant is absent from the activity anchor":
                    state.activity = "waiting"
                    state.busy_until_s = t
                    requester = self.states[task.requester_id]
                    if requester.current_task_id == task.task_id:
                        requester.current_task_id = None
                        requester.busy_until_s = t
                        if requester.activity != "traveling":
                            requester.activity = "idle"
                    self._emit("delivery_delayed", self._participants(task), "Recipient or carrier left before delivery finished.", task, cause)
                else:
                    self._fail_task(task, "expired" if t > task.deadline_s else "failed", error, cause)
                continue
            state.busy_until_s = t
            if kind == "prepare":
                task.status = "ready"
                task.ready_s = t
                state.current_task_id = None
                state.activity = "idle"
                if task.task_id in state.commitments:
                    state.commitments.remove(task.task_id)
                self._emit("task_ready", self._participants(task), f"Prepared {task.task_id}; awaiting transport acceptance.", task, cause)
            elif kind == "pickup":
                task.status = "picked_up"
                state.activity = "idle"
                self._emit("task_picked_up", self._participants(task), f"Picked up {task.task_id} at its service anchor.", task, cause)
                travel_class = self._class_for(rid, state.travel_class)
                error = self._travel_error(rid, task.destination_anchor_id, travel_class)
                if error:
                    self._fail_task(task, "failed", error, cause)
                elif state.anchor_id == task.destination_anchor_id:
                    self._resume_task(task, cause)
                else:
                    self._travel(rid, task.destination_anchor_id, travel_class, cause)
            else:
                self._complete(task, cause)
            available.update(self._participants(task))
        for task in list(self.tasks.values()):
            if task.status not in TERMINAL_TASKS and t > task.deadline_s:
                self._fail_task(task, "expired", "declared deadline passed", self._task_causes.get(task.task_id))
        self._resume_present_tasks(available)
        for rid, state in self.states.items():
            if t >= state.next_need_s:
                state.next_need_s = t + self.definition.spec.recurring_need_s
                self._dirty_residents.add(rid)
                changed = False
                for need in ("delivery", "visit"):
                    value = min(1, state.needs.get(need, 0) + 0.75)
                    changed |= state.needs.get(need, 0) != value
                    state.needs[need] = value
                if changed:
                    self._emit("recurring_need", [rid], "A recurring everyday need now needs attention.")
        self._snapshot()

    def metrics(self) -> PopulationMetrics:
        return PopulationMetrics(
            resident_count=len(self.states), horizon_s=self.definition.spec.horizon_s, end_time_s=self.t,
            task_status_counts=dict(Counter(task.status for task in self.tasks.values())),
            completed_deliveries=sum(task.kind == "delivery" and task.status == "completed" for task in self.tasks.values()),
            completed_visits=sum(task.kind == "visit" and task.status == "completed" for task in self.tasks.values()),
            outstanding_needs=sum(value >= 0.75 for state in self.states.values() for value in state.needs.values()),
            outstanding_commitments=sum(len(state.commitments) for state in self.states.values()),
            accepted_actions=sum(d.accepted for d in self.decisions),
            rejected_actions=sum(not d.accepted and d.source != "fallback" for d in self.decisions),
            decision_source_counts=dict(Counter(d.source for d in self.decisions)),
            memory_entries=sum(len(state.memories) for state in self.states.values()),
            delivered_messages=sum(m.delivered_s is not None for m in self.messages),
            completed_trips=self.completed_trips, failed_trips=self.failed_trips,
        )

    def artifact(self, attempt_id: str) -> PopulationArtifact:
        self._snapshot()
        return PopulationArtifact(
            run_id=self.run_id, attempt_id=attempt_id, definition=self.definition.model_copy(deep=True),
            states=[state.model_copy(deep=True) for state in self.state_history],
            tasks=[task.model_copy(deep=True) for task in self.task_history],
            decisions=[d.model_copy(deep=True) for d in self.decisions], messages=[m.model_copy(deep=True) for m in self.messages],
            events=[e.model_copy(deep=True) for e in self.events],
            mobility_bindings=[b.model_copy(deep=True) for b in self.mobility_bindings],
            swarm_bindings=[b.model_copy(deep=True) for b in self.swarm_bindings], metrics=self.metrics(),
        )
