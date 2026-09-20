"""Street closures are untimed and removable by clicking them: preview/apply on a synthetic pack, no network needed."""

from __future__ import annotations

import pytest

from cityshift.contracts import CityPack, ConstraintSet, Restriction, ScenarioSpec
from cityshift.domain import edits

CORRIDORS = {
    "king_west": {"label": "King St W, Spadina → University", "edge_ids": ["k1", "k2", "k3"], "flagship_closure": True},
    "front_west": {"label": "Front St W, Blue Jays Way → York", "edge_ids": ["f1", "f2"]},
}
HORIZON = 2700


@pytest.fixture
def world(monkeypatch):
    monkeypatch.setattr(edits, "load_corridors", lambda _pack_id: CORRIDORS)
    pack = CityPack(pack_id="toronto", name="fixture", version="1", net_file="", network_fingerprint="fixture",
                    bbox=(0, 0, 1, 1), center=(0, 0), venue_edge_id="e", venue_lonlat=(0, 0), stops=[], zones=[])
    fixture = Restriction(restriction_id="closure-king-west", edge_ids=["k1", "k2", "k3"], start_s=0, end_s=HORIZON,
                          label="King St W, Spadina → University — closed both directions (fixture notice, not a live advisory)")
    hazard = Restriction(restriction_id="hazard-storm-1", edge_ids=["f2", "z9"], start_s=600, end_s=1200,
                         source_claim_id="hazard:storm-1", label="assumed storm corridor — footprint 2 edges within 250 m")
    scenario = ScenarioSpec(scenario_id="s", pack_id="toronto", demand_id="d", restrictions=[fixture, hazard],
                            constraints=ConstraintSet(fleet=[], horizon_s=HORIZON, service_window_s=(0, HORIZON), allowed_stop_ids=[]),
                            label="Event egress during the King St W closure")
    return pack, scenario


def test_closing_a_street_has_no_time_window(world):
    pack, scenario = world
    p = edits.preview(pack, scenario, "close Front St W, Blue Jays Way → York")
    assert p.kind == "close_edge" and not p.ambiguous
    assert p.edge_ids == ["f1", "f2"] and p.start_s is None and p.end_s is None
    assert not any("window" in w for w in p.warnings), "an untimed closure is the normal case, not a warning"
    child = edits.apply(pack, scenario, p)
    added = child.restrictions[-1]
    assert (added.start_s, added.end_s) == (0, HORIZON)
    assert added.edge_ids == ["f1", "f2"] and "operator edit" in added.label
    assert child.change_set[-1] == f"close 2 edges: {p.reason}"
    assert scenario.restrictions[-1].restriction_id == "hazard-storm-1", "the parent scenario is untouched"


def test_typed_time_window_is_ignored_for_closures_with_a_warning(world):
    pack, scenario = world
    p = edits.preview(pack, scenario, "close Front St W from 10:00 to 30:00")
    assert p.kind == "close_edge" and (p.start_s, p.end_s) == (None, None)
    assert any("no time window" in w for w in p.warnings)
    child = edits.apply(pack, scenario, p)
    assert (child.restrictions[-1].start_s, child.restrictions[-1].end_s) == (0, HORIZON)


def test_clicked_closure_is_removed_by_restriction_id(world):
    pack, scenario = world
    p = edits.preview(pack, scenario, "remove closure closure-king-west")
    assert p.kind == "reopen_edge" and not p.ambiguous
    assert p.edge_ids == ["k1", "k2", "k3"]
    assert p.reason == "remove closure King St W, Spadina → University"
    assert p.warnings == []
    child = edits.apply(pack, scenario, p)
    assert [r.restriction_id for r in child.restrictions] == ["hazard-storm-1"], "only the clicked closure goes; the hazard footprint stays"
    assert "removed restriction closure-king-west" in child.change_set
    assert child.parent_scenario_id == scenario.scenario_id
    assert [r.restriction_id for r in scenario.restrictions] == ["closure-king-west", "hazard-storm-1"]


def test_restriction_id_wins_over_street_names_inside_it(world):
    pack, scenario = world
    p = edits.preview(pack, scenario, "remove closure closure-king-west")
    assert "f1" not in p.edge_ids, "the id mentions 'king' only; no corridor matching by substring"


def test_reopening_by_corridor_name_still_works_without_a_window(world):
    pack, scenario = world
    p = edits.preview(pack, scenario, "reopen King St W")
    assert p.kind == "reopen_edge" and p.edge_ids == ["k1", "k2", "k3"]
    assert (p.start_s, p.end_s) == (None, None)
    child = edits.apply(pack, scenario, p)
    assert all(r.restriction_id != "closure-king-west" for r in child.restrictions)


def test_restriction_name_strips_fixture_and_edit_suffixes():
    fixture = Restriction(restriction_id="a", edge_ids=[], start_s=0, end_s=1, label="King St W, Spadina → University — closed both directions (fixture notice)")
    edit = Restriction(restriction_id="b", edge_ids=[], start_s=0, end_s=1, label="close Front St W, Blue Jays Way → York (2 edges) (operator edit, not a live advisory)")
    blank = Restriction(restriction_id="closure-x", edge_ids=[], start_s=0, end_s=1, label="")
    assert edits.restriction_name(fixture) == "King St W, Spadina → University"
    assert edits.restriction_name(edit) == "Front St W, Blue Jays Way → York"
    assert edits.restriction_name(blank) == "closure-x"
