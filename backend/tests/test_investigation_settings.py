from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from pydantic import ValidationError

from cityshift import evidence
from cityshift.agents import orchestrator
from cityshift.api import service as service_module
from cityshift.api.agents_router import InvestigateRequest
from cityshift.contracts import (
    CityPack,
    ConstraintSet,
    DemandSet,
    InvestigationOptions,
    ScenarioSpec,
    ServicePlan,
    ValidationReport,
)
from cityshift.store import Store


@pytest.fixture
def context(monkeypatch):
    pack = CityPack(pack_id="toronto", name="fixture", version="1", net_file="", network_fingerprint="fixture",
                    bbox=(0, 0, 1, 1), center=(0, 0), venue_edge_id="e", venue_lonlat=(0, 0), stops=[], zones=[])
    scenario = ScenarioSpec(scenario_id="s", pack_id="toronto", demand_id="d",
                            constraints=ConstraintSet(fleet=[], horizon_s=600, service_window_s=(0, 600), allowed_stop_ids=[]))
    demand = DemandSet(demand_id="d", seed=1, travelers=[])
    monkeypatch.setattr(orchestrator, "load_corridors", lambda _: {})
    monkeypatch.setattr(evidence, "load_corridors", lambda _: {})
    monkeypatch.setattr(orchestrator, "validate_plan", lambda _p, _s, plan, _d: ValidationReport(plan_id=plan.plan_id, valid=True))
    return pack, scenario, demand


def plan(pid):
    return ServicePlan(plan_id=pid, name=pid, family="direct", duties=[], rationale="fixture plan")


def test_request_limits_and_snapshot():
    assert InvestigateRequest(problem="a problem").options == InvestigationOptions()
    for options in ({"plan_variants": 3}, {"plan_variants": 0}, {"max_iterations": 100}, {"max_iterations": 1}):
        with pytest.raises(ValidationError):
            InvestigateRequest(problem="a problem", options=options)
    options = InvestigationOptions(ai_enabled=False)
    inv = orchestrator.new_investigation("s", "problem", "constraint", options)
    options.ai_enabled = True
    assert not inv.options.ai_enabled
    assert inv.engine == "deterministic"


def test_ai_disabled_makes_no_model_or_elastic_calls(context, monkeypatch, tmp_path):
    pack, scenario, demand = context
    forbidden = Mock(side_effect=AssertionError("external provider must not be called"))
    monkeypatch.setattr(evidence, "elastic_client", forbidden)
    monkeypatch.setattr(orchestrator, "_ask", forbidden)
    monkeypatch.setattr(orchestrator, "make_tools", forbidden)
    monkeypatch.setattr(orchestrator, "heuristic_plans", lambda *_: [plan("a"), plan("b")])
    store = Store(tmp_path)
    runner = orchestrator.InvestigationRunner(store)
    monkeypatch.setattr(runner.llm, "chat_json", forbidden)
    inv = orchestrator.new_investigation("s", "event closure", "two buses", InvestigationOptions(ai_enabled=False, plan_variants=1, use_elasticsearch=False))
    runner.run(inv, pack, scenario, demand)
    assert inv.status == "completed"
    assert len(inv.proposed_plan_ids) == 1
    assert len(store.list_plans("s")) == 1
    assert all(d.provider == "deterministic" for d in inv.decisions)
    assert not forbidden.called
    assert all("disabled" in r["provider"] for r in store.get_bundle(inv.evidence_bundle_id).query_records)


def test_ai_steps_and_candidate_limit_are_forwarded(context, monkeypatch, tmp_path):
    pack, scenario, demand = context
    ask = AsyncMock(return_value="bounded plan sketch")
    monkeypatch.setattr(orchestrator, "_ask", ask)
    names = ("evidence_claims", "active_restrictions", "demand_summary", "stop_options", "venue_pickup_stop", "zone_of_stop")
    monkeypatch.setattr(orchestrator, "make_tools", lambda _: [SimpleNamespace(card=SimpleNamespace(name=name)) for name in names])
    monkeypatch.setattr(orchestrator, "assignments_to_plan", lambda _p, _s, _o, pid: plan(pid))
    runner = orchestrator.InvestigationRunner(Store(tmp_path))
    formatting = Mock(return_value=({}, None))
    monkeypatch.setattr(runner.llm, "chat_json", formatting)
    inv = orchestrator.new_investigation("s", "event closure", "two buses", InvestigationOptions(plan_variants=1, max_iterations=2, use_elasticsearch=False))
    runner.run(inv, pack, scenario, demand)
    assert inv.status == "completed"
    assert len(inv.proposed_plan_ids) == 1
    assert ask.await_count == 3
    assert all(call.kwargs["max_iterations"] == 2 for call in ask.await_args_list)
    assert formatting.call_count == 1


def test_disabled_elastic_is_labeled_and_does_not_reuse_other_retrieval_bundle(monkeypatch):
    monkeypatch.setattr(evidence, "elastic_client", lambda: None)
    monkeypatch.setattr(evidence, "load_corridors", lambda _: {})
    auto = evidence.build_bundle("toronto", ["Front Street closure"])
    local = evidence.build_bundle("toronto", ["Front Street closure"], use_elasticsearch=False)
    assert auto.source_ids == local.source_ids
    assert auto.bundle_id != local.bundle_id
    assert "disabled" in local.query_records[0]["provider"]
    assert evidence.build_bundle("toronto", ["Front Street closure"], use_elasticsearch=False).content_hash == local.content_hash


def test_edit_preview_respects_ai_off(context, monkeypatch, tmp_path):
    pack, scenario, _ = context
    svc = service_module.Service(Store(tmp_path))
    monkeypatch.setattr(svc, "scenario", lambda _: scenario)
    monkeypatch.setattr(svc, "pack", lambda _: pack)
    monkeypatch.setattr(service_module.edits, "load_corridors", lambda _: {})
    forbidden = Mock(side_effect=AssertionError("model must not be instantiated"))
    monkeypatch.setattr(service_module, "LLMClient", forbidden)
    try:
        proposal = svc.preview_edit("s", "make everything better", use_ai=False)
        assert proposal.kind == "unsupported"
        assert not forbidden.called
    finally:
        svc.pool.shutdown()
        svc.agent_pool.shutdown()
