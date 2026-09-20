from __future__ import annotations

from collections import defaultdict
from typing import Literal

from pydantic import Field

from cityshift.contracts import (
    MobilityBinding,
    PopulationContract,
    PopulationDecisionRecord,
    PopulationDefinition,
    PopulationEvent,
    ResidentSnapshot,
    ResidentState,
    SocialMessage,
    SocietyTask,
    SwarmBinding,
    TaskSnapshot,
)

PendingKind = Literal["wait", "rest", "prepare", "pickup", "deliver", "serve"]


class PendingActivity(PopulationContract):
    kind: PendingKind
    until_s: int = Field(ge=0)
    task_id: str | None
    cause_id: str | None


class SavedSociety(PopulationContract):
    version: Literal["society-checkpoint-1"] = "society-checkpoint-1"
    run_id: str
    population_id: str
    definition_hash: str
    t: int = Field(ge=0)
    world_version: int = Field(ge=0)
    epoch: int = Field(ge=0)
    states: dict[str, ResidentState]
    tasks: dict[str, SocietyTask]
    events: list[PopulationEvent]
    messages: list[SocialMessage]
    decisions: list[PopulationDecisionRecord]
    mobility_bindings: list[MobilityBinding]
    swarm_bindings: list[SwarmBinding]
    state_history: list[ResidentSnapshot]
    task_history: list[TaskSnapshot]
    pending: dict[str, PendingActivity]
    trip_causes: dict[str, str | None]
    task_causes: dict[str, str]
    seen_intents: list[tuple[str, str]]
    completed_trips: int = Field(ge=0)
    failed_trips: int = Field(ge=0)

    def validate_consistency(self, definition: PopulationDefinition) -> None:
        ids, task_ids = set(self.states), set(self.tasks)
        profiles = {profile.resident_id: profile for profile in definition.profiles}
        anchors = {anchor.anchor_id: anchor for anchor in definition.anchors}
        terminal = {"completed", "declined", "failed", "expired"}
        events = {event.event_id: event for event in self.events}
        records = {record.decision_id: record for record in self.decisions}
        if len(events) != len(self.events) or len(records) != len(self.decisions):
            raise ValueError("checkpoint contains duplicate event or decision identities")
        if len(set(self.seen_intents)) != len(self.seen_intents):
            raise ValueError("checkpoint contains duplicate intent identities")
        if any(event.epoch > self.epoch or (event.task_id is not None and event.task_id not in task_ids)
               for event in self.events):
            raise ValueError("checkpoint event references an unknown task or future epoch")
        for record in self.decisions:
            brain = definition.assignments[record.resident_id]
            proposal = record.proposal
            if (record.epoch > self.epoch or record.assigned_model_id != brain.model_id
                    or (record.source != "fallback" and record.source != brain.control_mode)
                    or set(record.outcome_event_ids) - set(events)):
                raise ValueError("checkpoint decision provenance or causal record mismatch")
            if proposal is not None and (
                proposal.run_id != self.run_id or proposal.resident_id != record.resident_id
                or proposal.epoch != record.epoch or proposal.effective_t != record.t
                or proposal.world_version > self.world_version
            ):
                raise ValueError("checkpoint proposal scope mismatch")
            if record.source == "jiuwenswarm" and not any(
                b.resident_id == record.resident_id and b.resolved_model_id == record.actual_model_id
                and b.bound_s <= record.t for b in self.swarm_bindings
            ):
                raise ValueError("checkpoint native decision lacks its recorded swarm binding")
            if record.source in {"rules", "fallback"} and record.actual_model_id is not None:
                raise ValueError("checkpoint rules or fallback record claims native inference")
        if any(binding.resident_id not in ids or binding.run_id != self.run_id or binding.bound_s > self.t
               or binding.requested_model_id != definition.assignments[binding.resident_id].model_id
               for binding in self.swarm_bindings):
            raise ValueError("checkpoint contains invalid or future swarm bindings")
        if any((m.delivered_s is not None and m.delivered_s < m.sent_s)
               or (m.task_id is not None and m.task_id not in task_ids) for m in self.messages):
            raise ValueError("checkpoint message delivery or task mismatch")

        def valid_state(state: ResidentState, at: int) -> None:
            rid = state.resident_id
            if rid not in ids or state.role not in profiles[rid].roles:
                raise ValueError("checkpoint resident role or identity mismatch")
            if (state.anchor_id is not None and state.anchor_id not in anchors
                    or state.destination_id is not None and state.destination_id not in anchors
                    or set(state.relationships) - ids
                    or set(state.vehicle_locations.values()) - set(anchors)
                    or set(state.vehicle_locations) - set(profiles[rid].available_classes)
                    or (state.travel_class is not None and state.travel_class not in profiles[rid].available_classes)):
                raise ValueError("checkpoint resident resource ownership or anchor mismatch")
            if state.last_decision_s is not None and state.last_decision_s > at:
                raise ValueError("checkpoint resident contains a future decision")
            for memory in state.memories:
                event = events.get(memory.event_id)
                if memory.t > at or (event is not None and event.t > at):
                    raise ValueError("checkpoint resident history contains future memory")
                if set(memory.related_residents) - ids or (event is not None and rid not in event.resident_ids):
                    raise ValueError("checkpoint resident memory is outside its observation scope")
            commitments = set(state.commitments)
            if len(commitments) != len(state.commitments) or commitments - task_ids:
                raise ValueError("checkpoint contains duplicate or unknown commitments")
            if state.current_task_id is not None and state.current_task_id not in commitments:
                raise ValueError("checkpoint current activity lacks its commitment")
            if any(self.tasks[tid].created_s > at for tid in commitments):
                raise ValueError("checkpoint resident history contains a future commitment")

        def valid_task(task: SocietyTask, at: int) -> None:
            participants = {rid for rid in (task.requester_id, task.provider_id, task.assignee_id) if rid is not None}
            if (task.task_id not in task_ids or participants - ids or set(task.declined_by) - ids
                    or task.service_anchor_id not in anchors or task.destination_anchor_id not in anchors):
                raise ValueError("checkpoint task references unknown identities or anchors")
            if task.created_s > at or any(value is not None and not task.created_s <= value <= at
                                          for value in (task.ready_s, task.completed_s)):
                raise ValueError("checkpoint task history contains future or invalid times")
            if (task.completed_s is not None) != (task.status == "completed"):
                raise ValueError("checkpoint task completion status mismatch")
            if task.kind == "visit" and (task.status in {"preparing", "ready", "assigned", "picked_up"} or task.assignee_id):
                raise ValueError("checkpoint service kind and transport state mismatch")
            if task.kind == "delivery" and task.status == "serving":
                raise ValueError("checkpoint delivery cannot be an in-person service")
            if task.provider_id is not None:
                provider = profiles[task.provider_id]
                if (task.provider_id == task.requester_id or provider.work_anchor_id != task.service_anchor_id
                        or ("shop_worker" if task.kind == "delivery" else "service_worker") not in provider.roles):
                    raise ValueError("checkpoint task provider ownership mismatch")
            if task.assignee_id is not None:
                carrier = profiles[task.assignee_id]
                if (task.assignee_id == task.requester_id or carrier.carrying_capacity < task.required_capacity
                        or not any(role in carrier.roles for role in ("courier", "driver"))):
                    raise ValueError("checkpoint task carrier ownership or capacity mismatch")
            if (task.status in {"accepted", "preparing", "ready", "assigned", "picked_up", "serving", "completed"}
                    and task.provider_id is None):
                raise ValueError("checkpoint task has no assigned provider")
            if ((task.status in {"assigned", "picked_up"} or task.kind == "delivery" and task.status == "completed")
                    and (task.assignee_id is None or task.ready_s is None)):
                raise ValueError("checkpoint delivery lacks prepared goods or a carrier")

        previous_t = -1
        latest_states: dict[str, ResidentState] = {}
        first_states: dict[str, ResidentState] = {}
        for snapshot in self.state_history:
            if not previous_t <= snapshot.t <= self.t:
                raise ValueError("checkpoint resident history clock mismatch")
            valid_state(snapshot.state, snapshot.t)
            previous_t = snapshot.t
            latest_states[snapshot.state.resident_id] = snapshot.state
            first_states.setdefault(snapshot.state.resident_id, snapshot.state)
        if latest_states != self.states or first_states != {s.resident_id: s for s in definition.initial_states}:
            raise ValueError("checkpoint resident history does not match initial and current state")
        latest_tasks: dict[str, SocietyTask] = {}
        first_tasks: dict[str, SocietyTask] = {}
        previous_t = -1
        for task_snapshot in self.task_history:
            if not previous_t <= task_snapshot.t <= self.t:
                raise ValueError("checkpoint task history clock mismatch")
            valid_task(task_snapshot.task, task_snapshot.t)
            previous_t = task_snapshot.t
            latest_tasks[task_snapshot.task.task_id] = task_snapshot.task
            first_tasks.setdefault(task_snapshot.task.task_id, task_snapshot.task)
        if latest_tasks != self.tasks or any(first_tasks.get(t.task_id) != t for t in definition.initial_tasks):
            raise ValueError("checkpoint task history does not match initial and current state")
        for rid, state in self.states.items():
            valid_state(state, self.t)
            for tid in state.commitments:
                task = self.tasks[tid]
                if task.status in terminal or rid not in {task.requester_id, task.provider_id, task.assignee_id}:
                    raise ValueError("checkpoint contains a terminal or unowned commitment")
        for task in self.tasks.values():
            valid_task(task, self.t)
            if task.status in terminal:
                continue
            if task.task_id not in self.states[task.requester_id].commitments:
                raise ValueError("checkpoint request lacks the requester's commitment")
            owners = []
            if task.status in {"accepted", "preparing", "serving"}:
                owners.append(task.provider_id)
            if task.status in {"assigned", "picked_up"}:
                owners.append(task.assignee_id)
            if task.status == "serving":
                owners.append(task.requester_id)
            if any(rid is None or self.states[rid].current_task_id != task.task_id for rid in owners):
                raise ValueError("checkpoint task and active resident ownership disagree")

        bodies: dict[str, MobilityBinding] = {}
        latest_bindings: dict[str, MobilityBinding] = {}
        active: dict[str, MobilityBinding] = {}
        for binding in self.mobility_bindings:
            rid = binding.resident_id
            if rid not in ids or binding.start_s > self.t or binding.end_s is not None and binding.end_s > self.t:
                raise ValueError("checkpoint mobility binding contains unknown identity or future time")
            previous = latest_bindings.get(rid)
            if previous is not None and (previous.end_s is None or previous.end_s > binding.start_s):
                raise ValueError("checkpoint mobility presence intervals overlap")
            latest_bindings[rid] = binding
            if binding.measured:
                if (binding.entity_id is None or binding.entity_id in bodies or binding.ownership != "resident"
                        or binding.vehicle_class not in profiles[rid].available_classes or binding.mode == "stationary"):
                    raise ValueError("checkpoint measured body ownership mismatch")
                bodies[binding.entity_id] = binding
            elif binding.anchor_id not in anchors or binding.mode != "stationary" or binding.ownership != "abstract":
                raise ValueError("checkpoint abstract presence mismatch")
            if binding.end_s is None:
                active[rid] = binding
        for rid, state in self.states.items():
            current_binding = active.get(rid)
            if state.activity == "traveling":
                if (current_binding is None or not current_binding.measured or state.mobility_mode != current_binding.mode
                        or state.travel_class != current_binding.vehicle_class or state.destination_id is None or state.anchor_id is not None):
                    raise ValueError("checkpoint travel state and physical body disagree")
            elif state.destination_id is not None or state.mobility_mode != "stationary":
                raise ValueError("checkpoint stationary activity claims a travel destination")
            elif state.anchor_id is None and (current_binding is not None or rid in self.pending
                                             or state.next_decision_s <= definition.spec.horizon_s):
                raise ValueError("checkpoint unknown physical location cannot claim presence or activity")
        active_entities = {binding.entity_id for binding in active.values() if binding.measured}
        if (set(self.trip_causes) != active_entities or set(self.task_causes) - task_ids
                or any(cause is not None and cause not in records for cause in self.trip_causes.values())
                or set(self.task_causes.values()) - set(records)):
            raise ValueError("checkpoint active trip or task causal references mismatch")
        if (self.completed_trips != sum(event.kind == "trip_arrived" for event in self.events)
                or self.failed_trips != sum(event.kind == "trip_failed" for event in self.events)):
            raise ValueError("checkpoint transport outcome accounting mismatch")

        slots: dict[str, set[str]] = defaultdict(set)
        for task in self.tasks.values():
            if task.status in {"accepted", "preparing", "serving"}:
                slots[task.service_anchor_id].add(task.task_id)
        occupied = set()
        for rid, pending in self.pending.items():
            state = self.states[rid]
            if (pending.until_s <= self.t or state.busy_until_s != pending.until_s or state.anchor_id not in anchors
                    or pending.cause_id is not None and pending.cause_id not in records):
                raise ValueError("checkpoint pending activity clock, presence, or cause mismatch")
            if pending.kind in {"wait", "rest"}:
                if (pending.task_id is not None or state.activity != ("waiting" if pending.kind == "wait" else "resting")
                        or pending.kind == "rest" and state.current_task_id is not None):
                    raise ValueError("checkpoint pending wait or rest ownership mismatch")
                occupied.add(rid)
                continue
            pending_task = self.tasks.get(pending.task_id or "")
            status = {"prepare": "preparing", "pickup": "assigned", "deliver": "picked_up", "serve": "serving"}[pending.kind]
            if (pending_task is None or pending_task.status != status or state.current_task_id != pending_task.task_id
                    or rid != (pending_task.assignee_id if pending.kind in {"pickup", "deliver"} else pending_task.provider_id)):
                raise ValueError("checkpoint pending service ownership or task status mismatch")
            anchor = anchors[pending_task.destination_anchor_id if pending.kind == "deliver" else pending_task.service_anchor_id]
            duration = 10 if pending.kind in {"pickup", "deliver"} else anchor.service_duration_s
            if (not anchor.opens_s <= pending.until_s - duration <= self.t
                    or pending.until_s > min(anchor.closes_s, pending_task.deadline_s)):
                raise ValueError("checkpoint pending duration exceeds its activity window")
            actors = [rid, pending_task.requester_id] if pending.kind in {"deliver", "serve"} else [rid]
            for actor in actors:
                participant = self.states[actor]
                activity = "preparing" if pending.kind == "prepare" else "serving" if pending.kind == "serve" else "working"
                if (actor in occupied or participant.current_task_id != pending_task.task_id or participant.anchor_id != anchor.anchor_id
                        or participant.activity != activity or participant.busy_until_s != pending.until_s):
                    raise ValueError("checkpoint pending activity lost a required participant or resource")
                occupied.add(actor)
            slots[anchor.anchor_id].add(pending_task.task_id)
        if any(len(tasks) > anchors[aid].capacity for aid, tasks in slots.items()):
            raise ValueError("checkpoint activity anchor capacity exceeded")
        if any(state.activity in {"preparing", "serving", "working", "resting"} and rid not in occupied
               for rid, state in self.states.items()):
            raise ValueError("checkpoint authoritative activity has no pending completion")
