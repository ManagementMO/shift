from __future__ import annotations

from dataclasses import dataclass, field
from types import SimpleNamespace

import pytest
from test_population_world import FixtureMobility, decision, definition, turn

from cityshift.agents.population_baseline import baseline_decision
from cityshift.contracts import PopulationStimulus
from cityshift.domain.society import WORD_OF_MOUTH_HOPS, SocietyWorld
from cityshift.transport.hazards import resident_classes
from cityshift.transport.population import MobilityOutcome, RouteNotice


@dataclass
class TravelMobility(FixtureMobility):
    """Fixture transport that also reports where bodies are and can send a travelling body elsewhere."""

    tracks: dict = field(default_factory=dict)
    route: str = "clear"
    junction: bool = False
    ready: bool = True

    def trip_ready(self, resident_id):
        return self.ready

    def start_trip(self, resident_id, origin, destination, travel_class):
        entity_id = super().start_trip(resident_id, origin, destination, travel_class)
        self.tracks[entity_id] = SimpleNamespace(samples=[[self.t, origin.lon, origin.lat, 0.0, 1.0]])
        return entity_id

    def trip_status(self, resident_id):
        trip = [row for row in self.started if row["resident_id"] == resident_id][-1]
        return {"destination_id": trip["destination_id"], "travel_class": trip["travel_class"], "position": None,
                "route": self.route, "blocked_by": ["fire-1"] if self.route == "blocked" else []}

    def estimate_redirect(self, resident_id, destination):
        return {"target_id": destination.anchor_id, "reachable": True, "duration_s": 5, "distance_m": 50, "reason": ""}

    def redirect_trip(self, resident_id, destination):
        if self.junction:
            raise ValueError("The body is crossing a junction; redirect once it reaches a street")
        trip = [row for row in self.started if row["resident_id"] == resident_id][-1]
        return self.start_trip(resident_id, SimpleNamespace(lon=0, lat=0, anchor_id="here"), destination, trip["travel_class"])


def incident(stimulus_id: str, anchor, hazard: str = "fire", radius: float = 20, duration: int = 300) -> PopulationStimulus:
    return PopulationStimulus(stimulus_id=stimulus_id, kind="incident", hazard=hazard, text=f"A {hazard} near {anchor.name}.",
                              lon=anchor.lon, lat=anchor.lat, radius_m=radius, duration_s=duration)


def at(world: SocietyWorld, anchor_id: str) -> list[str]:
    return sorted(rid for rid, state in world.states.items() if state.anchor_id == anchor_id)


def arrive(world: SocietyWorld, rid: str, t: int | None = None) -> None:
    binding = world._active_body(rid)
    state = world.states[rid]
    t = world.t + 1 if t is None else t
    world.advance(t, [MobilityOutcome(rid, binding.entity_id, state.destination_id, t, "arrived")])


def go(world: SocietyWorld, rid: str, target: str) -> None:
    assert turn(world, rid, "travel", target_id=target, travel_class="pedestrian").accepted
    arrive(world, rid)


def test_incidents_are_seen_from_their_warning_radius_and_close_streets_only_while_active():
    pop = definition()
    world = SocietyWorld("society-incident", pop, FixtureMobility())
    anchors = {anchor.anchor_id: anchor for anchor in pop.anchors}
    # 20 m fire footprint, 60 m warning radius: home-a residents see it, home-b (about 80 m away) does not.
    fire = incident("fire-1", anchors["home-a"])
    assert world.apply_stimuli([fire])
    assert world.stimuli[0].resident_ids == at(world, "home-a")
    wider = incident("fire-2", anchors["home-a"], radius=30)  # 90 m warning radius now reaches home-b
    world.apply_stimuli([wider])
    assert set(world.stimuli[1].resident_ids) == set(at(world, "home-a") + at(world, "home-b"))
    receipt = world.states[at(world, "home-a")[0]].memories[-1].text
    assert "Vehicles cannot enter streets within 30 m" in receipt and "walking routes go around it" in receipt
    assert "no injuries" in receipt
    rain = incident("rain-1", anchors["home-a"], hazard="rain", radius=200)
    world.apply_stimuli([rain])
    assert "closes no streets" in world.states[at(world, "home-a")[0]].memories[-1].text
    footprints = {footprint.hazard_id: footprint for footprint in world.hazard_footprints()}
    assert set(footprints) == {"fire-1", "fire-2"}  # rain closes nothing
    assert footprints["fire-1"].classes == resident_classes("fire") and footprints["fire-1"].until_s == 300
    world.advance(300)
    assert world.hazard_footprints() == []


def test_word_of_mouth_spreads_between_people_at_the_same_place_within_its_hop_budget():
    pop = definition()
    for profile, state in zip(pop.profiles, pop.initial_states, strict=True):
        if profile.work_anchor_id:
            state.anchor_id = profile.work_anchor_id
    world = SocietyWorld("society-word", pop, FixtureMobility())
    anchors = {anchor.anchor_id: anchor for anchor in pop.anchors}
    # A 20 m shop fire is noticed within 60 m: the shop workers see it, the service counter 80 m away does not.
    witnesses = at(world, "shop")
    world.apply_stimuli([incident("fire-1", anchors["shop"], duration=3000)])
    assert witnesses and all(world.awareness[rid]["fire-1"].hop == 0 for rid in witnesses)
    staff = at(world, "service")
    assert staff and not any("fire-1" in world.awareness.get(rid, {}) for rid in staff)
    listener = next(rid for rid, state in world.states.items() if state.role == "customer")
    go(world, listener, "shop")
    heard = world.awareness[listener]["fire-1"]
    assert (heard.hop, heard.source) == (1, witnesses[0])
    assert world.states[listener].memories[-1].text.startswith(f"{witnesses[0]} told us at shop about the building fire")
    row = world.observation(listener)["external_observations"][0]
    assert (row["heard_from"], row["hop"], row["stimulus"]["stimulus_id"]) == (witnesses[0], 1, "fire-1")
    go(world, listener, "service")  # the listener retells it where others work
    assert all((world.awareness[rid]["fire-1"].hop, world.awareness[rid]["fire-1"].source) == (2, listener) for rid in staff)
    # A resident who heard it at the last retelling does not pass it on.
    teller, newcomer = staff[0], next(rid for rid, state in world.states.items()
                                      if state.anchor_id != "service" and "fire-1" not in world.awareness.get(rid, {}))
    for rid in world.awareness:
        if rid != teller:
            world.awareness[rid].pop("fire-1", None)
    world.awareness[teller]["fire-1"] = world.awareness[teller]["fire-1"].model_copy(update={"hop": WORD_OF_MOUTH_HOPS})
    go(world, newcomer, "service")
    assert "fire-1" not in world.awareness.get(newcomer, {})
    world = SocietyWorld("society-word", pop, FixtureMobility())
    world.apply_stimuli([incident("fire-1", anchors["shop"], duration=3000)])
    go(world, listener, "shop")
    saved = world.checkpoint_state()
    restored = SocietyWorld.from_checkpoint(world.run_id, pop, FixtureMobility(), saved)
    assert restored.awareness == world.awareness
    saved["awareness"][listener]["fire-1"]["source"] = None
    with pytest.raises(ValueError, match="awareness"):
        SocietyWorld.from_checkpoint(world.run_id, pop, FixtureMobility(), saved)


def test_travellers_who_see_an_incident_decide_mid_trip_and_can_redirect():
    pop = definition()
    mobility = TravelMobility()
    world = SocietyWorld("society-travel", pop, mobility)
    anchors = {anchor.anchor_id: anchor for anchor in pop.anchors}
    rid = at(world, "home-a")[0]
    assert turn(world, rid, "travel", target_id="shop", travel_class="pedestrian").accepted
    assert world.states[rid].activity == "traveling" and rid not in world.due_residents()
    world.apply_stimuli([incident("fire-1", anchors["home-a"], duration=3000)])
    assert rid in world.due_residents()  # its last measured position is inside the warning radius
    packet = world.begin_epoch([rid])[0]
    assert packet["trip"]["destination_id"] == "shop"
    assert {option["target_id"] for option in packet["trip"]["redirect_options"]} >= {"service", "rest"}
    assert "shop" not in {option["target_id"] for option in packet["trip"]["redirect_options"]}
    rejected = world.commit_decisions({rid: decision("wait", "k1", duration_s=30)}, source="rules")[0]
    assert not rejected.accepted and rejected.reason.startswith("resident is travelling")
    assert rid not in world.due_residents()  # the wake-up is spent on that decision
    mobility.junction = True
    world._wake_traveler(rid)
    world.begin_epoch([rid])
    busy = world.commit_decisions({rid: decision("redirect", "k2", target_id="rest")}, source="rules")[0]
    assert not busy.accepted and "junction" in busy.reason
    world.advance(world.t + 1)
    assert rid in world.due_residents()  # a junction is momentary; the same choice is offered next second
    mobility.junction = False
    old_body = world._active_body(rid).entity_id
    world.begin_epoch([rid])
    record = world.commit_decisions({rid: decision("redirect", "k3", target_id="rest")}, source="rules")[0]
    assert record.accepted and world.states[rid].destination_id == "rest"
    new_body = world._active_body(rid)
    assert new_body.entity_id != old_body and new_body.start_s == world.t
    assert world._trip_causes[new_body.entity_id] == record.decision_id
    assert next(b for b in world.mobility_bindings if b.entity_id == old_body).end_s == world.t
    assert world.events[-1].kind == "trip_redirected"
    arrive(world, rid)
    assert world.states[rid].anchor_id == "rest" and world.states[rid].activity == "idle"
    SocietyWorld.from_checkpoint(world.run_id, pop, TravelMobility(), world.checkpoint_state())


def test_route_notices_follow_replacement_bodies_and_wake_blocked_travellers():
    pop = definition()
    mobility = TravelMobility()
    world = SocietyWorld("society-routes", pop, mobility)
    anchors = {anchor.anchor_id: anchor for anchor in pop.anchors}
    world.apply_stimuli([incident("fire-1", anchors["rest"], duration=3000)])
    rid = at(world, "home-d")[0]
    assert turn(world, rid, "travel", target_id="shop", travel_class="pedestrian").accepted
    body = world._active_body(rid).entity_id
    with pytest.raises(ValueError, match="authoritative body"):
        world.note_routes([RouteNotice(rid, "body-x", "not-its-body", "diverted", ("fire-1",))])
    world.note_routes([RouteNotice(rid, "body-detour", body, "diverted", ("fire-1",))])
    assert world._active_body(rid).entity_id == "body-detour"
    assert world.events[-1].kind == "route_diverted" and "the building fire" in world.events[-1].text
    assert rid not in world.due_residents()  # a detour needs no decision
    world.note_routes([RouteNotice(rid, "body-detour", None, "blocked", ("fire-1",))])
    assert world.events[-1].kind == "route_blocked" and rid in world.due_residents()
    mobility.route = "blocked"
    packet = world.begin_epoch([rid])[0]
    choice = baseline_decision(packet)
    assert choice.proposal.action == "redirect" and choice.proposal.target_id == pop.profiles[
        [p.resident_id for p in pop.profiles].index(rid)].home_anchor_id
    world.commit_decisions({rid: None}, source="rules", failures={rid: "no usable decision"})
    assert world.states[rid].activity == "traveling"  # a failed decision never strands a traveller
    SocietyWorld.from_checkpoint(world.run_id, pop, TravelMobility(), world.checkpoint_state())


def test_redirecting_away_from_a_commitment_fails_it_and_continue_keeps_the_trip():
    pop = definition()
    world = SocietyWorld("society-commitment", pop, TravelMobility())
    for profile, state in zip(pop.profiles, world.states.values(), strict=True):
        if "shop_worker" in profile.roles:
            worker = profile.resident_id
            break
    task = next(t for t in world.tasks.values() if t.kind == "delivery")
    assert turn(world, worker, "accept", target_id=task.task_id).accepted
    assert world.states[worker].activity == "traveling" and world.states[worker].current_task_id == task.task_id
    world._wake_traveler(worker)
    world.begin_epoch([worker])
    assert world.commit_decisions({worker: decision("continue", "k1")}, source="rules")[0].accepted
    assert world.events[-1].kind == "trip_continued" and task.status == "accepted"
    world._wake_traveler(worker)
    world.begin_epoch([worker])
    assert world.commit_decisions({worker: decision("redirect", "k2", target_id="rest")}, source="rules")[0].accepted
    assert task.status == "failed" and "diverted" in task.failure_reason
    assert world.states[worker].current_task_id is None and world.states[worker].activity == "traveling"
    idle = at(world, "home-a")[0]
    world.begin_epoch([idle])
    stay = world.commit_decisions({idle: decision("continue", "k3")}, source="rules")[0]
    assert not stay.accepted and stay.reason == "no trip in progress to continue or redirect"


def test_checkpoint_rejects_wakes_for_residents_who_are_not_travelling():
    pop = definition()
    world = SocietyWorld("society-wake", pop, FixtureMobility())
    saved = world.checkpoint_state()
    saved["travel_wakes"] = [pop.profiles[0].resident_id]
    with pytest.raises(ValueError, match="not travelling"):
        SocietyWorld.from_checkpoint(world.run_id, pop, FixtureMobility(), saved)


def test_travellers_decide_only_once_their_body_is_on_a_street():
    pop = definition()
    mobility = TravelMobility()
    world = SocietyWorld("society-ready", pop, mobility)
    anchors = {anchor.anchor_id: anchor for anchor in pop.anchors}
    rid = at(world, "home-a")[0]
    assert turn(world, rid, "travel", target_id="shop", travel_class="pedestrian").accepted
    mobility.ready = False  # e.g. a detour body inserted this second, not yet walking
    world.apply_stimuli([incident("fire-1", anchors["home-a"], duration=3000)])
    assert rid in world._travel_wakes and rid not in world.due_residents()
    mobility.ready = True
    world.advance(world.t + 1)
    assert rid in world.due_residents()


def test_a_traveller_whose_way_stays_closed_is_asked_again_each_decision_interval():
    pop = definition()
    mobility = TravelMobility(route="blocked")
    world = SocietyWorld("society-held", pop, mobility)
    rid = at(world, "home-d")[0]
    assert turn(world, rid, "travel", target_id="shop", travel_class="pedestrian").accepted
    world._wake_traveler(rid)  # as a blocked route notice does
    interval = pop.spec.decision_interval_s
    for key in ("k1", "k2"):
        world.begin_epoch([rid])
        assert world.commit_decisions({rid: decision("continue", key)}, source="rules")[0].accepted
        assert rid not in world.due_residents()
        world.advance(world.t + interval - 1)
        assert rid not in world.due_residents()
        world.advance(world.t + 1)
        assert rid in world.due_residents()
    world.begin_epoch([rid])
    world.commit_decisions({rid: None}, source="rules", failures={rid: "no usable decision"})
    assert rid in world._travel_wakes  # a failed turn does not end the questions while the way is closed
    mobility.route = "clear"
    body = world._active_body(rid).entity_id
    world.note_routes([RouteNotice(rid, body, None, "cleared", ())])
    assert world.events[-1].kind == "route_cleared" and rid not in world._travel_wakes
    world.advance(world.t + interval)
    assert rid not in world.due_residents()  # once the way is open, no more mid-trip questions
    SocietyWorld.from_checkpoint(world.run_id, pop, TravelMobility(), world.checkpoint_state())


def test_a_replacement_body_is_located_where_the_previous_one_was_last_measured():
    pop = definition()
    mobility = TravelMobility()
    world = SocietyWorld("society-position", pop, mobility)
    anchors = {anchor.anchor_id: anchor for anchor in pop.anchors}
    rid = at(world, "home-d")[0]
    assert turn(world, rid, "travel", target_id="shop", travel_class="pedestrian").accepted
    old = world._active_body(rid).entity_id
    mobility.tracks[old].samples.append([world.t, anchors["rest"].lon, anchors["rest"].lat, 0.0, 1.0])
    mobility.tracks["body-detour"] = SimpleNamespace(samples=[])  # inserted this second, not measured yet
    world._swap_body(rid, "body-detour", None)  # as a diverted route notice does
    world.apply_stimuli([incident("fire-1", anchors["rest"], duration=3000)])
    assert rid in world.stimuli[0].resident_ids  # seen from where the walk was last measured
