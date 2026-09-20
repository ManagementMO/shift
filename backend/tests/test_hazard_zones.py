from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

import mongomock
import pytest
import sumolib
import traci
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from cityshift.contracts import (
    CityPack,
    ConstraintSet,
    DemandSet,
    HazardDraft,
    HazardTrack,
    InterventionProposal,
    Restriction,
    ScenarioSpec,
    ServicePlan,
    Traveler,
)
from cityshift.domain import edits, network
from cityshift.domain.compiler import baseline_plan, compile_scenario
from cityshift.domain.hazards import (
    hazard_footprint_edges,
    hazard_restriction,
    validate_scenario_restrictions,
)
from cityshift.domain.runs import closure_violations, run_id_for
from cityshift.domain.validators import validate_plan
from cityshift.store import MongoStore, Store
from cityshift.transport.runner import SumoRunner, compute_metrics
from cityshift.transport.sumo_env import binary
from cityshift.transport.sumo_xml import EdgeClosure, write_additional
from cityshift.transport.tiny_fixture import build_tiny_network


@pytest.fixture(scope="module")
def geo_net(tmp_path_factory):
    path = build_tiny_network(tmp_path_factory.mktemp("hazard-net"), geo=True)
    return sumolib.net.readNet(str(path)), path


def midpoint(net, edge_id):
    shape = net.getEdge(edge_id).getShape()
    return net.convertXY2LonLat(*[(shape[0][i] + shape[-1][i]) / 2 for i in (0, 1)])


@pytest.fixture
def world(geo_net, monkeypatch):
    net, path = geo_net
    venue = midpoint(net, "e_AB")
    pack = CityPack(
        pack_id="hazard-tiny", name="Synthetic hazard test network", version="1", net_file=str(path),
        network_fingerprint="hazard-tiny-1", bbox=(-79.392, 43.638, -79.376, 43.645),
        center=venue, venue_edge_id="e_AB", venue_lonlat=venue, stops=[], zones=[], real_data=False,
    )
    scenario = ScenarioSpec(
        scenario_id="parent", pack_id=pack.pack_id, demand_id="cohort",
        constraints=ConstraintSet(fleet=[], horizon_s=1000, service_window_s=(0, 1000), allowed_stop_ids=[]),
    )
    monkeypatch.setattr(network, "load_pack", lambda _: pack)
    monkeypatch.setattr(edits, "load_corridors", lambda _: {"venue": {"label": "Venue Road", "edge_ids": ["e_AB", "e_BA"]}})
    network.load_net.cache_clear()
    yield pack, scenario, net
    network.load_net.cache_clear()


def hazard(net, **changes):
    return HazardTrack.model_validate({
        "track_id": "h1", "waypoints": [midpoint(net, "e_BC")], "radius_m": 30,
        "start_s": 100, "end_s": 300, **changes,
    })


@pytest.mark.parametrize("changes", [
    {"waypoints": []}, {"waypoints": [[-79.38]]}, {"waypoints": [[181, 43.64]]},
    {"waypoints": [[-79.38, 91]]}, {"waypoints": [[float("nan"), 43.64]]},
    {"waypoints": [[-79.38, float("inf")]]}, {"radius_m": 0}, {"radius_m": -1},
    {"radius_m": float("nan")}, {"radius_m": float("inf")}, {"radius_m": 10001},
    {"start_s": -1}, {"start_s": 300}, {"end_s": 99}, {"end_s": 100.5},
    {"modes": []}, {"modes": ["pedestrian"]}, {"modes": ["aircraft"]},
])
def test_hazard_rejects_invalid_geometry_windows_and_modes(geo_net, changes):
    with pytest.raises(ValidationError):
        hazard(geo_net[0], **changes)


def test_projected_point_and_corridor_footprints_are_sorted_and_monotone(world):
    pack, _, net = world
    small = hazard(net)
    assert hazard_footprint_edges(pack.pack_id, small) == ["e_BC", "e_CB"]
    bigger = hazard(net, radius_m=400)
    assert set(hazard_footprint_edges(pack.pack_id, small)) < set(hazard_footprint_edges(pack.pack_id, bigger))
    duplicate = hazard(net, waypoints=small.waypoints * 2)
    assert hazard_footprint_edges(pack.pack_id, duplicate) == hazard_footprint_edges(pack.pack_id, small)
    corridor = hazard(net, waypoints=[midpoint(net, "e_AB"), midpoint(net, "e_CD")])
    edges = hazard_footprint_edges(pack.pack_id, corridor)
    assert edges == sorted(set(edges))
    assert {"e_AB", "e_BC", "e_CD"} <= set(edges)
    restriction = hazard_restriction(pack.pack_id, small)
    assert restriction.edge_ids == ["e_BC", "e_CB"]
    assert (restriction.start_s, restriction.end_s) == (100, 300)
    assert set(small.modes) == set(restriction.modes) == {"passenger", "bus"}


def polygon_around(net, edge_id, half_m=40.0):
    """Axis-aligned square (lon/lat corners) around an edge midpoint, `half_m` metres to each side."""
    cx, cy = [(a + b) / 2 for a, b in zip(net.getEdge(edge_id).getShape()[0], net.getEdge(edge_id).getShape()[-1])]
    return [net.convertXY2LonLat(cx + dx, cy + dy) for dx, dy in ((-half_m, -half_m), (half_m, -half_m), (half_m, half_m), (-half_m, half_m))]


def test_polygon_area_uses_the_drawn_corners_exactly(world):
    pack, parent, net = world
    corners = polygon_around(net, "e_BC")
    area = hazard(net, kind="fire", shape="polygon", radius_m=0, waypoints=corners)
    assert hazard_footprint_edges(pack.pack_id, area) == ["e_BC", "e_CB"]
    resolved, restriction = resolve_hazard_for(pack, area)
    assert restriction.edge_ids == ["e_BC", "e_CB"]
    # The footprint is the polygon itself (closed exterior ring, no buffer): every corner lies on the ring.
    ring = resolved.footprint[0]
    assert ring[0] == ring[-1] and len(resolved.footprint) == 1
    for lon, lat in corners:
        assert any(abs(lon - rl) < 1e-9 and abs(lat - rt) < 1e-9 for rl, rt in ring)
    # Corner order does not change the area; a margin widens it monotonically.
    reversed_area = hazard(net, kind="fire", shape="polygon", radius_m=0, waypoints=list(reversed(corners)))
    assert hazard_footprint_edges(pack.pack_id, reversed_area) == ["e_BC", "e_CB"]
    wider = hazard(net, kind="fire", shape="polygon", radius_m=400, waypoints=corners)
    assert {"e_BC", "e_CB"} < set(hazard_footprint_edges(pack.pack_id, wider))
    p = edits.preview_hazard(pack, parent, area)
    child = edits.apply(pack, parent, p)
    assert child.hazards[0].shape == "polygon" and child.restrictions[0].edge_ids == ["e_BC", "e_CB"]
    assert "drawn area" in child.restrictions[0].label
    validate_scenario_restrictions(pack, child)


def resolve_hazard_for(pack, draft):
    from cityshift.domain.hazards import resolve_hazard

    return resolve_hazard(pack, draft, "poly", 1000)


@pytest.mark.parametrize("changes, message", [
    ({"shape": "polygon", "radius_m": 0, "waypoints": "two"}, "three corners"),
    ({"shape": "buffer", "radius_m": 0}, "radius greater than 0"),
    ({"shape": "polygon", "radius_m": 0, "waypoints": "bowtie"}, "cannot cross"),
    ({"shape": "polygon", "radius_m": 0, "waypoints": "line"}, "cannot cross or collapse"),
])
def test_polygon_areas_reject_bad_outlines(world, changes, message):
    pack, parent, net = world
    a, b, c, d = polygon_around(net, "e_BC")
    shapes = {"two": [a, b], "bowtie": [a, c, b, d], "line": [a, b, b, a]}
    if isinstance(changes.get("waypoints"), str):
        changes = {**changes, "waypoints": shapes[changes["waypoints"]]}
    with pytest.raises((ValidationError, ValueError), match=message):
        edits.preview_hazard(pack, parent, hazard(net, **changes))


def test_footprint_only_includes_edges_accessible_to_selected_modes(world, monkeypatch):
    pack, _, net = world
    loaded = network.load_net(pack.pack_id)
    monkeypatch.setattr(loaded.getEdge("e_BC"), "allows", lambda mode: mode == "bus")
    monkeypatch.setattr(loaded.getEdge("e_CB"), "allows", lambda mode: mode == "pedestrian")
    assert hazard_footprint_edges(pack.pack_id, hazard(net, modes=["passenger"])) == []
    assert hazard_footprint_edges(pack.pack_id, hazard(net, modes=["bus"])) == ["e_BC"]


def test_named_point_is_not_silently_extended_and_preview_is_non_mutating(world):
    pack, parent, _ = world
    before = parent.model_dump()
    p = edits.preview(pack, parent, "fire at venue 30 m from 01:00 to 05:00")
    assert p.hazard is not None and p.hazard.waypoints == [pack.venue_lonlat] and p.hazard.kind == "fire"
    assert p.edge_ids == ["e_AB", "e_BA"]
    assert parent.model_dump() == before
    child = edits.apply(pack, parent, p)
    assert parent.model_dump() == before
    assert child.parent_scenario_id == parent.scenario_id and child.scenario_id != parent.scenario_id
    assert child.demand_id == parent.demand_id and child.constraints == parent.constraints
    assert child.restrictions[-1].edge_ids == p.edge_ids
    assert child.restrictions[-1].source_claim_id == f"hazard:{child.hazards[-1].track_id}"


def test_apply_rejects_tampered_hazard_edges(world):
    pack, parent, _ = world
    p = edits.preview(pack, parent, "hazard venue 30 m from 01:00 to 05:00")
    p.edge_ids = ["foreign-edge"]
    with pytest.raises(ValueError, match="preview|footprint|edges"):
        edits.apply(pack, parent, p)


def test_reopening_manual_roads_preserves_hazard_ownership(world):
    pack, parent, _ = world
    parent.restrictions = [Restriction(restriction_id="manual", edge_ids=["e_AB"], start_s=0, end_s=900)]
    child = edits.apply(pack, parent, edits.preview(pack, parent, "hazard venue 30 m from 01:00 to 05:00"))
    snapshot = child.model_dump()
    reopen = edits.preview(pack, child, "reopen Venue Road")
    assert any("hazard" in w for w in reopen.warnings)
    reopened = edits.apply(pack, child, reopen)
    assert child.model_dump() == snapshot
    assert reopened.hazards == child.hazards
    assert reopened.restrictions == [child.restrictions[-1]]


def test_compiler_does_not_close_upstream_notification_edges(world, tmp_path):
    pack, parent, _ = world
    parent.restrictions = [Restriction(restriction_id="r", edge_ids=["e_BC"], start_s=100, end_s=300)]
    result = compile_scenario(pack, parent, DemandSet(demand_id="d", seed=1, travelers=[]), baseline_plan(), tmp_path, 1)
    assert result.ok, result.errors
    root = ET.parse(tmp_path / "scenario.add.xml").getroot()
    assert {e.get("id") for e in root.iter("closingReroute")} == {"e_BC"}
    notifications = {eid for e in root.iter("rerouter") for eid in e.get("edges").split()}
    assert "e_AB" in notifications


def test_overlapping_closures_compile_to_nonoverlapping_union_windows(tmp_path: Path):
    path = tmp_path / "closures.xml"
    write_additional(path, [], [
        EdgeClosure("manual", ["e_BC"], 100, 200, ["passenger"]),
        EdgeClosure("hazard", ["e_BC"], 150, 300, ["bus", "passenger"]),
    ])
    root = ET.parse(path).getroot()
    assert len(list(root.iter("rerouter"))) == 1
    windows = [(float(i.get("begin")), float(i.get("end")), set(i.find("closingReroute").get("disallow").split())) for i in root.iter("interval")]
    assert windows == [(100, 150, {"passenger"}), (150, 300, {"passenger", "bus"})]


def test_storm_without_geometry_is_not_an_appliable_noop(world):
    pack, parent, _ = world
    proposal = InterventionProposal(proposal_id="missing", kind="storm", text="hazard", base_scenario_id=parent.scenario_id)
    with pytest.raises(ValueError):
        edits.apply(pack, parent, proposal)


def test_empty_footprint_is_a_visual_only_event_with_no_restriction(world, tmp_path):
    pack, parent, net = world
    p = edits.preview_hazard(pack, parent, hazard(net, waypoints=[net.convertXY2LonLat(100, 150)], radius_m=1, kind="rain"))
    assert p.hazard.footprint and not p.edge_ids and not p.ambiguous
    assert "visual-only" in p.reason.lower()
    assert any("visual only" in w for w in p.warnings)
    child = edits.apply(pack, parent, p)
    assert [h.track_id for h in child.hazards] == [p.hazard.track_id]
    assert child.restrictions == []
    assert any("visual only" in c for c in child.change_set)
    validate_scenario_restrictions(pack, child)
    # A visual-only event must never invent a closure downstream: the compiled run has no rerouter.
    comp = compile_scenario(pack, child, DemandSet(demand_id="d", seed=1, travelers=[]), baseline_plan(), tmp_path, 1)
    assert comp.ok, comp.errors
    assert "rerouter" not in (tmp_path / "scenario.add.xml").read_text()
    # Removing it is a plain visual change, and tampering an empty restriction in is rejected.
    removal = edits.preview_hazard_removal(pack, child, p.hazard.track_id)
    assert removal.edge_ids == [] and any("visual" in w for w in removal.warnings)
    assert edits.apply(pack, child, removal).hazards == []
    tampered = child.model_copy(deep=True)
    tampered.restrictions = [Restriction(restriction_id="ghost", edge_ids=["e_AB"], start_s=100, end_s=300, source_claim_id=f"hazard:{p.hazard.track_id}")]
    with pytest.raises(ValueError, match="must match the preview"):
        validate_scenario_restrictions(pack, tampered)


@pytest.mark.parametrize("changes, message", [
    ({"waypoints": [(-80.0, 43.64)]}, "extent"),
    ({"end_s": 1001}, "horizon"),
])
def test_preview_rejects_unsupported_extent_or_horizon(world, changes, message):
    pack, parent, net = world
    with pytest.raises(ValueError, match=message):
        edits.preview_hazard(pack, parent, hazard(net, **changes))


@pytest.mark.parametrize("field, value", [
    ("start_s", 101), ("end_s", 301), ("network_fingerprint", "different-network"),
])
def test_confirm_rejects_changed_preview_metadata(world, field, value):
    pack, parent, net = world
    p = edits.preview_hazard(pack, parent, hazard(net))
    setattr(p, field, value)
    with pytest.raises(ValueError, match="preview"):
        edits.apply(pack, parent, p)


def test_confirm_rejects_tampered_buffer_or_geometry(world):
    pack, parent, net = world
    p = edits.preview_hazard(pack, parent, hazard(net))
    p.hazard.footprint[0][0] = pack.center
    with pytest.raises(ValueError, match="footprint"):
        edits.apply(pack, parent, p)
    p = edits.preview_hazard(pack, parent, hazard(net))
    p.hazard.radius_m = 31
    with pytest.raises(ValueError, match="footprint"):
        edits.apply(pack, parent, p)


def test_removal_is_owned_and_immutable_with_other_hazards_and_manual_closures(world):
    pack, parent, net = world
    parent.restrictions = [Restriction(restriction_id="manual", edge_ids=["e_BC"], start_s=0, end_s=900)]
    first = edits.apply(pack, parent, edits.preview_hazard(pack, parent, hazard(net)))
    second = edits.apply(pack, first, edits.preview_hazard(pack, first, hazard(net, start_s=200, end_s=400)))
    before = second.model_dump()
    removal = edits.preview_hazard_removal(pack, second, first.hazards[0].track_id)
    assert second.model_dump() == before
    assert "2 affected edges retain" in removal.warnings[-1]
    child = edits.apply(pack, second, removal)
    assert second.model_dump() == before
    assert child.parent_scenario_id == second.scenario_id
    assert child.hazards == [second.hazards[1]]
    assert child.restrictions == [second.restrictions[0], second.restrictions[2]]
    with pytest.raises(ValueError, match="does not exist"):
        edits.preview_hazard_removal(pack, child, first.hazards[0].track_id)


def test_move_is_one_atomic_edit_that_preserves_other_restrictions(world):
    pack, parent, net = world
    parent.restrictions = [Restriction(restriction_id="manual", edge_ids=["e_AB"], start_s=0, end_s=900)]
    first = edits.apply(pack, parent, edits.preview_hazard(pack, parent, hazard(net, kind="rain")))
    before = first.model_dump()
    old_id = first.hazards[0].track_id
    moved = edits.preview_hazard_replacement(pack, first, old_id, hazard(net, kind="rain", waypoints=[midpoint(net, "e_CD")]))
    assert first.model_dump() == before
    assert moved.kind == "replace_hazard" and moved.replaces_track_id == old_id and not moved.ambiguous
    assert moved.edge_ids == ["e_CD", "e_DC"] and moved.hazard.kind == "rain"
    assert not any("overlapping restrictions" in w for w in moved.warnings)
    child = edits.apply(pack, first, moved)
    assert first.model_dump() == before
    assert child.parent_scenario_id == first.scenario_id
    assert [h.track_id for h in child.hazards] == [moved.hazard.track_id]
    assert child.hazards[0].waypoints == moved.hazard.waypoints
    assert [r.restriction_id for r in child.restrictions] == ["manual", child.restrictions[1].restriction_id]
    assert child.restrictions[1].source_claim_id == f"hazard:{moved.hazard.track_id}"
    assert child.restrictions[1].edge_ids == ["e_CD", "e_DC"]
    assert any("moved weather event" in c for c in child.change_set)
    with pytest.raises(ValueError, match="does not exist"):
        edits.preview_hazard_replacement(pack, child, old_id, hazard(net))
    stale = edits.preview_hazard_replacement(pack, first, old_id, hazard(net, waypoints=[midpoint(net, "e_CD")]))
    stale.replaces_track_id = "someone-else"
    with pytest.raises(ValueError, match="no longer exists"):
        edits.apply(pack, first, stale)
    nowhere = edits.preview_hazard_replacement(pack, first, old_id, hazard(net, waypoints=[(-79.376, 43.645)], radius_m=1))
    assert not nowhere.ambiguous and nowhere.edge_ids == [] and "visual only" in nowhere.reason
    parked = edits.apply(pack, first, nowhere)
    assert [h.track_id for h in parked.hazards] == [nowhere.hazard.track_id]
    assert [r.restriction_id for r in parked.restrictions] == ["manual"]


def test_footprint_and_run_identity_are_content_based(world):
    pack, parent, net = world
    p = edits.preview_hazard(pack, parent, hazard(net))
    again = edits.preview_hazard(pack, parent, hazard(net))
    assert p == again
    first = edits.apply(pack, parent, p)
    second = edits.apply(pack, parent, again)
    assert first.scenario_id == second.scenario_id
    assert run_id_for(first, baseline_plan(), 1) == run_id_for(second, baseline_plan(), 1)
    different = edits.apply(pack, parent, edits.preview_hazard(pack, parent, hazard(net, radius_m=31)))
    assert first.restrictions[0].edge_ids == different.restrictions[0].edge_ids
    assert first.scenario_id != different.scenario_id
    assert run_id_for(first, baseline_plan(), 1) != run_id_for(different, baseline_plan(), 1)


@pytest.mark.parametrize("problem", ["foreign", "missing", "timing", "orphan"])
def test_compiler_and_validator_reject_inconsistent_hazard_restrictions(world, tmp_path, problem):
    pack, parent, net = world
    child = edits.apply(pack, parent, edits.preview_hazard(pack, parent, hazard(net)))
    if problem == "foreign":
        child.restrictions[0].edge_ids = ["foreign-edge"]
    elif problem == "missing":
        child.restrictions = []
    elif problem == "timing":
        child.restrictions[0].end_s += 1
    else:
        child.hazards = []
    comp = compile_scenario(pack, child, DemandSet(demand_id="d", seed=1, travelers=[]), baseline_plan(), tmp_path, 1)
    assert not comp.ok and comp.errors and comp.cfg is None
    report = validate_plan(pack, child, baseline_plan())
    assert not report.valid
    assert any(i.code == "restriction.invalid" for i in report.issues)


@pytest.fixture(params=["json", "mongo"])
def api_world(world, tmp_path, monkeypatch, request):
    from cityshift.api import edit_router
    from cityshift.api.service import Service

    pack, parent, net = world
    store = Store(tmp_path / "store") if request.param == "json" else MongoStore(mongomock.MongoClient().hazards_test)
    svc = Service(store, workers=1)
    monkeypatch.setattr(svc, "pack", lambda _: pack)
    monkeypatch.setattr(edit_router, "get_service", lambda: svc)
    svc.register_scenario(parent, DemandSet(demand_id=parent.demand_id, seed=1, travelers=[]))
    svc.register_plan(parent, ServicePlan(plan_id="response", name="User response", family="custom", duties=[], authored_by="user"))
    app = FastAPI()
    app.include_router(edit_router.router)
    with TestClient(app) as client:
        yield client, svc, pack, parent, net
    svc.close()


@pytest.mark.parametrize("kind", ["rain", "fire", "storm"])
def test_typed_api_preview_discard_confirm_remove_and_idempotency(api_world, kind):
    client, svc, pack, parent, net = api_world
    before = svc.scenario(parent.scenario_id).model_dump()
    draft = hazard(net, kind=kind).model_dump(mode="json", include=set(HazardDraft.model_fields))
    response = client.post(f"/api/scenarios/{parent.scenario_id}/hazards/preview", json=draft)
    assert response.status_code == 200, response.text
    p = response.json()
    assert p["edge_ids"] == ["e_BC", "e_CB"] and p["hazard"]["footprint"]
    assert p["network_fingerprint"] == pack.network_fingerprint
    assert len(svc.store.list_scenarios()) == 1
    assert svc.scenario(parent.scenario_id).model_dump() == before
    applied = client.post(f"/api/scenarios/{parent.scenario_id}/edit/apply", json=p)
    assert applied.status_code == 200, applied.text
    child = applied.json()
    assert child["parent_scenario_id"] == parent.scenario_id
    assert child["hazards"][0] == p["hazard"]
    assert child["restrictions"][0]["edge_ids"] == p["edge_ids"]
    assert svc.store.get_plan(child["scenario_id"], "response") == svc.store.get_plan(parent.scenario_id, "response")
    assert svc.demand(child["scenario_id"]) == svc.demand(parent.scenario_id)
    duplicate = client.post(f"/api/scenarios/{parent.scenario_id}/edit/apply", json=p)
    assert duplicate.status_code == 200 and duplicate.json() == child
    assert len(svc.store.list_scenarios()) == 2
    assert svc.scenario(parent.scenario_id).model_dump() == before
    removal = client.post(f"/api/scenarios/{child['scenario_id']}/hazards/{p['hazard']['track_id']}/remove/preview")
    assert removal.status_code == 200
    assert len(svc.store.list_scenarios()) == 2
    moved_draft = draft | {"waypoints": [list(midpoint(net, "e_CD"))]}
    move = client.post(f"/api/scenarios/{child['scenario_id']}/hazards/{p['hazard']['track_id']}/replace/preview", json=moved_draft)
    assert move.status_code == 200, move.text
    assert move.json()["kind"] == "replace_hazard" and move.json()["edge_ids"] == ["e_CD", "e_DC"]
    assert len(svc.store.list_scenarios()) == 2
    moved = client.post(f"/api/scenarios/{child['scenario_id']}/edit/apply", json=move.json())
    assert moved.status_code == 200, moved.text
    assert [h["track_id"] for h in moved.json()["hazards"]] == [move.json()["hazard"]["track_id"]]
    assert len(moved.json()["restrictions"]) == 1
    assert svc.scenario(child["scenario_id"]).hazards[0].track_id == p["hazard"]["track_id"]
    missing = client.post(f"/api/scenarios/{child['scenario_id']}/hazards/not-there/replace/preview", json=moved_draft)
    assert missing.status_code == 422
    removal = client.post(f"/api/scenarios/{child['scenario_id']}/hazards/{p['hazard']['track_id']}/remove/preview")
    assert removal.status_code == 200
    assert len(svc.store.list_scenarios()) == 3
    removed = client.post(f"/api/scenarios/{child['scenario_id']}/edit/apply", json=removal.json())
    assert removed.status_code == 200
    assert removed.json()["hazards"] == removed.json()["restrictions"] == []
    assert svc.scenario(child["scenario_id"]).hazards
    area = draft | {"shape": "polygon", "radius_m": 0, "kind": "fire", "waypoints": [list(c) for c in polygon_around(net, "e_CD")]}
    polygon = client.post(f"/api/scenarios/{parent.scenario_id}/hazards/preview", json=area)
    assert polygon.status_code == 200, polygon.text
    assert polygon.json()["edge_ids"] == ["e_CD", "e_DC"] and polygon.json()["hazard"]["shape"] == "polygon"
    crossed = client.post(f"/api/scenarios/{parent.scenario_id}/hazards/preview", json=area | {"waypoints": [area["waypoints"][i] for i in (0, 2, 1, 3)]})
    assert crossed.status_code == 422 and "cross" in crossed.text


@pytest.mark.parametrize("changes", [
    {"waypoints": []}, {"waypoints": [[-80, 43.64]]}, {"radius_m": -1},
    {"start_s": 300}, {"end_s": 1001}, {"modes": ["pedestrian"]}, {"kind": "unknown"},
])
def test_typed_api_rejects_invalid_drafts_without_storing(api_world, changes):
    client, svc, _, parent, net = api_world
    draft = hazard(net).model_dump(mode="json", include=set(HazardDraft.model_fields))
    response = client.post(f"/api/scenarios/{parent.scenario_id}/hazards/preview", json=draft | changes)
    assert response.status_code == 422
    assert len(svc.store.list_scenarios()) == 1


def test_saved_flood_scenarios_still_load_and_can_be_removed(api_world):
    client, svc, pack, parent, net = api_world
    original = edits.apply(pack, parent, edits.preview_hazard(pack, parent, hazard(net, kind="flood")))
    stored = ScenarioSpec.model_validate_json(original.model_dump_json())
    svc.register_scenario(stored, svc.demand(parent.scenario_id))
    loaded = svc.scenario(stored.scenario_id)
    assert loaded == original and loaded.hazards[0].kind == "flood"
    track_id = loaded.hazards[0].track_id
    removal = client.post(f"/api/scenarios/{loaded.scenario_id}/hazards/{track_id}/remove/preview")
    assert removal.status_code == 200, removal.text
    applied = client.post(f"/api/scenarios/{loaded.scenario_id}/edit/apply", json=removal.json())
    assert applied.status_code == 200, applied.text
    assert applied.json()["hazards"] == applied.json()["restrictions"] == []
    assert svc.scenario(stored.scenario_id) == original


def test_api_rejects_modified_preview_and_wrong_parent(api_world):
    client, svc, _, parent, net = api_world
    p = svc.preview_hazard(parent.scenario_id, hazard(net)).model_dump(mode="json")
    response = client.post(f"/api/scenarios/{parent.scenario_id}/edit/apply", json=p | {"edge_ids": ["foreign"]})
    assert response.status_code == 422
    response = client.post(f"/api/scenarios/{parent.scenario_id}/edit/apply", json=p | {"base_scenario_id": "different"})
    assert response.status_code == 422
    assert len(svc.store.list_scenarios()) == 1


def run_compiled(pack, scenario, demand, tmp_path):
    comp = compile_scenario(pack, scenario, demand, baseline_plan(), tmp_path, 1)
    assert comp.ok and comp.cfg is not None, comp.errors
    record = SumoRunner(Path(pack.net_file)).run(
        comp.cfg, scenario.constraints.horizon_s, comp.cohort_ids, comp.desired_depart, [], comp.stop_ids,
        cohort_vehicles=comp.cohort_vehicles, unroutable=comp.unroutable, label=tmp_path.name,
    )
    metrics = compute_metrics(record, scenario.constraints.horizon_s, [])
    assert sum(getattr(metrics, k) for k in (
        "completed", "unfinished_waiting", "unfinished_riding", "unfinished_walking", "unfinished_not_departed", "unroutable",
    )) == len(demand.travelers)
    return comp, record, metrics


@pytest.mark.parametrize("modes, expected_unroutable", [(["passenger", "bus"], 1), (["bus"], 0)])
def test_sumo_hazard_blocks_only_supported_modes_during_window_and_accounts_every_traveler(world, tmp_path, modes, expected_unroutable):
    pack, parent, net = world
    p = edits.preview_hazard(pack, parent, hazard(net, modes=modes))
    child = edits.apply(pack, parent, p)
    demand = DemandSet(demand_id="d", seed=1, travelers=[
        Traveler(person_id=pid, origin_edge="e_AB", dest_edge="e_CD", dest_zone="east", depart_s=t, has_car=car)
        for pid, t, car in [("before", 0, True), ("during", 150, True), ("after", 300, True), ("walker", 150, False)]
    ])
    comp, record, metrics = run_compiled(pack, child, demand, tmp_path)
    assert metrics.unroutable == expected_unroutable
    assert metrics.completed == 4 - expected_unroutable
    assert metrics.teleports == 0
    assert "walker" in record.arrived
    assert ("during" in comp.unroutable) == bool(expected_unroutable)
    assert closure_violations(tmp_path / "vehroutes.xml", child) == {}
    xml_edges = {e.get("id") for e in ET.parse(tmp_path / "scenario.add.xml").iter("closingReroute")}
    assert xml_edges == set(p.edge_ids) == set(child.restrictions[0].edge_ids)


def test_sumo_vehicle_already_inside_is_caught_not_illegal_entry(world, tmp_path):
    pack, parent, net = world
    child = edits.apply(pack, parent, edits.preview_hazard(pack, parent, hazard(net, start_s=35, end_s=160)))
    demand = DemandSet(demand_id="d", seed=1, travelers=[
        Traveler(person_id="caught", origin_edge="e_AB", dest_edge="e_CD", dest_zone="east", depart_s=0, has_car=True),
    ])
    _, _, metrics = run_compiled(pack, child, demand, tmp_path)
    assert metrics.completed == 1 and metrics.teleports == 0
    assert closure_violations(tmp_path / "vehroutes.xml", child) == {"car_caught": "caught"}


def test_sumo_overlaps_do_not_reopen_independent_hazard_and_leave_notification_roads_open(world, tmp_path):
    pack, parent, net = world
    parent.restrictions = [Restriction(restriction_id="manual", edge_ids=["e_BC"], start_s=100, end_s=200, modes=["passenger"])]
    child = edits.apply(pack, parent, edits.preview_hazard(pack, parent, hazard(net, start_s=150, end_s=300)))
    comp = compile_scenario(pack, child, DemandSet(demand_id="d", seed=1, travelers=[]), baseline_plan(), tmp_path, 1)
    assert comp.ok
    traci.start([binary("sumo"), "-c", str(comp.cfg)], label=tmp_path.name)
    conn = traci.getConnection(tmp_path.name)
    try:
        for t, cars, buses in [(99, True, True), (101, False, True), (151, False, False), (201, False, False), (301, True, True)]:
            conn.simulationStep(t)
            allowed = conn.lane.getAllowed("e_BC_1")
            assert ("passenger" in allowed) == cars, (t, allowed)
            assert ("bus" in allowed) == buses, (t, allowed)
            assert "passenger" in conn.lane.getAllowed("e_AB_1")
            assert "pedestrian" in conn.lane.getAllowed("e_BC_0")
    finally:
        conn.close()


def test_whole_network_hazard_reports_unroutable_cohort_and_omitted_background(world, tmp_path):
    pack, parent, net = world
    child = edits.apply(pack, parent, edits.preview_hazard(pack, parent, hazard(net, radius_m=2000, start_s=0, end_s=1000)))
    demand = DemandSet(demand_id="d", seed=1, background_vehicles=5, travelers=[
        Traveler(person_id="blocked", origin_edge="e_AB", dest_edge="e_CD", dest_zone="east", depart_s=10, has_car=True),
    ])
    comp, _, metrics = run_compiled(pack, child, demand, tmp_path)
    assert metrics.unroutable == 1 and metrics.cohort_size == 1
    assert any("5 background cars omitted" in note for note in comp.notes)


def test_sumo_worker_persists_hazard_outcomes_in_mongodb(world, tmp_path, monkeypatch):
    from cityshift.api.service import Service
    from cityshift.domain import runs

    pack, parent, net = world
    mongo = MongoStore(mongomock.MongoClient().hazard_runs_test)
    svc = Service(mongo, workers=1)
    monkeypatch.setattr(svc, "pack", lambda _: pack)
    monkeypatch.setattr(runs, "RUN_ROOT", tmp_path / "runs")
    monkeypatch.setattr(runs, "_runners", {})
    cohort = DemandSet(demand_id=parent.demand_id, seed=1, travelers=[
        Traveler(person_id=pid, origin_edge="e_AB", dest_edge="e_CD", dest_zone="east", depart_s=t, has_car=True)
        for pid, t in [("during", 150), ("after", 300)]
    ])
    try:
        svc.register_scenario(parent, cohort)
        child = svc.apply_edit(parent.scenario_id, svc.preview_hazard(parent.scenario_id, hazard(net)))
        submitted = svc.submit_run(child.scenario_id, "baseline", 1)
        svc.pool.shutdown(wait=True)
        measured = mongo.get_run(submitted.run_id)
        assert measured.status == "completed", measured.error
        assert measured.metrics.cohort_size == 2
        assert measured.metrics.completed == measured.metrics.unroutable == 1
        assert mongo.get_scenario(parent.scenario_id).hazards == []
        assert mongo.get_demand(child.scenario_id) == cohort
        assert mongo.list_runs(child.scenario_id) == [measured]
        assert (Path(measured.run_dir) / "tracks.json").exists()
    finally:
        svc.close()


@pytest.mark.parametrize("window", [
    "from -01:00 to 05:00", "from -00:30 to 05:00", "from 101:00 to 105:00", "from 00:00 to 10:001",
])
def test_prompt_rejects_malformed_or_out_of_horizon_windows(world, window):
    pack, parent, _ = world
    with pytest.raises(ValueError):
        edits.preview(pack, parent, f"hazard venue 30 m {window}")
