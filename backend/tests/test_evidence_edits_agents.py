"""Phases E/F/G/H on the real Waterloo pack: evidence freezing, typed edits, hazard footprints, agent coercion.

No LLM is used here; these tests cover the deterministic parts that bound the agents.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from cityshift import evidence
from cityshift.agents.tools import ToolContext, coerce_plan, make_tools
from cityshift.contracts import HazardTrack, InterventionProposal
from cityshift.domain import edits
from cityshift.domain.hazards import hazard_footprint_edges, hazard_restriction
from cityshift.domain.network import load_pack
from cityshift.domain.scenarios import flagship_scenario
from cityshift.domain.validators import validate_plan

PACK_DIR = Path(__file__).resolve().parents[2] / "var" / "citypacks" / "waterloo"
pytestmark = pytest.mark.skipif(not (PACK_DIR / "pack.json").exists(), reason="waterloo city pack not built")


@pytest.fixture(scope="module")
def world():
    pack = load_pack("waterloo")
    scenario, demand = flagship_scenario(pack, seed=7, cohort_size=60, horizon_s=2700)
    return pack, scenario, demand


# ------------------------------------------------------------------ evidence


def test_local_corpus_search_is_scoped_and_labeled(monkeypatch):
    monkeypatch.setattr(evidence, "elastic_client", lambda: None)
    hits, record = evidence.search("waterloo", "King Street closure", 8)
    assert hits and {h["source_id"] for h in hits} <= {d["source_id"] for d in evidence.CORPORA["waterloo"]}
    assert all(h["label"] == "fixture" for h in hits)
    assert record["engine"] == "token-overlap"
    assert "Elasticsearch unavailable" in record["provider"]
    assert hits[0]["source_id"].startswith("notice-king")


def test_bundle_freeze_is_deterministic_and_records_queries():
    a = evidence.build_bundle("waterloo", ["King Street closure", "Erb Street"])
    b = evidence.build_bundle("waterloo", ["King Street closure", "Erb Street"])
    assert a.content_hash and a.content_hash == b.content_hash
    assert a.bundle_id == b.bundle_id
    assert len(a.query_records) == 2
    assert a.corpus_snapshot == evidence.CORPUS_SNAPSHOT
    statuses = {c.claim_id: c.status for c in a.claims}
    assert "superseded" in statuses.values(), "the superseded partial-closure notice must stay visible, not vanish"
    assert any("fixture" in s for s in a.assumptions)


# ------------------------------------------------------------------ hazards


def test_hazard_footprint_grows_with_radius_and_builds_restriction(world):
    pack, _, _ = world
    wp = [pack.venue_lonlat, pack.venue_lonlat]
    # the venue sits inside a park: no road edge lies within ~100 m, so use 200/400 m
    small = HazardTrack(track_id="h1", waypoints=wp, radius_m=200, start_s=300, end_s=1200)
    big = HazardTrack(track_id="h2", waypoints=wp, radius_m=400, start_s=300, end_s=1200)
    e_small, e_big = hazard_footprint_edges("waterloo", small), hazard_footprint_edges("waterloo", big)
    assert e_small and set(e_small) <= set(e_big) and len(e_big) > len(e_small)
    assert e_small == sorted(e_small)
    r = hazard_restriction("waterloo", small)
    assert r.edge_ids == e_small and (r.start_s, r.end_s) == (300, 1200)
    assert "not a forecast" in r.label and str(len(e_small)) in r.label


# ------------------------------------------------------------------ typed edits


def test_close_corridor_preview_and_immutable_apply(world):
    pack, scenario, _ = world
    p = edits.preview(pack, scenario, "Also close Erb St through Uptown from 10:00 to 30:00")
    assert p.kind == "close_edge" and not p.ambiguous
    assert p.edge_ids and (p.start_s, p.end_s) == (None, None), "street closures carry no time window"
    assert any("no time window" in w for w in p.warnings)
    before = scenario.model_dump()
    child = edits.apply(pack, scenario, p)
    assert scenario.model_dump() == before, "applying an edit must not mutate the base scenario"
    assert child.scenario_id != scenario.scenario_id and child.parent_scenario_id == scenario.scenario_id
    assert len(child.restrictions) == len(scenario.restrictions) + 1
    assert set(child.restrictions[-1].edge_ids) == set(p.edge_ids)
    assert (child.restrictions[-1].start_s, child.restrictions[-1].end_s) == (0, scenario.constraints.horizon_s)
    assert "close" in child.change_set[-1].lower()


def test_reopen_and_fleet_edits(world):
    pack, scenario, _ = world
    reopen = edits.preview(pack, scenario, "reopen King St")
    assert reopen.kind == "reopen_edge" and reopen.edge_ids
    child = edits.apply(pack, scenario, reopen)
    assert len(child.restrictions) < len(scenario.restrictions)

    fleet = edits.preview(pack, scenario, "set fleet to 3 buses")
    assert fleet.kind == "set_fleet" and fleet.fleet_count == 3
    assert any("hard" in w.lower() for w in fleet.warnings)
    child = edits.apply(pack, scenario, fleet)
    assert len(child.constraints.fleet) == 3 and child.constraints.hard_max_fleet == 3
    assert len(scenario.constraints.fleet) == 2


def test_storm_edit_creates_restriction_with_hazard_track(world):
    pack, scenario, _ = world
    p = edits.preview(pack, scenario, "storm corridor via venue and Grand River Hospital 300m from 05:00 to 20:00")
    assert p.kind == "storm" and p.hazard is not None and p.hazard.radius_m == 300
    assert (p.start_s, p.end_s) == (300, 1200) and len(p.edge_ids) > 50
    child = edits.apply(pack, scenario, p)
    assert child.hazards and child.hazards[-1].track_id == p.hazard.track_id
    assert child.restrictions[-1].source_claim_id == f"hazard:{p.hazard.track_id}"


def test_unsupported_prompt_is_flagged_not_guessed(world):
    pack, scenario, _ = world
    p = edits.preview(pack, scenario, "make it rain", llm=None)
    assert p.kind == "unsupported" and p.ambiguous
    with pytest.raises(ValueError):
        edits.apply(pack, scenario, p)


def test_apply_rejects_proposal_for_other_scenario(world):
    pack, scenario, _ = world
    p = InterventionProposal(proposal_id="x", kind="set_fleet", text="t", base_scenario_id="someone-else", fleet_count=1)
    with pytest.raises(ValueError):
        edits.apply(pack, scenario, p)


# ------------------------------------------------------------------ agents (deterministic parts)


def test_tools_are_read_only_and_logged(world):
    pack, scenario, demand = world
    ctx = ToolContext(pack=pack, scenario=scenario, demand=demand, bundle=None)
    tools = {t.card.name: t for t in make_tools(ctx)}
    assert {"demand_summary", "stop_options", "check_plan", "active_restrictions"} <= set(tools)
    before = (scenario.model_dump(), demand.model_dump())
    out = asyncio.run(tools["stop_options"].invoke({"zone_id": "Z_UW"}))
    assert "Z_UW" in str(out) or "stop" in str(out).lower()
    assert ctx.calls and ctx.calls[-1]["tool"] == "stop_options"
    assert (scenario.model_dump(), demand.model_dump()) == before


def test_coerce_plan_then_validator_rejects_bad_agent_output(world):
    pack, scenario, demand = world
    bogus = {
        "name": "x" * 200,
        "family": "teleport",
        "duties": [{"vehicle_id": "bus_Z", "stop_sequence": ["nope", "nope"], "depart_s": 0}],
        "rationale": "made up",
    }
    plan = coerce_plan(bogus, "agent-bad")
    assert plan.family == "custom" and plan.authored_by == "agent" and len(plan.name) == 80
    report = validate_plan(pack, scenario, plan, demand)
    assert not report.valid
    codes = {i.code for i in report.issues}
    assert any(c.startswith("fleet") for c in codes), codes


def test_coerce_plan_requires_vehicle_id():
    with pytest.raises(KeyError):
        coerce_plan({"duties": [{"stop_sequence": ["a", "b"]}]}, "p")


def test_match_corridor_full_label_wins_over_substring():
    corridors = {
        "king_west": {"label": "King St W, Spadina → University", "edge_ids": ["k1"]},
        "spadina": {"label": "Spadina Ave, Lake Shore → King", "edge_ids": ["s1"]},
        "front_west": {"label": "Front St W, Blue Jays Way → York", "edge_ids": ["f1"]},
    }
    # The full label of one corridor mentions another street: only the labelled corridor is meant.
    assert edits._match_corridor("close King St W, Spadina → University from 22:40 to 23:05", corridors) == ["king_west"]
    # Plain street mentions still match, including several at once.
    assert edits._match_corridor("close king and spadina", corridors) == ["king_west", "spadina"]
    assert edits._match_corridor("shut front st w", corridors) == ["front_west"]
