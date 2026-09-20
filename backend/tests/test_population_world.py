from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

import pytest

from cityshift.agents.population_baseline import baseline_decision
from cityshift.contracts import (
    ActionIntent,
    ActionProposal,
    ActivityAnchor,
    AnchorAccess,
    BrainAssignment,
    MemoryEntry,
    PopulationSpec,
    ResidentDecision,
    SwarmBinding,
)
from cityshift.domain.population import generate_population
from cityshift.domain.society import SocietyWorld
from cityshift.transport.population import MobilityOutcome


def anchors() -> list[ActivityAnchor]:
    return [ActivityAnchor(
        anchor_id=name, name=name, purpose=purpose, lon=-79.38 + i * 0.001, lat=43.64,
        access={kind: AnchorAccess(edge_id=f"edge-{i}", position_m=20) for kind in (
            "pedestrian", "bicycle", "passenger", "delivery", "truck",
        )}, capacity=2 if purpose in {"shop", "service"} else 20, service_duration_s=10,
    ) for i, (name, purpose) in enumerate([
        ("shop", "shop"), ("service", "service"), ("home-a", "home"), ("home-b", "home"),
        ("home-c", "home"), ("home-d", "home"), ("rest", "rest"),
    ])]


def definition():
    brain = BrainAssignment(model_family="rules", model_id="baseline-v1", api_provider="local",
                            config_ref="baseline", control_mode="rules")
    spec = PopulationSpec(brains=[brain], count=12, horizon_s=600, recurring_need_s=120, service_duration_s=10)
    return generate_population(spec, anchors(), "fixture-network")


@dataclass
class FixtureMobility:
    t: int = 0
    unreachable: bool = False
    started: list[dict] = field(default_factory=list)
    estimates: list[tuple[str, str, str]] = field(default_factory=list)

    def estimate_trip(self, origin, destination, travel_class):
        self.estimates.append((origin.anchor_id, destination.anchor_id, travel_class))
        return {"target_id": destination.anchor_id, "travel_class": travel_class,
                "reachable": not self.unreachable, "duration_s": 5, "distance_m": 50,
                "reason": "fixture route unavailable" if self.unreachable else ""}

    def start_trip(self, resident_id, origin, destination, travel_class):
        if self.unreachable:
            raise ValueError("fixture route unavailable")
        entity_id = f"body-{resident_id}-{len(self.started)}"
        self.started.append({"resident_id": resident_id, "entity_id": entity_id,
                             "destination_id": destination.anchor_id, "travel_class": travel_class})
        return entity_id


def world_at_work() -> SocietyWorld:
    pop = definition()
    for profile, state in zip(pop.profiles, pop.initial_states, strict=True):
        if profile.work_anchor_id and state.role in {"shop_worker", "service_worker"}:
            state.anchor_id = profile.work_anchor_id
    return SocietyWorld("population-test", pop, FixtureMobility())


def decision(action: str, key: str, **kwargs) -> ResidentDecision:
    return ResidentDecision(proposal=ActionProposal(action=action, idempotency_key=key, **kwargs),
                            summary=f"Fixture choice: {action}")


def turn(world: SocietyWorld, resident_id: str, action: str, **kwargs):
    world.advance(max(world.t, world.states[resident_id].next_decision_s))
    packets = world.begin_epoch([resident_id])
    assert len(packets) == 1
    return world.commit_decisions({resident_id: decision(action, f"{resident_id}:{world.epoch}", **kwargs)},
                                  source="rules")[0]


def ready_delivery(world: SocietyWorld):
    task = next(t for t in world.tasks.values() if t.kind == "delivery")
    worker = next(p for p in world.profiles.values() if "shop_worker" in p.roles)
    assert turn(world, worker.resident_id, "accept", target_id=task.task_id).accepted
    assert task.status == "preparing"
    world.advance(9)
    assert task.status == "preparing"
    world.advance(10)
    assert task.status == "ready"
    return task


def test_generation_is_reproducible_and_brains_do_not_regenerate_people():
    first = definition()
    again = generate_population(first.spec, anchors(), "fixture-network")
    assert first == again
    changed = first.spec.model_copy(deep=True)
    changed.brains = [BrainAssignment(model_family="claude", model_id="test-claude", api_provider="test",
                                      config_ref="other", control_mode="jiuwenswarm")]
    other = generate_population(changed, anchors(), "fixture-network")
    assert first.profiles == other.profiles
    assert first.initial_states == other.initial_states
    assert first.initial_tasks == other.initial_tasks
    assert first.anchors == other.anchors
    assert first.assignments != other.assignments
    assert len({p.persona for p in first.profiles}) == 12
    assert {s.role for s in first.initial_states} == {
        "customer", "shop_worker", "service_worker", "courier", "driver",
    }
    assert {v for p in first.profiles for v in p.available_classes} == {
        "pedestrian", "bicycle", "passenger", "delivery", "truck",
    }


def test_conflicts_commit_by_resident_id_not_response_order():
    worlds = [world_at_work(), world_at_work()]
    winners = []
    for index, world in enumerate(worlds):
        task = ready_delivery(world)
        couriers = sorted(p.resident_id for p in world.profiles.values() if "courier" in p.roles)
        world.begin_epoch(couriers)
        entries = [(r, decision("accept", f"{r}:claim", target_id=task.task_id)) for r in couriers]
        result = world.commit_decisions(dict(entries if index == 0 else reversed(entries)), source="rules")
        assert sum(r.accepted for r in result) == 1
        assert len(world.mobility.started) == 1
        winners.append(task.assignee_id)
    assert winners == [couriers[0], couriers[0]]


def test_delivery_needs_real_arrival_and_abstract_durations_before_completion():
    world = world_at_work()
    task = ready_delivery(world)
    courier = next(p.resident_id for p in world.profiles.values() if "courier" in p.roles)
    result = turn(world, courier, "accept", target_id=task.task_id)
    assert result.accepted and task.status == "assigned"
    assert task.completed_s is None
    pickup = world.mobility.started[-1]
    world.advance(15)
    world.mobility_arrived(courier, pickup["entity_id"], pickup["destination_id"])
    assert task.status == "assigned"
    world.advance(24)
    assert task.status == "assigned"
    world.advance(25)
    assert task.status == "picked_up"
    delivery = world.mobility.started[-1]
    assert delivery["destination_id"] == task.destination_anchor_id
    world.advance(30)
    world.mobility_arrived(courier, delivery["entity_id"], delivery["destination_id"])
    assert task.status == "picked_up"
    world.advance(40)
    assert task.status == "completed"
    assert task.completed_s == 40
    recipient = world.states[task.requester_id]
    assert recipient.needs["delivery"] == 0
    assert task.task_id not in recipient.commitments
    assert any(m.event_id in result.outcome_event_ids or "completed" in m.text for m in recipient.memories)
    assert world.states[courier].resident_id == courier
    assert len([b for b in world.mobility_bindings if b.resident_id == courier and b.measured]) == 2
    world.advance(160)
    assert recipient.needs["delivery"] > 0
    assert task.status == "completed"


def test_initial_definition_and_prior_snapshots_stay_frozen():
    world = world_at_work()
    initial = world.definition.model_dump(mode="json")
    earlier = [snapshot.model_dump(mode="json") for snapshot in world.state_history]
    ready_delivery(world)
    assert world.definition.model_dump(mode="json") == initial
    assert [snapshot.model_dump(mode="json") for snapshot in world.state_history[:len(earlier)]] == earlier


def test_service_capacity_contention_leaves_unfulfilled_requests_visible():
    world = world_at_work()
    world.anchors["shop"].capacity = 1
    tasks = [t for t in world.tasks.values() if t.kind == "delivery"]
    workers = [p.resident_id for p in world.profiles.values() if "shop_worker" in p.roles]
    world.begin_epoch(workers)
    records = world.commit_decisions({rid: decision("accept", f"claim:{rid}", target_id=task.task_id)
                                     for rid, task in zip(workers, tasks, strict=True)}, source="rules")
    assert sum(record.accepted for record in records) == 1
    assert any("capacity" in record.reason for record in records if not record.accepted)
    assert sum(task.status == "requested" for task in tasks) == 1


def test_private_observations_do_not_leak_other_residents_or_future_memories():
    world = world_at_work()
    one, two = list(world.states)[:2]
    world.states[two].memories.append(MemoryEntry(event_id="private", t=0, kind="observation", text="private-two"))
    packet = world.observation(one)
    assert "private-two" not in str(packet)
    packet["state"]["plan"].append("tampered")
    assert "tampered" not in world.states[one].plan
    world.advance(3)
    world.states[one].memories.append(MemoryEntry(event_id="future", t=20, kind="belief", text="future thought"))
    assert "future thought" not in str(world.observation(one))


def test_forged_stale_and_duplicate_intents_cannot_mutate_world():
    world = world_at_work()
    resident_id = next(iter(world.states))
    packet = world.begin_epoch([resident_id])[0]
    intent = ActionIntent(
        run_id=world.run_id, resident_id=resident_id, epoch=world.epoch, world_version=packet["world_version"],
        effective_t=world.t, expires_t=world.t, action="wait", duration_s=30, idempotency_key="same",
    )
    assert world.validate_intent(intent) is None
    for forged in (
        intent.model_copy(update={"run_id": "another-run"}),
        intent.model_copy(update={"resident_id": "unknown"}),
        intent.model_copy(update={"world_version": packet["world_version"] + 1}),
        intent.model_copy(update={"epoch": world.epoch + 1}),
        intent.model_copy(update={"expires_t": world.t - 1}),
    ):
        assert world.validate_intent(forged) is not None
    result = world.commit_decisions({resident_id: decision("wait", "same", duration_s=30)}, source="rules")
    count = len(world.events)
    assert result[0].accepted
    with pytest.raises(ValueError, match="epoch"):
        world.commit_decisions({resident_id: decision("wait", "same", duration_s=30)}, source="rules")
    assert len(world.events) == count


def test_unreachable_trip_is_rejected_and_provider_outage_is_honest_fallback():
    world = world_at_work()
    rid = next(r for r, s in world.states.items() if s.role == "customer")
    world.mobility.unreachable = True
    record = turn(world, rid, "travel", target_id="service", travel_class="pedestrian")
    assert not record.accepted
    assert "route" in record.reason
    assert not world.mobility.started
    state = world.states[rid]
    original_anchor = state.anchor_id
    world.advance(state.next_decision_s)
    world.begin_epoch([rid])
    result = world.commit_decisions({rid: None}, source="jiuwenswarm", failures={rid: "provider unavailable"})[0]
    assert result.source == "fallback"
    assert result.actual_model_id is None
    assert result.fallback_reason == "provider unavailable"
    assert world.states[rid].anchor_id == original_anchor
    assert len(world.states) == 12


def test_unfinished_decision_records_discarded_staged_message_without_delivering_it():
    world = world_at_work()
    sender = next(iter(world.profiles.values()))
    packet = world.begin_epoch([sender.resident_id])[0]
    proposal = ActionIntent(
        run_id=world.run_id, resident_id=sender.resident_id, epoch=world.epoch,
        world_version=packet["world_version"], effective_t=world.t, expires_t=world.t,
        action="message", target_id=sender.contacts[0], text="A staged message", idempotency_key="staged-only",
    )
    result = world.commit_decisions({sender.resident_id: None}, source="jiuwenswarm",
                                   staged_intents=[proposal], failures={sender.resident_id: "provider interrupted"})[0]
    assert result.source == "fallback" and not result.accepted
    assert result.proposal == proposal
    assert not world.messages
    assert any(event.kind == "message_rejected" and event.cause_id == result.decision_id for event in world.events)


def test_message_delivery_uses_next_simulation_time_and_known_contacts():
    world = world_at_work()
    sender = next(iter(world.profiles.values()))
    recipient = sender.contacts[0]
    record = turn(world, sender.resident_id, "message", target_id=recipient, text="Please wait for my reply.")
    assert record.accepted
    assert not world.observation(recipient)["messages"]
    world.advance(world.t + 1)
    assert world.observation(recipient)["messages"][0]["text"] == "Please wait for my reply."
    assert world.messages[0].delivered_s == world.t


def test_visit_service_requires_both_participants_and_time():
    world = world_at_work()
    task = next(t for t in world.tasks.values() if t.kind == "visit")
    worker = next(p.resident_id for p in world.profiles.values() if "service_worker" in p.roles)
    assert turn(world, worker, "accept", target_id=task.task_id).accepted
    assert task.status == "accepted"
    assert turn(world, task.requester_id, "visit", target_id=task.task_id).accepted
    trip = world.mobility.started[-1]
    world.advance(5)
    world.mobility_arrived(task.requester_id, trip["entity_id"], trip["destination_id"])
    assert task.status == "serving"
    world.advance(14)
    assert task.status == "serving"
    world.advance(15)
    assert task.status == "completed"
    assert world.states[task.requester_id].needs["visit"] == 0


def test_failed_delivery_keeps_request_and_need_accounted_for():
    world = world_at_work()
    task = ready_delivery(world)
    courier = next(p.resident_id for p in world.profiles.values() if "courier" in p.roles)
    assert turn(world, courier, "accept", target_id=task.task_id).accepted
    trip = world.mobility.started[-1]
    world.advance(11)
    world.mobility_failed(courier, trip["entity_id"], "route interrupted")
    assert task.status == "failed"
    assert task.failure_reason == "route interrupted"
    assert world.states[task.requester_id].needs["delivery"] > 0
    assert any("failed" in memory.text for memory in world.states[task.requester_id].memories)
    assert len(world.states) == len(world.profiles) == 12


@pytest.mark.parametrize("kind,anchor_id,role", [
    ("delivery", "shop", "shop_worker"), ("visit", "service", "service_worker"),
])
@pytest.mark.parametrize("limit", ["opening", "closing", "deadline"])
def test_acceptance_requires_a_feasible_service_window(kind, anchor_id, role, limit):
    world = world_at_work()
    task = next(t for t in world.tasks.values() if t.kind == kind)
    worker = next(p.resident_id for p in world.profiles.values() if role in p.roles)
    if limit == "opening":
        world.anchors[anchor_id].opens_s = 20
    elif limit == "closing":
        world.anchors[anchor_id].closes_s = 9
    else:
        task.deadline_s = 9
    record = turn(world, worker, "accept", target_id=task.task_id)
    assert not record.accepted
    assert task.status == "requested"
    assert task.provider_id is None
    assert not world.states[worker].current_task_id
    assert worker not in world._pending


@pytest.mark.parametrize("kind,anchor_id,role", [
    ("delivery", "shop", "shop_worker"), ("visit", "service", "service_worker"),
])
@pytest.mark.parametrize("arrival_s", [6, 16])
def test_late_provider_arrival_cannot_start_service_outside_its_window(kind, anchor_id, role, arrival_s):
    pop = definition()
    next(a for a in pop.anchors if a.anchor_id == anchor_id).closes_s = 15
    world = SocietyWorld("population-test", pop, FixtureMobility())
    task = next(t for t in world.tasks.values() if t.kind == kind)
    worker = next(p.resident_id for p in world.profiles.values() if role in p.roles)
    assert turn(world, worker, "accept", target_id=task.task_id).accepted
    trip = world.mobility.started[-1]
    world.advance(arrival_s)
    world.mobility_arrived(worker, trip["entity_id"], trip["destination_id"])
    assert task.status == "failed"
    assert task.ready_s is None
    assert world.states[worker].current_task_id is None
    assert worker not in world._pending
    assert world.completed_trips == 1
    assert world.states[task.requester_id].needs[kind] == 1


def test_explicit_serve_rejects_absent_or_uncommitted_requester():
    for present in (False, True):
        pop = world_at_work().definition
        task = next(t for t in pop.initial_tasks if t.kind == "visit")
        if present:
            next(s for s in pop.initial_states if s.resident_id == task.requester_id).anchor_id = "service"
        world = SocietyWorld("population-test", pop, FixtureMobility())
        worker = next(p.resident_id for p in world.profiles.values() if "service_worker" in p.roles)
        assert turn(world, worker, "accept", target_id=task.task_id).accepted
        record = turn(world, worker, "serve", target_id=task.task_id)
        assert not record.accepted
        assert world.tasks[task.task_id].status == "accepted"
        assert worker not in world._pending
        assert world.states[task.requester_id].current_task_id is None


def delivery_in_transit(world: SocietyWorld):
    task = ready_delivery(world)
    courier = next(p.resident_id for p in world.profiles.values() if "courier" in p.roles)
    assert turn(world, courier, "accept", target_id=task.task_id).accepted
    trip = world.mobility.started[-1]
    world.advance(15)
    world.mobility_arrived(courier, trip["entity_id"], trip["destination_id"])
    world.advance(25)
    assert task.status == "picked_up"
    return task, courier, world.mobility.started[-1]


def test_explicit_deliver_rejects_absent_recipient_then_measured_arrival_wakes_delivery():
    pop = world_at_work().definition
    task = next(t for t in pop.initial_tasks if t.kind == "delivery")
    next(s for s in pop.initial_states if s.resident_id == task.requester_id).anchor_id = "rest"
    world = SocietyWorld("population-test", pop, FixtureMobility())
    task, courier, trip = delivery_in_transit(world)
    world.advance(30)
    world.mobility_arrived(courier, trip["entity_id"], trip["destination_id"])
    assert task.status == "picked_up"
    assert courier not in world._pending
    record = turn(world, courier, "deliver", target_id=task.task_id)
    assert not record.accepted
    assert task.completed_s is None
    assert turn(world, task.requester_id, "travel", target_id=task.destination_anchor_id).accepted
    recipient_trip = world.mobility.started[-1]
    world.advance(world.t + 5)
    world.mobility_arrived(task.requester_id, recipient_trip["entity_id"], recipient_trip["destination_id"])
    start = world.t
    assert world._pending[courier][0] == "deliver"
    assert world.states[task.requester_id].busy_until_s == start + 10
    world.advance(start + 9)
    assert task.completed_s is None
    world.advance(start + 10)
    assert task.status == "completed"


@pytest.mark.parametrize("stage", ["pickup", "delivery"])
@pytest.mark.parametrize("limit", ["opening", "closing", "deadline"])
def test_actual_arrival_cannot_start_an_infeasible_handoff(stage, limit):
    world = world_at_work()
    if stage == "pickup":
        task = ready_delivery(world)
        courier = next(p.resident_id for p in world.profiles.values() if "courier" in p.roles)
        assert turn(world, courier, "accept", target_id=task.task_id).accepted
        trip = world.mobility.started[-1]
        arrival = 15
        anchor_id = task.service_anchor_id
    else:
        task, courier, trip = delivery_in_transit(world)
        arrival = 30
        anchor_id = task.destination_anchor_id
    if limit == "opening":
        world.anchors[anchor_id].opens_s = arrival + 20
    elif limit == "closing":
        world.anchors[anchor_id].closes_s = arrival + 9
    else:
        task.deadline_s = arrival + 9
    world.advance(arrival)
    world.mobility_arrived(courier, trip["entity_id"], trip["destination_id"])
    assert courier not in world._pending
    assert task.completed_s is None
    assert task.status in ({"assigned", "picked_up"} if limit == "opening" else {"failed", "expired"})
    assert world.states[task.requester_id].needs["delivery"] > 0
    if limit == "opening":
        assert world.states[courier].next_decision_s <= arrival + 20
        world.advance(arrival + 20)
        record = turn(world, courier, "pickup" if stage == "pickup" else "deliver", target_id=task.task_id)
        assert record.accepted
        assert world._pending[courier][1] == arrival + 30
        world.advance(arrival + 29)
        assert task.completed_s is None
        world.advance(arrival + 30)
        assert task.status == ("picked_up" if stage == "pickup" else "completed")


def test_service_requires_ownership_and_cannot_replace_another_commitment():
    world = world_at_work()
    visits = [t for t in world.tasks.values() if t.kind == "visit"]
    worker = next(p.resident_id for p in world.profiles.values() if "service_worker" in p.roles)
    assert turn(world, worker, "accept", target_id=visits[0].task_id).accepted
    stranger = next(r for r, s in world.states.items() if s.role == "shop_worker")
    assert not turn(world, stranger, "serve", target_id=visits[0].task_id).accepted
    requester = visits[0].requester_id
    own_delivery = next(t for t in world.tasks.values() if t.kind == "delivery")
    world.states[requester].current_task_id = own_delivery.task_id
    result = turn(world, requester, "visit", target_id=visits[0].task_id)
    assert not result.accepted
    assert world.states[requester].current_task_id == own_delivery.task_id
    assert not world.mobility.started


def test_capacity_and_explicit_refusal_leave_independent_jobs_unfulfilled():
    world = world_at_work()
    task = ready_delivery(world)
    couriers = [p.resident_id for p in world.profiles.values() if "courier" in p.roles]
    first, second = couriers
    world.profiles[first].carrying_capacity = 1
    task.required_capacity = 2
    assert not turn(world, first, "accept", target_id=task.task_id).accepted
    assert task.assignee_id is None
    assert turn(world, second, "decline", target_id=task.task_id).accepted
    assert task.status == "ready"
    assert second in task.declined_by
    assert not turn(world, second, "accept", target_id=task.task_id).accepted
    assert world.states[task.requester_id].needs["delivery"] == 1
    assert not world.mobility.started


def test_finished_provider_cannot_release_another_residents_transport_commitment():
    world = world_at_work()
    task = ready_delivery(world)
    courier = next(r for r, s in world.states.items() if s.role == "courier")
    assert turn(world, courier, "accept", target_id=task.task_id).accepted
    provider = task.provider_id
    assert world.states[provider].current_task_id is None
    record = turn(world, provider, "decline", target_id=task.task_id)
    assert not record.accepted
    assert task.status == "assigned"
    assert world.states[courier].current_task_id == task.task_id
    assert world.states[task.requester_id].needs["delivery"] == 1


def test_delay_is_not_a_deadline_extension_without_requester_agreement():
    world = world_at_work()
    task = ready_delivery(world)
    provider = task.provider_id
    deadline = task.deadline_s
    assert turn(world, provider, "report_delay", target_id=task.task_id, text="I need more time.").accepted
    assert task.deadline_s == deadline
    assert not turn(world, provider, "revise_commitment", target_id=task.task_id, duration_s=60).accepted
    assert task.deadline_s == deadline
    assert turn(world, task.requester_id, "revise_commitment", target_id=task.task_id, duration_s=60).accepted
    assert task.deadline_s == deadline + 60
    assert task.status == "ready" and task.completed_s is None


def test_baseline_priorities_can_choose_rest_instead_of_cooperation():
    world = world_at_work()
    ready_delivery(world)
    couriers = [p.resident_id for p in world.profiles.values() if "courier" in p.roles]
    for rid, priority in zip(couriers, (0.9, 0.35), strict=True):
        world.profiles[rid].preferences["work_priority"] = priority
        world.states[rid].needs["rest"] = 0.3
    proposals = [baseline_decision(world.observation(rid)).proposal for rid in couriers]
    assert [p.action for p in proposals] == ["accept", "rest"]
    assert not world.mobility.started


def outcome(trip: dict, t: int, status="arrived") -> MobilityOutcome:
    return MobilityOutcome(trip["resident_id"], trip["entity_id"], trip["destination_id"], t, status,
                           "route interrupted" if status == "failed" else "")


@pytest.mark.parametrize("provider_status", ["arrived", "failed"])
def test_batch_arrivals_are_order_independent_and_apply_before_service(provider_status):
    worlds = [SocietyWorld("population-test", definition(), FixtureMobility()) for _ in range(2)]
    for index, world in enumerate(worlds):
        task = next(t for t in world.tasks.values() if t.kind == "visit")
        worker = next(p.resident_id for p in world.profiles.values() if "service_worker" in p.roles)
        assert turn(world, worker, "accept", target_id=task.task_id).accepted
        assert turn(world, task.requester_id, "visit", target_id=task.task_id).accepted
        trips = world.mobility.started
        results = [outcome(trip, 5, provider_status if trip["resident_id"] == worker else "arrived") for trip in trips]
        world.advance(5, outcomes=results if index == 0 else list(reversed(results)))
        assert task.status == ("serving" if provider_status == "arrived" else "failed")
        if provider_status == "arrived":
            world.advance(15)
            assert task.status == "completed"
        else:
            world.advance(15)
            assert task.completed_s is None
            assert not any(event.kind == "service_started" for event in world.events)
    assert worlds[0].checkpoint_state() == worlds[1].checkpoint_state()


def test_batch_mobility_outcomes_precede_same_time_timed_completions():
    world = world_at_work()
    task = next(t for t in world.tasks.values() if t.kind == "delivery")
    worker = next(p.resident_id for p in world.profiles.values() if "shop_worker" in p.roles)
    assert turn(world, worker, "accept", target_id=task.task_id).accepted
    courier = next(p.resident_id for p in world.profiles.values() if "courier" in p.roles)
    assert turn(world, courier, "travel", target_id="rest").accepted
    version = world.version
    world.advance(10, [outcome(world.mobility.started[-1], 10)])
    kinds = [event.kind for event in world.events if event.t == 10]
    assert kinds.index("trip_arrived") < kinds.index("task_ready")
    assert world.version == version + 1


@pytest.mark.parametrize("bad_batch", ["time", "duplicate", "destination", "resident"])
def test_invalid_mobility_batch_is_rejected_before_mutation(bad_batch):
    world = world_at_work()
    courier = next(p.resident_id for p in world.profiles.values() if "courier" in p.roles)
    assert turn(world, courier, "travel", target_id="rest").accepted
    valid = outcome(world.mobility.started[-1], 5)
    if bad_batch == "time":
        results = [outcome(world.mobility.started[-1], 4)]
    elif bad_batch == "duplicate":
        results = [valid, valid]
    elif bad_batch == "destination":
        results = [MobilityOutcome(courier, valid.entity_id, "service", 5, "arrived")]
    else:
        results = [MobilityOutcome("unknown", valid.entity_id, "rest", 5, "arrived")]
    before = world.checkpoint_state()
    with pytest.raises(ValueError):
        world.advance(5, results)
    assert world.checkpoint_state() == before


@pytest.mark.parametrize("status", ["arrived", "failed"])
def test_direct_mobility_outcomes_cannot_mutate_an_open_decision_epoch(status):
    world = world_at_work()
    courier = next(p.resident_id for p in world.profiles.values() if "courier" in p.roles)
    assert turn(world, courier, "travel", target_id="rest").accepted
    trip = world.mobility.started[-1]
    world.begin_epoch([next(r for r in world.due_residents() if r != courier)])
    with pytest.raises(ValueError, match="epoch"):
        if status == "arrived":
            world.mobility_arrived(courier, trip["entity_id"], trip["destination_id"])
        else:
            world.mobility_failed(courier, trip["entity_id"], "route interrupted")
    assert world.states[courier].activity == "traveling"


def test_completed_empty_wait_is_idle_until_a_known_need_or_routine():
    world = world_at_work()
    rid = next(r for r, s in world.states.items() if s.role == "courier")
    assert turn(world, rid, "wait", duration_s=30).accepted
    world.advance(29)
    assert world.states[rid].activity == "waiting"
    world.advance(30)
    state = world.states[rid]
    assert state.activity == "idle"
    assert rid not in world.due_residents()
    assert state.next_decision_s == state.next_need_s
    count = len(world.decisions)
    world.advance(state.next_need_s - 1)
    assert rid not in world.due_residents()
    world.advance(state.next_need_s)
    assert rid in world.due_residents()
    assert len(world.decisions) == count


def test_completed_wait_keeps_its_choice_boundary_when_an_eligible_job_exists():
    world = world_at_work()
    task = ready_delivery(world)
    rid = next(r for r, s in world.states.items() if s.role == "courier")
    assert turn(world, rid, "wait", duration_s=30).accepted
    world.advance(39)
    assert rid not in world.due_residents()
    world.advance(40)
    assert rid in world.due_residents()
    assert task.status == "ready" and task.assignee_id is None


def test_declined_job_does_not_keep_an_empty_wait_polling():
    world = world_at_work()
    task = ready_delivery(world)
    rid = next(r for r, s in world.states.items() if s.role == "courier")
    assert turn(world, rid, "decline", target_id=task.task_id).accepted
    assert turn(world, rid, "wait", duration_s=30).accepted
    world.advance(world.t + 30)
    assert world.states[rid].activity == "idle"
    assert rid not in world.due_residents()
    assert task.status == "ready"


def test_task_board_change_wakes_an_idle_eligible_worker_without_a_new_decision():
    world = world_at_work()
    courier = next(r for r, s in world.states.items() if s.role == "courier")
    assert turn(world, courier, "wait", duration_s=30).accepted
    world.advance(30)
    assert courier not in world.due_residents()
    task = next(t for t in world.tasks.values() if t.kind == "delivery")
    worker = next(r for r, s in world.states.items() if s.role == "shop_worker")
    assert turn(world, worker, "accept", target_id=task.task_id).accepted
    count = len(world.decisions)
    world.advance(40)
    assert courier in world.due_residents()
    assert len(world.decisions) == count
    assert task.status == "ready"


def test_delivered_contact_message_wakes_only_its_idle_recipient():
    world = world_at_work()
    idlers = [r for r, s in world.states.items() if s.role == "courier"]
    for rid in idlers:
        assert turn(world, rid, "wait", duration_s=30).accepted
    world.advance(30)
    assert not set(idlers) & set(world.due_residents())
    recipient, outsider = idlers
    sender = next(p.resident_id for p in world.profiles.values() if recipient in p.contacts and p.resident_id not in idlers)
    assert turn(world, sender, "message", target_id=recipient, text="A relevant local update.").accepted
    world.advance(31)
    assert recipient in world.due_residents()
    assert outsider not in world.due_residents()
    assert "local update" not in str(world.observation(outsider))


def test_failed_unknown_location_never_becomes_eligible_from_a_recurring_need():
    world = world_at_work()
    task = ready_delivery(world)
    rid = next(r for r, s in world.states.items() if s.role == "courier")
    assert turn(world, rid, "accept", target_id=task.task_id).accepted
    trip = world.mobility.started[-1]
    world.advance(11)
    world.mobility_failed(rid, trip["entity_id"], "body disappeared")
    world.advance(world.states[rid].next_need_s)
    assert world.states[rid].anchor_id is None
    assert rid not in world.due_residents()
    assert world.states[rid].next_decision_s > world.definition.spec.horizon_s
    assert world.failed_trips == 1


def test_observation_estimates_are_shared_only_inside_one_immutable_epoch():
    world = world_at_work()
    packets = world.begin_epoch()
    counts = Counter(world.mobility.estimates)
    assert max(counts.values()) == 1
    assert len(packets) == 12
    first = next(packet for packet in packets if packet["trip_options"])
    first["trip_options"][0]["reachable"] = "tampered"
    assert all(option["reachable"] is True for packet in packets if packet is not first for option in packet["trip_options"])
    world.commit_decisions({p["resident_id"]: decision("wait", f"wait:{p['resident_id']}") for p in packets}, source="rules")
    world.mobility.unreachable = True
    assert all(not option["reachable"] for option in world.observation(first["resident_id"])["trip_options"])


def test_private_packet_has_one_bounded_recall_copy_but_artifacts_keep_full_state():
    world = world_at_work()
    rid = next(iter(world.states))
    packet = world.observation(rid)
    assert "memories" not in packet["state"]
    assert packet["memories"]
    packet["memories"][0]["text"] = "tampered"
    assert world.states[rid].memories[0].text != "tampered"
    assert world.artifact("test").states[0].state.memories


def test_unreachable_routine_and_jobs_do_not_poll_an_unchanged_empty_wait():
    world = SocietyWorld("population-test", definition(), FixtureMobility(unreachable=True))
    worker = next(r for r, s in world.states.items() if s.role == "shop_worker")
    assert baseline_decision(world.observation(worker)).proposal.action == "wait"
    assert turn(world, worker, "wait", duration_s=30).accepted
    world.advance(30)
    assert worker not in world.due_residents()
    assert world.states[worker].activity == "idle"


def test_idle_worker_wakes_when_service_capacity_is_released():
    world = world_at_work()
    world.anchors["shop"].capacity = 1
    workers = [r for r, s in world.states.items() if s.role == "shop_worker"]
    task = next(t for t in world.tasks.values() if t.kind == "delivery")
    assert turn(world, workers[0], "accept", target_id=task.task_id).accepted
    assert turn(world, workers[1], "wait", duration_s=5).accepted
    world.advance(5)
    assert workers[1] not in world.due_residents()
    assert world.states[workers[1]].next_decision_s > 30
    world.advance(10)
    assert workers[1] in world.due_residents()


def test_baseline_retries_pickup_only_after_its_anchor_capacity_is_available():
    world = world_at_work()
    world.anchors["shop"].capacity = 1
    task = ready_delivery(world)
    other_task = next(t for t in world.tasks.values() if t.kind == "delivery" and t != task)
    other_worker = next(r for r, s in world.states.items() if s.role == "shop_worker" and r != task.provider_id)
    courier = next(r for r, s in world.states.items() if s.role == "courier")
    assert turn(world, other_worker, "accept", target_id=other_task.task_id).accepted
    assert turn(world, courier, "accept", target_id=task.task_id).accepted
    trip = world.mobility.started[-1]
    world.advance(15)
    world.mobility_arrived(courier, trip["entity_id"], trip["destination_id"])
    assert courier not in world._pending
    assert baseline_decision(world.observation(courier)).proposal.action == "wait"
    world.advance(20)
    assert courier in world.due_residents()
    proposal = baseline_decision(world.observation(courier)).proposal
    assert proposal.action == "pickup" and proposal.target_id == task.task_id
    assert task.status == "assigned"


def test_resting_delivery_recipient_is_not_forced_to_cooperate_early():
    world = world_at_work()
    task, courier, trip = delivery_in_transit(world)
    assert turn(world, task.requester_id, "rest", duration_s=20).accepted
    world.advance(30)
    world.mobility_arrived(courier, trip["entity_id"], trip["destination_id"])
    assert world.states[task.requester_id].activity == "resting"
    assert courier not in world._pending
    assert baseline_decision(world.observation(courier)).proposal.action == "wait"
    world.advance(44)
    assert task.completed_s is None
    world.advance(45)
    assert world._pending[courier][1] == 55
    assert world.states[task.requester_id].busy_until_s == 55
    world.advance(55)
    assert task.status == "completed"


def test_completion_cannot_overrun_closing_or_turn_a_late_preparation_into_a_ready_job():
    world = world_at_work()
    task = next(t for t in world.tasks.values() if t.kind == "delivery")
    worker = next(r for r, s in world.states.items() if s.role == "shop_worker")
    world.anchors["shop"].closes_s = 10
    assert turn(world, worker, "accept", target_id=task.task_id).accepted
    world.advance(11)
    assert task.status == "failed"
    assert task.ready_s is None
    assert not any(event.kind == "task_ready" for event in world.events)
    assert not world._pending


def test_rules_decision_never_claims_a_native_model_even_with_an_extraneous_binding():
    world = world_at_work()
    rid = next(iter(world.states))
    binding = SwarmBinding(resident_id=rid, run_id=world.run_id, team_id="unused-team", workflow_id="unused-workflow",
                           session_id="unused-session", worker_id="unused-worker", requested_model_id="baseline-v1",
                           resolved_model_id="not-a-rules-model")
    world.begin_epoch([rid])
    record = world.commit_decisions({rid: decision("wait", "rules-only", duration_s=30)}, source="rules",
                                    bindings={rid: binding})[0]
    assert record.source == "rules" and record.actual_model_id is None
    assert not world.swarm_bindings


def test_scoped_board_limit_never_hides_the_residents_current_commitment():
    original = definition()
    pop = generate_population(original.spec.model_copy(update={"count": 240}), anchors(), "fixture-network")
    provider = next(p.resident_id for p in pop.profiles if "shop_worker" in p.roles)
    courier = next(p.resident_id for p in pop.profiles if "courier" in p.roles)
    deliveries = [task for task in pop.initial_tasks if task.kind == "delivery"]
    assert len(deliveries) > 32
    for task in deliveries:
        task.status, task.provider_id, task.ready_s = "ready", provider, 0
    current = deliveries[0]
    current.status, current.assignee_id = "assigned", courier
    state = next(state for state in pop.initial_states if state.resident_id == courier)
    state.current_task_id = current.task_id
    state.commitments.append(current.task_id)
    world = SocietyWorld("array-only", pop, FixtureMobility())
    packet = world.observation(courier)
    assert len(packet["tasks"]) <= 32
    assert current.task_id in {task["task_id"] for task in packet["tasks"]}
    assert len(world.tasks) == len(pop.initial_tasks)


def test_array_scale_empty_waits_do_not_schedule_city_wide_polling():
    original = definition()
    spec = original.spec.model_copy(update={"count": 240}, deep=True)
    pop = generate_population(spec, anchors(), "fixture-network")
    world = SocietyWorld("array-only", pop, FixtureMobility())
    packets = world.begin_epoch()
    assert len(packets) == 240
    world.commit_decisions({p["resident_id"]: decision("wait", f"wait:{p['resident_id']}", duration_s=30)
                            for p in packets}, source="rules")
    world.advance(30)
    due = set(world.due_residents())
    assert due == {rid for rid, p in world.profiles.items() if p.work_anchor_id is not None}
    assert all(s.activity == "idle" for s in world.states.values())
    assert world.metrics().resident_count == 240
    assert not world.mobility.started
