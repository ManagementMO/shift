"""Narrow, read-only tools handed to the agents. Each tool is an openJiuwen LocalFunction bound to one
scenario context; none can write measured outcomes, mutate scenarios, or run code."""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from openjiuwen.core.foundation.tool import tool
from openjiuwen.core.foundation.tool.function.function import LocalFunction

from cityshift.contracts import CityPack, DemandSet, EvidenceBundle, ScenarioSpec, ServicePlan
from cityshift.domain.compiler import _dist_m, stops_by_id, venue_stop_candidates, zone_for_stop
from cityshift.domain.validators import validate_plan


@dataclass
class ToolContext:
    pack: CityPack
    scenario: ScenarioSpec
    demand: DemandSet
    bundle: EvidenceBundle | None
    calls: list[dict] = field(default_factory=list)

    def log(self, name: str, args: dict, result: str) -> None:
        self.calls.append({"tool": name, "args": args, "result_preview": result[:240]})


def demand_summary_text(ctx: ToolContext) -> str:
    counts: dict[str, dict[str, int]] = {}
    for t in ctx.demand.travelers:
        c = counts.setdefault(t.dest_zone, {"total": 0, "no_car": 0})
        c["total"] += 1
        c["no_car"] += 0 if t.has_car else 1
    zones = {z.zone_id: z.name for z in ctx.pack.zones}
    lines = [f"{len(ctx.demand.travelers)} travelers, synthetic={ctx.demand.synthetic} ({ctx.demand.generation_method})"]
    for zid, c in sorted(counts.items(), key=lambda kv: -kv[1]["no_car"]):
        lines.append(f"- {zid} ({zones.get(zid, '?')}): {c['total']} travelers, {c['no_car']} without a car")
    departs = sorted(t.depart_s for t in ctx.demand.travelers)
    if departs:
        lines.append(f"departures from venue between {departs[0]}s and {departs[-1]}s (median {departs[len(departs) // 2]}s)")
    return "\n".join(lines)


def constraints_text(ctx: ToolContext) -> str:
    c = ctx.scenario.constraints
    fleet = ", ".join(f"{f.vehicle_id} (cap {f.capacity})" for f in c.fleet)
    return (
        f"fleet: {fleet}; hard_max_fleet={c.hard_max_fleet}; horizon={c.horizon_s}s; "
        f"service window {c.service_window_s[0]}-{c.service_window_s[1]}s; objective={c.objective}; "
        f"allowed stops: {len(c.allowed_stop_ids) or 'all pack stops'}"
    )


def make_tools(ctx: ToolContext) -> list[LocalFunction]:
    stops = stops_by_id(ctx.pack)

    @tool(name="demand_summary", description="Declared traveler counts per destination zone and departure spread. Read-only.", stateless=False)
    def demand_summary() -> str:
        out = demand_summary_text(ctx)
        ctx.log("demand_summary", {}, out)
        return out

    @tool(name="stop_options", description="Up to 3 usable bus stops nearest a destination zone id (e.g. Z_UW), with stop_id and distance in metres.")
    def stop_options(zone_id: str) -> str:
        z = next((z for z in ctx.pack.zones if z.zone_id == zone_id), None)
        if z is None:
            out = f"unknown zone {zone_id!r}; known: {[z.zone_id for z in ctx.pack.zones]}"
        else:
            allowed = set(ctx.scenario.constraints.allowed_stop_ids) or set(stops)
            near = sorted((s for s in ctx.pack.stops if s.stop_id in allowed), key=lambda s: _dist_m((s.lon, s.lat), (z.lon, z.lat)))[:3]
            out = "\n".join(f"- stop_id={s.stop_id} name={s.name!r} {int(_dist_m((s.lon, s.lat), (z.lon, z.lat)))} m from zone" for s in near)
        ctx.log("stop_options", {"zone_id": zone_id}, out)
        return out

    @tool(name="venue_pickup_stop", description="The venue pickup stop id every duty must start from.")
    def venue_pickup_stop() -> str:
        s = venue_stop_candidates(ctx.pack)[0]
        out = f"stop_id={s.stop_id} name={s.name!r}"
        ctx.log("venue_pickup_stop", {}, out)
        return out

    @tool(name="active_restrictions", description="Modeled closures/restrictions in this scenario with their windows. These are scenario fixtures, not live advisories.")
    def active_restrictions() -> str:
        if not ctx.scenario.restrictions:
            out = "none"
        else:
            out = "\n".join(f"- {r.restriction_id}: {len(r.edge_ids)} edges, {r.start_s}-{r.end_s}s, modes={r.modes}, label={r.label!r}" for r in ctx.scenario.restrictions)
        ctx.log("active_restrictions", {}, out)
        return out

    @tool(name="evidence_claims", description="Claims from the frozen evidence bundle (status confirmed/pending/superseded) with source ids.")
    def evidence_claims() -> str:
        if ctx.bundle is None:
            out = "no evidence bundle frozen for this investigation"
        else:
            out = "\n".join(f"- [{c.status}] {c.claim_type} {c.claim_id}: {c.text_span[:160]} (edges={len(c.edge_ids)}, window={c.effective_start_s}-{c.effective_end_s})" for c in ctx.bundle.claims)
            if ctx.bundle.unresolved:
                out += "\nunresolved: " + "; ".join(ctx.bundle.unresolved)
        ctx.log("evidence_claims", {}, out)
        return out

    @tool(name="check_plan", description="Deterministically validate a candidate plan JSON {duties:[{vehicle_id, stop_sequence:[stop_id,...], depart_s}]}. Returns hard/soft issues.")
    def check_plan(plan_json: str) -> str:
        try:
            plan = coerce_plan(json.loads(plan_json), "probe")
            rep = validate_plan(ctx.pack, ctx.scenario, plan, ctx.demand)
            out = ("VALID" if rep.valid else "INVALID") + "\n" + "\n".join(f"- [{i.severity}] {i.code}: {i.message}" for i in rep.issues)
        except Exception as exc:  # noqa: BLE001
            out = f"could not parse plan: {exc}"
        ctx.log("check_plan", {"plan_json": plan_json[:200]}, out)
        return out

    @tool(name="zone_of_stop", description="Which destination zone (if any) a stop id lies within 300 m of.")
    def zone_of_stop(stop_id: str) -> str:
        s = stops.get(stop_id)
        out = "unknown stop" if s is None else str(zone_for_stop(ctx.pack, s) or "no zone within 300 m")
        ctx.log("zone_of_stop", {"stop_id": stop_id}, out)
        return out

    return [demand_summary, stop_options, venue_pickup_stop, active_restrictions, evidence_claims, check_plan, zone_of_stop]


def coerce_plan(obj: dict, plan_id: str) -> ServicePlan:
    """Coerce loosely-shaped model output into a typed ServicePlan. Raises on anything unusable."""
    from cityshift.contracts import Duty

    duties = []
    for i, d in enumerate(obj.get("duties", [])):
        seq = [str(s) for s in d.get("stop_sequence", [])]
        duties.append(Duty(duty_id=str(d.get("duty_id") or f"{plan_id}-d{i + 1}"), vehicle_id=str(d["vehicle_id"]), stop_sequence=seq,
                           depart_s=int(d.get("depart_s", 0)), layover_s=int(d.get("layover_s", 60))))
    fam = obj.get("family", "custom")
    if fam not in ("direct", "split", "heuristic", "custom"):
        fam = "custom"
    return ServicePlan(plan_id=plan_id, name=str(obj.get("name") or plan_id)[:80], family=fam, duties=duties, authored_by="agent",
                       rationale=str(obj.get("rationale", ""))[:600], assumptions=[str(a)[:200] for a in obj.get("assumptions", [])][:6])
