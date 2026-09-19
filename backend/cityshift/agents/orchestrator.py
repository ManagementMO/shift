"""Investigation orchestrator.

Roles (each recorded as an AgentDecision with its tool calls):
  evidence_analyst  – freezes an EvidenceBundle (deterministic retrieval), then reads it through tools and
                      summarises which claims constrain bus routing.  It cannot add or edit claims.
  demand_analyst    – ranks destination zones from declared counts and picks candidate stops via tools.
  planner           – sketches a vehicle→stop assignment with read-only tools, then a tool-free call formats
                      it as JSON.  The deterministic compiler turns that
                      into repeated duties across the service window; the deterministic validator decides.
                      One repair round is allowed when validation fails.
Nothing here writes measured outcomes: plans are registered as candidates; SUMO runs measure them.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from datetime import UTC, datetime

from cityshift.agents.tools import ToolContext, constraints_text, demand_summary_text, make_tools
from cityshift.contracts import (
    AgentDecision,
    CityPack,
    DemandSet,
    Investigation,
    ScenarioSpec,
    ServicePlan,
    ValidationReport,
)
from cityshift.domain.compiler import make_cycles, venue_stop_candidates
from cityshift.domain.network import load_corridors
from cityshift.domain.validators import validate_plan
from cityshift.evidence import build_bundle
from cityshift.providers import LLM_API_BASE, LLM_API_KEY, LLM_MODEL, LLMClient
from cityshift.store import Store

log = logging.getLogger(__name__)

PLAN_SHAPE = (
    '{"name": "short plan name", "family": "direct|split|custom", '
    '"assignments": [{"vehicle_id": "bus_A", "drop_stop_ids": ["<stop_id>", "..."], "first_depart_s": 300}], '
    '"rationale": "why", "assumptions": ["..."]}'
)


def _react_agent(name: str, description: str, tools, max_iterations: int):
    from openjiuwen.core.single_agent.agents.react_agent import ReActAgent, ReActAgentConfig
    from openjiuwen.core.single_agent.schema.agent_card import AgentCard

    agent = ReActAgent(AgentCard(name=name, description=description, version="1.0"))
    cfg = ReActAgentConfig(max_iterations=max_iterations).configure_model_client(
        provider="OpenAI", model_name=LLM_MODEL, api_key=LLM_API_KEY or "none", api_base=LLM_API_BASE,
    )
    agent.configure(cfg)
    for t in tools:
        agent.ability_manager.add_ability(t.card, t)
    return agent


async def _ask(name: str, description: str, tools, query: str, max_iterations: int = 6) -> str:
    agent = _react_agent(name, description, tools, max_iterations)
    out = await agent.invoke({"query": query})
    if isinstance(out, dict):
        return str(out.get("output", out))
    return str(out)


def assignments_to_plan(pack: CityPack, scenario: ScenarioSpec, obj: dict, plan_id: str) -> ServicePlan:
    pickup = venue_stop_candidates(pack)[0].stop_id
    duties = []
    win_start = scenario.constraints.service_window_s[0]
    for i, a in enumerate(obj.get("assignments", [])):
        vid = str(a["vehicle_id"])
        drops = [str(s) for s in a.get("drop_stop_ids", [])][:3]
        first = int(a.get("first_depart_s", win_start + 300))
        duties += make_cycles(pack, scenario, vid, pickup, drops, max(first, win_start), chr(65 + i))
    fam = obj.get("family", "custom")
    if fam not in ("direct", "split", "heuristic", "custom"):
        fam = "custom"
    return ServicePlan(
        plan_id=plan_id, name=str(obj.get("name") or plan_id)[:80], family=fam, duties=duties, authored_by="agent",
        rationale=str(obj.get("rationale", ""))[:600], assumptions=[str(x)[:200] for x in obj.get("assumptions", [])][:6],
    )


class InvestigationRunner:
    def __init__(self, store: Store):
        self.store = store
        self.llm = LLMClient()

    def _decision(self, inv: Investigation, role: str, action: str, inputs: str, output: str, ctx: ToolContext, validation: str | None = None) -> None:
        inv.decisions.append(AgentDecision(
            decision_id=f"{inv.investigation_id}-{len(inv.decisions) + 1:02d}", role=role, action=action,
            inputs_summary=inputs[:800], output_summary=output[:1200], validation=validation,
            model=self.llm.model, provider=self.llm.provider, tool_calls=list(ctx.calls),
        ))
        ctx.calls.clear()
        self.store.put_investigation(inv)

    def run(self, inv: Investigation, pack: CityPack, scenario: ScenarioSpec, demand: DemandSet) -> Investigation:
        inv.status = "running"
        self.store.put_investigation(inv)
        try:
            asyncio.run(self._run(inv, pack, scenario, demand))
            inv.status = "completed"
        except Exception as exc:
            log.exception("investigation failed")
            inv.status = "failed"
            inv.error = f"{type(exc).__name__}: {exc}"[:400]
        inv.finished_at = datetime.now(UTC)
        self.store.put_investigation(inv)
        return inv

    async def _run(self, inv: Investigation, pack: CityPack, scenario: ScenarioSpec, demand: DemandSet) -> None:
        corridors = load_corridors(pack.pack_id)
        queries = [inv.problem_text, *(c["label"] for c in corridors.values()), "closure detour bus", "event end time"]
        bundle = build_bundle(pack.pack_id, queries)
        self.store.put_bundle(bundle)
        inv.evidence_bundle_id = bundle.bundle_id
        ctx = ToolContext(pack=pack, scenario=scenario, demand=demand, bundle=bundle)
        tools = {t.card.name: t for t in make_tools(ctx)}
        providers = sorted({str(r.get("provider")) for r in bundle.query_records})
        self._decision(inv, "evidence_analyst", "freeze_bundle",
                       f"{len(queries)} scoped queries against corpus {bundle.corpus_snapshot}",
                       f"bundle {bundle.bundle_id} hash {bundle.content_hash[:12]}: {len(bundle.claims)} claims from {len(bundle.source_ids)} sources via {providers}; unresolved={len(bundle.unresolved)}",
                       ctx, validation="deterministic retrieval; content hash frozen")

        ev_summary = await _ask(
            "evidence_analyst", "Reads frozen evidence claims and modeled restrictions for a transit egress scenario.",
            [tools["evidence_claims"], tools["active_restrictions"]],
            "Use evidence_claims and active_restrictions. In at most 5 bullet points, state which CONFIRMED claims constrain bus routing "
            "during the egress window, which are superseded or pending and must be ignored, and anything unresolved. Do not invent facts.",
            max_iterations=4,
        )
        self._decision(inv, "evidence_analyst", "summarise_claims", "frozen bundle via tools", ev_summary, ctx,
                       validation="advisory only; claims unchanged")

        dm_summary = await _ask(
            "demand_analyst", "Ranks destination zones for a synthetic egress cohort and picks candidate stops.",
            [tools["demand_summary"], tools["stop_options"], tools["venue_pickup_stop"]],
            "Call demand_summary (it takes NO arguments), then stop_options once per zone for the top 4 zones by travelers "
            f"without a car. Known zone ids: {', '.join(z.zone_id for z in pack.zones)}. Reply with a compact list: "
            "zone_id, no-car count, best stop_id and name. Note the cohort is synthetic.",
            max_iterations=6,
        )
        self._decision(inv, "demand_analyst", "rank_zones", demand_summary_text(ctx)[:300], dm_summary, ctx,
                       validation="declared counts only; no demographic inference")

        planner_tools = [tools[k] for k in ("demand_summary", "stop_options", "venue_pickup_stop", "active_restrictions", "zone_of_stop")]
        fleet_ids = [v.vehicle_id for v in scenario.constraints.fleet]
        context = (
            f"PROBLEM: {inv.problem_text}\nCONSTRAINT (operator): {inv.constraint_text}\n"
            f"HARD CONSTRAINTS: {constraints_text(ctx)}\nFleet vehicle ids: {', '.join(fleet_ids)}.\n"
            f"EVIDENCE SUMMARY:\n{ev_summary[:900]}\nDEMAND SUMMARY:\n{dm_summary[:900]}\n"
            "Every duty starts at the venue pickup stop (added automatically) and drops at 1-2 stop_ids taken from the DEMAND SUMMARY "
            "or from stop_options. Use only fleet vehicle ids. The compiler repeats each assignment as cycles until the window closes."
        )
        variants = [
            ("agent-direct", "Propose plan 1: each bus serves ONE zone (direct shuttle)."),
            ("agent-split", "Propose plan 2: each bus serves TWO zones in sequence (split route), different from a direct shuttle."),
        ]
        for tag, instruction in variants:
            plan_id = f"{tag}-{inv.investigation_id[-6:]}"
            # Step 1: bounded ReAct sketch with read-only tools (prose; tool-calling models drop content when asked for JSON here).
            sketch = await _ask(
                "planner", "Proposes bounded shuttle assignments for a finite fleet.", planner_tools,
                f"{instruction}\n{context}\nCheck active_restrictions and zone_of_stop for any stop you pick. "
                "Reply in prose bullets (NO JSON): for each bus, its drop stop_ids in order, first departure in seconds, and why.",
                max_iterations=6,
            )
            self._decision(inv, "planner", f"sketch:{tag}", instruction, sketch, ctx, validation="advisory; not yet a plan")
            # Step 2: tool-free formatting into the typed shape, then deterministic compile + validate (one repair round).
            feedback = ""
            report: ValidationReport | None = None
            plan: ServicePlan | None = None
            for _attempt in range(2):
                try:
                    obj, _ = self.llm.chat_json(
                        "You convert a transit planner's sketch into a strict JSON plan. Output ONLY the JSON object.",
                        f"{instruction}\n{context}\nSKETCH:\n{sketch[:1500]}\n{feedback}",
                        PLAN_SHAPE,
                    )
                    plan = assignments_to_plan(pack, scenario, obj, plan_id)
                except Exception as exc:  # noqa: BLE001
                    self._decision(inv, "planner", f"propose:{tag}", instruction, f"unusable output: {exc}", ctx,
                                   validation=f"rejected: unusable output ({exc})")
                    feedback = f"Your previous answer was not a usable JSON plan ({exc}). Fix it."
                    continue
                report = validate_plan(pack, scenario, plan, demand)
                hard = [i for i in report.issues if i.severity == "hard"]
                self._decision(inv, "planner", f"propose:{tag}", instruction,
                               f"{plan.name}: {len(plan.duties)} duties; " + "; ".join(f"{d.vehicle_id}->{d.stop_sequence[1:]}" for d in plan.duties[:2]) + f"\nrationale: {plan.rationale}",
                               ctx, validation=("VALID" if report.valid else "INVALID: " + "; ".join(i.message for i in hard)[:400]))
                if report.valid:
                    break
                feedback = "Your previous plan was rejected by the validator: " + "; ".join(i.message for i in hard) + "\nFix it."
            if plan is not None and report is not None:
                self.store.put_plan(scenario.scenario_id, plan, report)
                (inv.proposed_plan_ids if report.valid else inv.rejected_plan_ids).append(plan.plan_id)
                self.store.put_investigation(inv)


def new_investigation(scenario_id: str, problem: str, constraint: str) -> Investigation:
    iid = "inv-" + hashlib.sha1(f"{scenario_id}|{problem}|{constraint}|{datetime.now(UTC).isoformat()}".encode()).hexdigest()[:10]
    return Investigation(investigation_id=iid, scenario_id=scenario_id, problem_text=problem, constraint_text=constraint)
