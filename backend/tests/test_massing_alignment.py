from itertools import combinations

import pytest
from shapely.geometry import Polygon

from cityshift.citypack.geometry import polygon_shape
from cityshift.citypack.massing import LEGACY_ASSET_SHA256, LEGACY_CN_ANCHOR, prepare_massing

CRS = {"proj": "+proj=utm +zone=17 +ellps=WGS84 +datum=WGS84 +units=m +no_defs", "utm_zone": 17,
       "net_offset": [-626705.41, -4831652.88], "origin_net": [3203.875, 2450.355]}
LANDMARKS = [{"id": "w32742038", "kind": "cn_tower", "name": "CN Tower", "x": 179.1, "z": -662.1, "h": 553,
              "ring": [170, -670, 188, -670, 188, -654, 170, -654]}]


def square(x0, z0, x1, z1):
    return [x0, z0, x1, z0, x1, z1, x0, z1]


def asset(**overrides):
    base = {"version": 1, "network_fingerprint": "old-network", "source": "City of Toronto 3D Massing, 2025",
            "license": "Open Government Licence - Toronto", "excluded_osm_ids": ["w1"],
            "buildings": [{"id": "official", "cat": "office", "h": 60, "x": 20, "z": 20, "tiers": [
                {"y0": 0, "y1": 20, "ring": square(0, 0, 40, 40), "holes": []},
                {"y0": 10, "y1": 60, "ring": square(10, 10, 30, 30), "holes": []},
            ]}]}
    return {**base, **overrides}


def volumes_disjoint(tiers):
    for a, b in combinations(tiers, 2):
        vertical = min(a["y1"], b["y1"]) - max(a["y0"], b["y0"])
        pa = Polygon(list(zip(a["ring"][::2], a["ring"][1::2])), [list(zip(h[::2], h[1::2])) for h in a["holes"]])
        pb = Polygon(list(zip(b["ring"][::2], b["ring"][1::2])), [list(zip(h[::2], h[1::2])) for h in b["holes"]])
        assert vertical <= 1e-6 or pa.intersection(pb).area < 1e-6


def test_matching_network_reconciles_tiers_and_clips_fallback_footprints():
    buildings = [{"id": "w1", "cat": "generic", "h": 10, "base": 0, "ring": square(0, 0, 40, 40)},
                 {"id": "w2", "cat": "generic", "h": 8, "base": 0, "ring": square(30, 30, 60, 60)},
                 {"id": "w3", "cat": "generic", "h": 8, "base": 0, "ring": square(200, 200, 220, 220)}]
    fallback, prepared = prepare_massing(asset(), CRS, LANDMARKS, buildings, "old-network")
    assert prepared["alignment"]["method"] == "matching-network"
    assert prepared["excluded_osm_ids"] == ["w1"]
    tiers = prepared["buildings"][0]["tiers"]
    volumes_disjoint(tiers)
    podium = min(tiers, key=lambda t: (t["y0"], polygon_shape(t).area))
    assert podium["y1"] == 10
    lower_roofs = [t for t in tiers if t["y0"] == 10 and t["y1"] == 20]
    assert lower_roofs and all(len(t["roofs"]) == 1 and t["roofs"][0]["holes"] for t in lower_roofs)
    ids = {b.get("source_id", b["id"]) for b in fallback}
    assert "w1" not in ids and "w3" in ids
    clipped = [b for b in fallback if b.get("source_id") == "w2"]
    assert clipped and all(polygon_shape(b).intersection(polygon_shape({"ring": square(0, 0, 40, 40)})).area < 1e-6 for b in clipped)
    assert sum(polygon_shape(b).area for b in clipped) == pytest.approx(800)


def test_legacy_asset_requires_verified_hash_and_anchor():
    buildings = [{"id": "w1", "cat": "generic", "h": 10, "base": 0, "ring": square(1, 1, 41, 41)}]
    with pytest.raises(ValueError):
        prepare_massing(asset(), CRS, LANDMARKS, buildings, "new-network", "0000")
    moved = [{**LANDMARKS[0], "x": LEGACY_CN_ANCHOR[0] + 1, "z": LEGACY_CN_ANCHOR[1] + 1}]
    fallback, prepared = prepare_massing(asset(), CRS, moved, buildings, "new-network", LEGACY_ASSET_SHA256)
    assert prepared["alignment"]["method"] == "verified-legacy-anchor"
    assert prepared["alignment"]["translation_m"] == [pytest.approx(1), pytest.approx(1)]
    assert prepared["buildings"][0]["x"] == pytest.approx(21)
    assert prepared["network_fingerprint"] == "new-network"
    assert prepared["excluded_osm_ids"] == ["w1"]
    assert fallback == []


def test_coordinate_frame_alignment_and_coverage_guard():
    frame = {"proj": CRS["proj"], "net_offset": [CRS["net_offset"][0] - 5, CRS["net_offset"][1]], "origin_net": CRS["origin_net"]}
    buildings = [{"id": "w1", "cat": "generic", "h": 10, "base": 0, "ring": square(5, 0, 45, 40)}]
    _, prepared = prepare_massing(asset(coordinate_frame=frame), CRS, LANDMARKS, buildings, "new-network")
    assert prepared["alignment"]["method"] == "coordinate-frame"
    assert prepared["alignment"]["translation_m"] == [pytest.approx(5), pytest.approx(0, abs=1e-6)]
    far = [{"id": "w1", "cat": "generic", "h": 10, "base": 0, "ring": square(500, 500, 540, 540)}]
    with pytest.raises(ValueError):
        prepare_massing(asset(coordinate_frame=frame), CRS, LANDMARKS, far, "new-network")
