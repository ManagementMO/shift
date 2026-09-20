from __future__ import annotations

import math
import random
from collections import defaultdict
from typing import Any, Literal

import sumolib

from cityshift.contracts import (
    ActivityAnchor,
    AnchorAccess,
    CityPack,
    MemoryEntry,
    PopulationDefinition,
    PopulationSpec,
    ResidentProfile,
    ResidentRole,
    ResidentState,
    RoutineStep,
    SocietyTask,
    TravelClass,
    content_hash,
)

ROLE_CYCLE: tuple[ResidentRole, ...] = (
    "shop_worker", "service_worker", "courier", "driver", "customer", "customer",
    "shop_worker", "courier", "driver", "driver", "customer", "customer",
)
NAMES = ("Avery", "Sam", "Rowan", "Alex", "Jordan", "Taylor", "Morgan", "Casey", "Robin", "Quinn", "Riley", "Jamie")


def generate_population(spec: PopulationSpec, anchors: list[ActivityAnchor], network_fingerprint: str) -> PopulationDefinition:
    by_purpose: dict[str, list[ActivityAnchor]] = defaultdict(list)
    for anchor in sorted(anchors, key=lambda a: a.anchor_id):
        by_purpose[anchor.purpose].append(anchor)
    if any(not by_purpose[kind] for kind in ("home", "shop", "service")):
        raise ValueError("population needs declared home, shop, and service anchors")
    if len({a.anchor_id for a in anchors}) != len(anchors):
        raise ValueError("duplicate activity anchor")
    if any(set(spec.enabled_classes) - set(a.access) for a in anchors):
        raise ValueError("every district anchor must support all enabled travel classes")
    rng = random.Random(spec.seed)
    residents: list[ResidentProfile] = []
    states: list[ResidentState] = []
    driver_count = 0
    drive_classes: list[TravelClass] = [c for c in ("passenger", "delivery", "truck") if c in spec.enabled_classes]
    for i in range(spec.count):
        rid = f"resident-{i + 1:04d}"
        role = ROLE_CYCLE[i % len(ROLE_CYCLE)]
        home = by_purpose["home"][rng.randrange(len(by_purpose["home"]))]
        work = None
        if role == "shop_worker":
            work = by_purpose["shop"][i % len(by_purpose["shop"])]
        elif role == "service_worker":
            work = by_purpose["service"][i % len(by_purpose["service"])]
        classes: list[TravelClass] = ["pedestrian"]
        if role == "courier" and "bicycle" in spec.enabled_classes:
            classes.append("bicycle")
        elif role == "driver" and drive_classes:
            classes.append(drive_classes[driver_count % len(drive_classes)])
            driver_count += 1
        elif role == "customer" and i % 3 == 1 and "bicycle" in spec.enabled_classes:
            classes.append("bicycle")
        patience = rng.choice((60, 120, 240, 360))
        helpfulness = round(rng.uniform(0.25, 0.95), 2)
        work_priority = round(rng.uniform(0.35, 0.95), 2)
        name = f"{NAMES[rng.randrange(len(NAMES))]} {i + 1:03d}"
        preference = rng.choice(("predictable commitments", "helping familiar contacts", "short local trips", "regular breaks"))
        persona = (f"{name} is a synthetic {role.replace('_', ' ')} who values {preference}. "
                   f"They tolerate about {patience} seconds of uncertainty, have helpfulness {helpfulness}, "
                   f"and work priority {work_priority}. They may decline work and have their own needs.")
        routine = [RoutineStep(activity="work", anchor_id=work.anchor_id, earliest_s=0,
                               duration_s=min(spec.horizon_s, 900))] if work else []
        routine.append(RoutineStep(activity="home", anchor_id=home.anchor_id,
                                   earliest_s=max(0, spec.horizon_s - 300), duration_s=300))
        capacity = {"truck": 12, "delivery": 6, "passenger": 3, "bicycle": 2}.get(classes[-1], 1)
        profile = ResidentProfile(
            resident_id=rid, name=name, persona=persona, roles=[role] if role == "customer" else [role, "customer"],
            preferences={"patience_s": patience, "helpfulness": helpfulness, "work_priority": work_priority,
                         "preferred_class": classes[-1], "focus": preference},
            home_anchor_id=home.anchor_id, work_anchor_id=work.anchor_id if work else None,
            household_id=f"household-{i // 3:03d}",
            organization_id=work.anchor_id if work else ("local-couriers" if role in {"driver", "courier"} else None),
            available_classes=classes, carrying_capacity=capacity, routine=routine,
        )
        residents.append(profile)
        states.append(ResidentState(
            resident_id=rid, role=role, anchor_id=home.anchor_id,
            needs={"delivery": 0.3, "visit": 0.2, "rest": round(rng.uniform(0.05, 0.35), 2)},
            vehicle_locations={c: home.anchor_id for c in classes if c != "pedestrian"},
            next_need_s=spec.recurring_need_s + rng.randrange(max(1, spec.recurring_need_s // 4)),
            plan=[f"Begin my work commitment at {work.anchor_id}."] if work else ["Consider local needs and opportunities."],
            memories=[MemoryEntry(event_id=f"initial-{rid}", t=0, kind="observation",
                                  text=f"My declared home is {home.anchor_id}; my role is {role}.")],
        ))
    for i, profile in enumerate(residents):
        indices = {(i - 1) % spec.count, (i + 1) % spec.count, (i + 3) % spec.count}
        profile.contacts = sorted(residents[j].resident_id for j in indices if j != i)
        states[i].relationships = {rid: 0.5 for rid in profile.contacts}
    tasks: list[SocietyTask] = []
    customer_number = 0
    for profile, state in zip(residents, states, strict=True):
        if state.role != "customer":
            continue
        kind: Literal["delivery", "visit"] = "delivery" if customer_number % 2 == 0 else "visit"
        service = by_purpose["shop" if kind == "delivery" else "service"][0]
        tid = f"request-initial-{profile.resident_id}"
        tasks.append(SocietyTask(
            task_id=tid, kind=kind, requester_id=profile.resident_id, service_anchor_id=service.anchor_id,
            destination_anchor_id=profile.home_anchor_id, created_s=0,
            deadline_s=max(300, min(1200, spec.horizon_s)), cause_id=f"initial-{profile.resident_id}",
        ))
        state.needs[kind] = 1
        state.commitments.append(tid)
        customer_number += 1
    frozen_anchors = sorted((a.model_copy(deep=True) for a in anchors), key=lambda a: a.anchor_id)
    identity = {"spec": spec.model_dump(mode="json"), "network": network_fingerprint,
                "anchors": [a.model_dump(mode="json") for a in frozen_anchors]}
    return PopulationDefinition(
        population_id=f"population-{content_hash(identity)}", spec=spec.model_copy(deep=True),
        network_fingerprint=network_fingerprint, anchors=frozen_anchors, profiles=residents,
        initial_states=states, initial_tasks=tasks,
        assignments={p.resident_id: spec.brains[i % len(spec.brains)].model_copy(deep=True)
                     for i, p in enumerate(residents)},
        assumptions=[
            "All residents, roles, homes, contacts, needs, and service requests are explicitly synthetic.",
            "Declared access anchors represent abstract presence, not measured building interiors.",
            "Services consume declared capacity and duration; pickup and delivery each take ten simulated seconds.",
            "Deliveries require the requester at the declared destination anchor; absent recipients can cause delay or failure.",
            "No wages, prices, disasters, policy interventions, or long-horizon consequence model are included.",
        ],
    )


def district_anchors(pack: CityPack, spec: PopulationSpec) -> list[ActivityAnchor]:
    net = sumolib.net.readNet(pack.net_file)
    if not net.hasGeoProj():
        raise ValueError("city district requires a georeferenced network; use explicit anchors for synthetic fixtures")
    cx, cy = net.convertLonLat2XY(*pack.center)
    candidates: list[tuple[float, str, Any]] = []
    for edge in net.getEdges():
        if edge.isSpecial() or edge.getLength() < 30 or not all(edge.allows(c) for c in spec.enabled_classes):
            continue
        x, y = sumolib.geomhelper.positionAtShapeOffset(edge.getShape(), edge.getLength() / 2)
        distance = math.hypot(x - cx, y - cy)
        if distance <= spec.district_radius_m:
            candidates.append((distance, edge.getID(), edge))
    candidates.sort(key=lambda row: (row[0], row[1]))
    driving = [c for c in spec.enabled_classes if c != "pedestrian"]
    chosen: list[Any] = []
    for _, _, edge in candidates:
        if all(net.getShortestPath(other, edge, vClass=c)[0] is not None
               and net.getShortestPath(edge, other, vClass=c)[0] is not None
               for other in chosen for c in driving):
            chosen.append(edge)
        if len(chosen) == 8:
            break
    if len(chosen) < 8:
        raise ValueError("no connected eight-anchor district supports all enabled travel classes")
    purposes: tuple[Literal["home", "shop", "service", "work", "rest"], ...] = (
        "shop", "service", "home", "home", "home", "home", "work", "rest",
    )
    anchors = []
    for i, (edge, purpose) in enumerate(zip(chosen, purposes, strict=True)):
        access = {}
        for travel_class in spec.enabled_classes:
            lane = next(lane for lane in edge.getLanes() if lane.allows(travel_class))
            access[travel_class] = AnchorAccess(edge_id=edge.getID(), lane_index=lane.getIndex(),
                                                position_m=round(lane.getLength() / 2, 2))
        pedestrian = access["pedestrian"]
        shape = edge.getLanes()[pedestrian.lane_index].getShape()
        x, y = sumolib.geomhelper.positionAtShapeOffset(shape, pedestrian.position_m)
        lon, lat = net.convertXY2LonLat(x, y)
        anchors.append(ActivityAnchor(
            anchor_id=f"district-{purpose}-{i:02d}", name=f"Declared {purpose} anchor {i + 1}", purpose=purpose,
            lon=lon, lat=lat, access=access, capacity=max(2, spec.count // 12) if purpose in {"shop", "service"} else spec.count,
            closes_s=spec.horizon_s + 1, service_duration_s=spec.service_duration_s,
        ))
    return anchors
