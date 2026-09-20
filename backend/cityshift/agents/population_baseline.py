from __future__ import annotations

from typing import Any

from cityshift.contracts import ActionProposal, ResidentDecision
from cityshift.domain.society import TERMINAL_TASKS


def baseline_decision(observation: dict[str, Any]) -> ResidentDecision:
    profile, state = observation["profile"], observation["state"]
    rid, t = observation["resident_id"], observation["t"]
    tasks = observation["tasks"]
    preferences = profile["preferences"]
    key = f"{rid}:{observation['epoch']}"
    contacts = set(observation["contacts"])
    active = [task for task in tasks if task["status"] not in TERMINAL_TASKS]
    own = [task for task in active if task["requester_id"] == rid]
    available_classes = observation["available_classes"]
    preferred = preferences.get("preferred_class", "pedestrian")
    travel_class = preferred if preferred in available_classes else "pedestrian"
    patience = max(30, min(120, int(preferences["patience_s"])))

    def choose(action: str, summary: str, **kwargs) -> ResidentDecision:
        return ResidentDecision(proposal=ActionProposal.model_validate({
            "action": action, "idempotency_key": key, **kwargs,
        }), summary=f"Deterministic baseline: {summary}", plan=[summary])

    def trip(target: str, summary: str) -> ResidentDecision:
        options = [option for option in observation["trip_options"]
                   if option["target_id"] == target and option.get("reachable")]
        option = next((item for item in options if item["travel_class"] == travel_class), None)
        option = option or next(iter(options), None)
        if option is None:
            return choose("wait", "The intended destination is not currently reachable.", duration_s=patience)
        return choose("travel", summary, target_id=target, travel_class=option["travel_class"])

    current = next((task for task in active if task["task_id"] == state["current_task_id"]), None)
    if current is not None:
        activity = next((option for option in observation.get("activity_options", [])
                         if option["task_id"] == current["task_id"] and option["eligible"]), None)
        if activity is not None:
            return choose(activity["action"], "Continue my accepted activity only when its participants and resources are available.",
                          target_id=current["task_id"])
        if (current["kind"] == "visit" and current["requester_id"] == rid and current["status"] == "accepted"
                and state["anchor_id"] != current["service_anchor_id"]):
            return choose("visit", "Attend my accepted service visit.", target_id=current["task_id"], travel_class=travel_class)
        return choose("wait", "Keep my current commitment while its counterpart or resources are unavailable.", duration_s=patience)

    home_due = any(step["activity"] == "home" and step["earliest_s"] <= t for step in profile["routine"])
    if home_due and not own and state["anchor_id"] != profile["home_anchor_id"]:
        return trip(profile["home_anchor_id"], "Return home after the declared work period.")
    if state["role"] in {"shop_worker", "service_worker"} and not home_due:
        work = profile["work_anchor_id"]
        if state["anchor_id"] != work:
            return trip(work, "Travel to my declared work anchor before providing service.")
        requests = [task for task in active if task["status"] == "requested" and task["requester_id"] != rid
                    and task["service_anchor_id"] == work and rid not in task["declined_by"]
                    and task["kind"] == ("delivery" if state["role"] == "shop_worker" else "visit")]
        requests.sort(key=lambda task: (
            -float(preferences["helpfulness"]) * int(task["requester_id"] in contacts),
            task["deadline_s"], task["task_id"],
        ))
        if requests:
            return choose("accept", "Use my work capacity to fulfill an eligible request.", target_id=requests[0]["task_id"])

    deliveries = [task for task in own if task["kind"] == "delivery"]
    if deliveries and state["role"] == "customer":
        delivery = deliveries[0]
        if state["anchor_id"] != delivery["destination_anchor_id"]:
            return trip(delivery["destination_anchor_id"], "Be present at the agreed delivery anchor.")
        if delivery["deadline_s"] - t < patience and delivery["assignee_id"] is not None:
            return choose("revise_commitment", "Allow a bounded extension for an already accepted delivery.",
                          target_id=delivery["task_id"], duration_s=patience)
        return choose("wait", "Wait at the agreed delivery anchor without inventing a completed delivery.", duration_s=patience)
    visits = [task for task in own if task["kind"] == "visit" and task["status"] == "accepted"]
    if visits:
        return choose("visit", "Travel to an accepted in-person service.", target_id=visits[0]["task_id"], travel_class=travel_class)

    if state["role"] in {"courier", "driver"}:
        jobs = [task for task in active if task["kind"] == "delivery" and task["status"] == "ready"
                and task["requester_id"] != rid
                and task["required_capacity"] <= profile["carrying_capacity"] and rid not in task["declined_by"]]
        jobs.sort(key=lambda task: (
            -float(preferences["helpfulness"]) * int(task["requester_id"] in contacts),
            task["deadline_s"], task["task_id"],
        ))
        if jobs and (float(preferences["work_priority"]) >= 0.5 or state["needs"].get("rest", 0) < 0.25):
            return choose("accept", "Choose an eligible transport job within my carrying capacity.",
                          target_id=jobs[0]["task_id"], travel_class=travel_class)
        if jobs:
            return choose("rest", "Prefer a short rest before accepting another obligation.", duration_s=patience)

    for request_kind, purpose in (("delivery", "shop"), ("visit", "service")):
        if state["needs"].get(request_kind, 0) >= 0.75 and not any(task["kind"] == request_kind for task in own):
            anchor = next((a for a in observation["anchors"] if a["purpose"] == purpose), None)
            if anchor:
                return choose("request_service", "Ask another role to help with a recurring everyday need.",
                              target_id=anchor["anchor_id"], request_kind=request_kind)
    return choose("wait", "Retain the current routine until a relevant task or observation changes.", duration_s=patience)
