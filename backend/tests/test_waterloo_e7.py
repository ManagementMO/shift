from __future__ import annotations

import json
from pathlib import Path

import pytest
from shapely.geometry import box

from cityshift.citypack.build import CITIES, PACK_ROOT, _dist_m
from cityshift.citypack.world import OsmData, compile_buildings
from cityshift.domain.compiler import venue_stop_candidates
from cityshift.domain.network import load_corridors, load_net, load_pack
from cityshift.domain.scenarios import flagship_scenario


class IdentityFrame:
    def lonlat_to_world(self, lon: float, lat: float) -> tuple[float, float]:
        return lon, lat


def test_e7_is_a_separate_campus_district():
    cfg = CITIES["waterloo_e7"]
    assert cfg.pack_id != CITIES["waterloo"].pack_id
    assert CITIES["waterloo"].venue_name == "Waterloo Park bandshell"
    assert CITIES["toronto"].venue_name == "Rogers Centre"
    assert "E7" in cfg.name and "Engineering" in cfg.venue_name
    assert _dist_m(cfg.center, (-80.5395046, 43.4729528)) < 30
    assert _dist_m(cfg.venue_lonlat, cfg.center) < 100
    assert sum(z.share for z in cfg.zones) == pytest.approx(1)
    west, south, east, north = cfg.osm_bbox
    assert (east - west) < 0.04 and (north - south) < 0.025
    for point in (cfg.center, cfg.venue_lonlat, *(z.anchor_lonlat for z in cfg.zones)):
        assert point is not None
        assert west < point[0] < east and south < point[1] < north
    assert cfg.flagship_closure in {c.key for c in cfg.corridors}


@pytest.mark.parametrize(("way_id", "name", "kind", "levels"), [
    ("382735686", "Pearl Sullivan Engineering Building", "engineering_7", 8),
    ("51125806", "Engineering 5", "engineering_5", 6),
    ("158807251", "Engineering 6", "engineering_6", 6),
    ("182091547", "Mike & Ophelia Lazaridis Quantum Nano Centre", "quantum_nano", 7),
])
def test_campus_landmarks_use_osm_identity_and_heights(way_id, name, kind, levels):
    osm = OsmData(
        nodes={"1": (0, 0), "2": (30, 0), "3": (30, 20), "4": (0, 20)},
        ways={way_id: (["1", "2", "3", "4", "1"], {
            "building": "university", "building:levels": str(levels), "name": name,
        })},
    )
    buildings, landmarks = compile_buildings(osm, IdentityFrame(), box(-10, -10, 50, 50))
    assert len(buildings) == len(landmarks) == 1
    building, landmark = buildings[0], landmarks[0]
    assert building["name"] == name
    assert building["cat"] == "landmark" and building["lm"] == kind
    assert landmark["id"] == f"w{way_id}" and landmark["kind"] == kind
    assert landmark["h"] == pytest.approx(round(levels * 3.3 + 0.6, 1))
    assert (landmark["x"], landmark["z"]) == (15, 10)
    assert landmark["ring"] == building["ring"]


def test_davis_centre_landmark_preserves_its_courtyard():
    osm = OsmData(
        nodes={
            "1": (0, 0), "2": (40, 0), "3": (40, 40), "4": (0, 40),
            "5": (10, 10), "6": (30, 10), "7": (30, 30), "8": (10, 30),
        },
        ways={
            "outer": (["1", "2", "3", "4", "1"], {}),
            "inner": (["5", "6", "7", "8", "5"], {}),
        },
        relations={"8765264": (
            [("way", "outer", "outer"), ("way", "inner", "inner")],
            {"type": "multipolygon", "building": "university", "building:levels": "4", "name": "Davis Centre"},
        )},
    )
    buildings, landmarks = compile_buildings(osm, IdentityFrame(), box(-10, -10, 50, 50))
    assert len(buildings) == len(landmarks) == 1
    assert landmarks[0]["kind"] == "davis_centre"
    assert landmarks[0]["holes"] == buildings[0]["holes"]
    assert len(landmarks[0]["holes"]) == 1


@pytest.mark.skipif(not (PACK_ROOT / "waterloo_e7" / "world.json").exists(), reason="E7 city pack not built")
def test_generated_e7_pack_has_real_geometry_and_a_usable_scenario():
    pack = load_pack("waterloo_e7")
    net = load_net(pack.pack_id)
    world = json.loads((PACK_ROOT / pack.pack_id / "world.json").read_text())
    e7 = next(lm for lm in world["landmarks"] if lm["kind"] == "engineering_7")
    assert e7["id"] == "w382735686"
    assert world["network_fingerprint"] == pack.network_fingerprint
    assert world["counts"]["buildings"] > 100
    assert world["counts"]["roads"] > 100
    assert world["green"] and world["rail"] and world["water"]
    assert net.getEdge(pack.venue_edge_id).allows("pedestrian")
    assert venue_stop_candidates(pack)
    assert all(z.edge_ids for z in pack.zones)
    assert all(c["edge_ids"] for c in load_corridors(pack.pack_id).values())
    assert Path(pack.net_file).is_file()
    scenario, demand = flagship_scenario(pack, cohort_size=30)
    assert scenario.pack_id == pack.pack_id and len(demand.travelers) == 30
    assert scenario.restrictions and all(r.edge_ids for r in scenario.restrictions)
    for stop in venue_stop_candidates(pack):
        assert net.getLane(f"{stop.edge_id}_{stop.lane_index}").allows("bus")
