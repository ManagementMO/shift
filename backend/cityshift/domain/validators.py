"""Deterministic plan validation.  Hard issues reject; soft issues stay visible; unknown is never success."""

from __future__ import annotations

from itertools import pairwise
from typing import Literal

from cityshift.contracts import (
    CityPack,
    DemandSet,
    ScenarioSpec,
    ServicePlan,
    ValidationIssue,
    ValidationReport,
)
from cityshift.domain.compiler import schedule_duties, stops_by_id, zone_for_stop


def validate_plan(pack: CityPack, scenario: ScenarioSpec, plan: ServicePlan, demand: DemandSet | None = None) -> ValidationReport:
    issues: list[ValidationIssue] = []
    stops = stops_by_id(pack)
    cons = scenario.constraints
    fleet_ids = {f.vehicle_id for f in cons.fleet}
    win_start, win_end = cons.service_window_s

    used_vehicles = {d.vehicle_id for d in plan.duties}
    for vid in sorted(used_vehicles - fleet_ids):
        issues.append(ValidationIssue(code="fleet.unknown_vehicle", severity="hard", message=f"duty uses vehicle {vid!r} that is not in the fleet ledger", refs=[vid]))
    if len(used_vehicles) > cons.hard_max_fleet:
        issues.append(ValidationIssue(code="fleet.exceeds_limit", severity="hard", message=f"{len(used_vehicles)} vehicles used, limit is {cons.hard_max_fleet}"))
    allowed = set(cons.allowed_stop_ids) if cons.allowed_stop_ids else set(stops)
    for d in plan.duties:
        if len(d.stop_sequence) < 2:
            issues.append(ValidationIssue(code="duty.too_short", severity="hard", message=f"{d.duty_id}: needs a pickup and at least one drop stop", refs=[d.duty_id]))
        for sid in d.stop_sequence:
            if sid not in stops:
                issues.append(ValidationIssue(code="pack.unknown_stop", severity="hard", message=f"{d.duty_id}: stop {sid!r} is not in city pack {pack.pack_id}", refs=[d.duty_id, sid]))
            elif sid not in allowed:
                issues.append(ValidationIssue(code="constraints.stop_not_allowed", severity="hard", message=f"{d.duty_id}: stop {stops[sid].name!r} is not an allowed stop", refs=[d.duty_id, sid]))
        if not (win_start <= d.depart_s <= win_end):
            issues.append(ValidationIssue(code="window.depart_outside", severity="hard", message=f"{d.duty_id}: departs at {d.depart_s}s, outside service window {win_start}-{win_end}s", refs=[d.duty_id]))
        if len(set(d.stop_sequence)) != len(d.stop_sequence):
            issues.append(ValidationIssue(code="duty.repeated_stop", severity="soft", message=f"{d.duty_id}: repeats a stop inside one duty", refs=[d.duty_id]))
        # every drop must belong to a destination zone or it is a wasted call
        for sid in d.stop_sequence[1:]:
            if sid in stops and zone_for_stop(pack, stops[sid], scenario) is None:
                issues.append(ValidationIssue(code="duty.drop_outside_zones", severity="soft", message=f"{d.duty_id}: drop stop {stops[sid].name!r} is not within 300 m of any destination zone", refs=[d.duty_id, sid]))
    pickups = {d.stop_sequence[0] for d in plan.duties if d.stop_sequence}
    if len(pickups) > 1:
        issues.append(ValidationIssue(code="plan.multiple_pickups", severity="soft", message="duties use multiple pickups; each trip is assigned only to a reachable pickup/alighting pair within its walking limit and departure window"))

    if not any(i.severity == "hard" for i in issues):
        schedules, errors = schedule_duties(pack, plan, scenario)
        for e in errors:
            issues.append(ValidationIssue(code="route.unreachable", severity="hard", message=e))
        by_vehicle: dict[str, list] = {}
        for s in schedules:
            by_vehicle.setdefault(s.duty.vehicle_id, []).append(s)
        for vid, scheds in by_vehicle.items():
            scheds.sort(key=lambda s: s.duty.depart_s)
            for a, b in pairwise(scheds):
                if b.duty.depart_s < a.est_return_s:
                    sev: Literal["hard", "soft"] = "hard" if b.duty.depart_s < a.est_end_s else "soft"
                    issues.append(ValidationIssue(
                        code="continuity.overlap", severity=sev,
                        message=f"{vid}: duty {b.duty.duty_id} departs at {b.duty.depart_s}s but {a.duty.duty_id} is estimated back at the venue at {a.est_return_s}s"
                                + (" (still dropping passengers)" if sev == "hard" else " (tight; bus may be late)"),
                        refs=[a.duty.duty_id, b.duty.duty_id]))
            last = scheds[-1]
            if last.est_end_s > cons.horizon_s:
                issues.append(ValidationIssue(code="window.ends_after_horizon", severity="soft", message=f"{vid}: last duty {last.duty.duty_id} is estimated to finish at {last.est_end_s}s, after the {cons.horizon_s}s horizon", refs=[last.duty.duty_id]))
        # capacity: declared no-car demand per zone vs seats offered
        multi_origin = demand is not None and any(t.origin_edge != pack.venue_edge_id or t.development_id for t in demand.travelers)
        if multi_origin and schedules:
            issues.append(ValidationIssue(
                code="capacity.multi_origin", severity="soft",
                message="Zone seat totals do not establish coverage for multi-origin demand; use compiled trip assignments and measured SUMO queues.",
            ))
        if demand is not None and schedules and not multi_origin:
            need: dict[str, int] = {}
            for t in demand.travelers:
                if not t.has_car:
                    need[t.dest_zone] = need.get(t.dest_zone, 0) + 1
            cap = {f.vehicle_id: f.capacity for f in cons.fleet}
            offered: dict[str, int] = {}
            for s in schedules:
                zs = {zone_for_stop(pack, stops[sid], scenario) for sid in s.duty.stop_sequence[1:]}
                for z in zs:
                    if z:
                        offered[z] = offered.get(z, 0) + cap.get(s.duty.vehicle_id, 60)
            for z, n in need.items():
                if z in offered and offered[z] < n:
                    issues.append(ValidationIssue(code="capacity.short", severity="soft", message=f"{z}: {n} no-car travelers declared, {offered[z]} seats offered across duties (shared with other zones on multi-stop duties)"))
        for r in scenario.restrictions:
            if r.start_s <= win_end and r.end_s >= win_start:
                issues.append(ValidationIssue(code="restriction.active", severity="soft", message=f"restriction {r.label or r.restriction_id} active {r.start_s}-{r.end_s}s on {len(r.edge_ids)} edges; routes were computed around it", refs=[r.restriction_id]))
    compiled = {}
    for d in plan.duties:
        for sid in d.stop_sequence:
            if sid in stops:
                compiled[sid] = (stops[sid].lon, stops[sid].lat)
    valid = not any(i.severity == "hard" for i in issues)
    return ValidationReport(plan_id=plan.plan_id, valid=valid, issues=issues, compiled_stop_positions=compiled)
