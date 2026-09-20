from __future__ import annotations

from types import SimpleNamespace

import pytest

from cityshift.contracts import BrainAssignment, CityPack, DestinationZone, PopulationSpec
from cityshift.domain.population import district_anchors, generate_population


def fixture_district(monkeypatch, points, *, disconnected=()):
    edges = []
    for name, x, y in points:
        lane = SimpleNamespace(getIndex=lambda: 0, getLength=lambda: 60,
                               allows=lambda _: True, getShape=lambda x=x, y=y: [(x - 30, y), (x + 30, y)])
        edges.append(SimpleNamespace(getID=lambda name=name: name, isSpecial=lambda: False,
                                     getLength=lambda: 60, allows=lambda _: True,
                                     getLanes=lambda lane=lane: [lane]))
    checks = []

    def path(a, b, vClass, ignoreDirection):
        checks.append((a.getID(), b.getID(), vClass, ignoreDirection))
        return (None, 0) if a.getID() in disconnected or b.getID() in disconnected else ([a, b], 60)

    net = SimpleNamespace(hasGeoProj=lambda: True, getEdges=lambda: edges, getShortestPath=path,
                          convertLonLat2XY=lambda lon, lat: ((lon + 79) * 100000, (lat - 43) * 100000),
                          convertXY2LonLat=lambda x, y: (-79 + x / 100000, 43 + y / 100000))
    monkeypatch.setattr("cityshift.domain.population.sumolib.net.readNet", lambda _: net)
    pack = CityPack(pack_id="district-test", name="District fixture", version="1", net_file="fixture",
                    network_fingerprint="fixture-network", bbox=(-80, 42, -78, 44), center=(-79, 43),
                    venue_edge_id="near-0", venue_lonlat=(-79, 43), stops=[], zones=[], real_data=False)
    spec = PopulationSpec(brains=[BrainAssignment(model_family="rules", model_id="fixture", api_provider="local",
                                                  config_ref="fixture", control_mode="rules")])
    return pack, spec, net, checks


def points():
    return [(f"near-{i}", i, 0) for i in range(12)] + [
        ("nw", -600, 600), ("ne", 600, 600), ("sw", -600, -600), ("se", 600, -600),
        ("north", 0, 600), ("south", 0, -600), ("west", -600, 0), ("east", 600, 0),
        ("outside", 701, 0), ("isolated", 699, 699),
    ]


def test_new_district_spreads_connected_anchors_and_preserves_measured_access(monkeypatch):
    pack, spec, net, checks = fixture_district(monkeypatch, points(), disconnected={"isolated"})
    anchors = district_anchors(pack, spec)
    assert len(anchors) == 8
    ids = {a.access["pedestrian"].edge_id for a in anchors}
    assert {"nw", "ne", "sw", "se"} <= ids
    assert not ids & {"outside", "isolated"}
    assert len([edge for edge in ids if edge.startswith("near-")]) == 1
    assert {row[2] for row in checks} == set(spec.enabled_classes)
    assert all(undirected == (kind == "pedestrian") for _, _, kind, undirected in checks)
    for anchor in anchors:
        access = anchor.access["pedestrian"]
        expected = next((x, y) for name, x, y in points() if name == access.edge_id)
        assert net.convertLonLat2XY(anchor.lon, anchor.lat) == pytest.approx(expected)
        assert access.position_m == 30
    assert district_anchors(pack, spec) == anchors


def test_toronto_uses_pack_landmarks_not_distant_city_camera_center(monkeypatch):
    pack, spec, _, _ = fixture_district(monkeypatch, points())
    pack.pack_id = "toronto"
    pack.center = (-78.97, 43.03)
    pack.zones = [DestinationZone(zone_id=id, name=id, edge_ids=[], lon=lon, lat=43, share=0.5)
                  for id, lon in [("Z_ROGERS", -79.001), ("Z_CN_TOWER", -78.999)]]
    assert len(district_anchors(pack, spec)) == 8
    pack.pack_id = "another-city"
    with pytest.raises(ValueError, match="connected eight-anchor"):
        district_anchors(pack, spec)


def test_unreachable_district_fails_instead_of_inventing_access(monkeypatch):
    pack, spec, _, _ = fixture_district(monkeypatch, points(), disconnected={p[0] for p in points() if p[0] != "near-0"})
    with pytest.raises(ValueError, match="connected eight-anchor"):
        district_anchors(pack, spec)


def test_frozen_definitions_keep_their_anchor_geometry_when_new_districts_are_generated(monkeypatch):
    pack, spec, _, _ = fixture_district(monkeypatch, points())
    frozen = generate_population(spec, district_anchors(pack, spec), pack.network_fingerprint)
    original = frozen.model_dump_json()
    pack.center = (-78.999, 43.001)
    generate_population(spec, district_anchors(pack, spec), pack.network_fingerprint)
    assert frozen.model_dump_json() == original
    assert "district" not in frozen.model_dump()
