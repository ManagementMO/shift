from collections import defaultdict

from pyproj import CRS
from shapely.affinity import translate
from shapely.ops import unary_union
from shapely.strtree import STRtree

from cityshift.citypack.geometry import iter_polys, polygon_record, polygon_shape, resolve_building_volumes

LEGACY_ASSET_SHA256 = "fd310139287e5ed6638695f047cd3d3d9681f14f35ec4dbe7ac51aef1936aa60"
LEGACY_CN_ANCHOR = (179.1, -662.1)


def alignment(asset: dict, crs: dict, landmarks: list[dict], fingerprint: str, source_hash: str) -> tuple[float, float, str]:
    if asset.get("version") != 1:
        raise ValueError("Unsupported massing version")
    if asset.get("network_fingerprint") == fingerprint:
        return 0, 0, "matching-network"
    source_crs = asset.get("coordinate_frame")
    if source_crs:
        if not CRS.from_user_input(source_crs["proj"]).equals(CRS.from_user_input(crs["proj"])):
            raise ValueError("Massing projection differs from the city pack")
        shift = [crs["net_offset"][i] - crs["origin_net"][i] - source_crs["net_offset"][i] + source_crs["origin_net"][i] for i in (0, 1)]
        return shift[0], shift[1], "coordinate-frame"
    anchor = next((landmark for landmark in landmarks if landmark["id"] == "w32742038" and landmark["kind"] == "cn_tower"), None)
    if source_hash == LEGACY_ASSET_SHA256 and anchor and CRS.from_user_input(crs["proj"]).equals(CRS.from_epsg(32617)):
        return anchor["x"] - LEGACY_CN_ANCHOR[0], anchor["z"] - LEGACY_CN_ANCHOR[1], "verified-legacy-anchor"
    raise ValueError("Massing has no compatible network, coordinate frame, or verified legacy anchor")


def prepare_massing(asset: dict, crs: dict, landmarks: list[dict], buildings: list[dict], fingerprint: str, source_hash: str = "") -> tuple[list[dict], dict]:
    dx, dz, method = alignment(asset, crs, landmarks, fingerprint, source_hash)
    source_buildings = {b["id"]: b for b in asset["buildings"]}
    landmark_area = unary_union([polygon_shape(landmark) for landmark in landmarks])
    volumes: list[dict] = []
    for building in asset["buildings"]:
        for index, tier in enumerate(building["tiers"]):
            if tier["y1"] <= tier["y0"]:
                continue
            shape = translate(polygon_shape(tier), xoff=dx, yoff=dz).difference(landmark_area)
            for part, poly in enumerate(iter_polys(shape)):
                if poly.area < 0.01:
                    continue
                volumes.append({"id": f'{building["id"]}:tier:{index}:{part}', "asset_id": building["id"],
                                "source_id": building["id"], "source_height": building["h"], "cat": building["cat"],
                                "base": tier["y0"], "h": tier["y1"] - tier["y0"], **polygon_record(poly)})
    if not volumes:
        raise ValueError("Massing contains no usable building volumes")
    footprint = unary_union([polygon_shape(volume) for volume in volumes])
    footprint_parts = list(iter_polys(footprint))
    index = STRtree(footprint_parts)
    expected = set(asset.get("excluded_osm_ids", []))
    sample_count = 0
    sampled_area = covered_area = 0.0
    overlaps = []
    for building in buildings:
        shape = polygon_shape(building)
        nearby = unary_union([footprint_parts[int(i)] for i in index.query(shape)])
        overlap = shape.intersection(nearby).area if not nearby.is_empty else 0
        overlaps.append((shape, nearby, overlap))
        if (building.get("source_id") or building["id"]) in expected and shape.area > 1:
            sample_count += 1
            sampled_area += shape.area
            covered_area += overlap
    coverage = covered_area / sampled_area if sampled_area else 0
    if expected and (sample_count < min(20, len(expected)) or coverage < 0.75):
        raise ValueError(f"Massing alignment check failed: {sample_count} footprints, {coverage:.1%} coverage")

    by_building: dict[str, list[dict]] = defaultdict(list)
    for volume in resolve_building_volumes(volumes, preserve_landmarks=False):
        area = {"ring": volume["ring"], "holes": volume.get("holes", [])}
        by_building[volume["asset_id"]].append({"y0": volume["base"], "y1": volume["base"] + volume["h"],
                                              **area, "roofs": volume.get("roofs", [area])})
    resolved = [{**source_buildings[key], "x": source_buildings[key]["x"] + dx, "z": source_buildings[key]["z"] + dz,
                 "tiers": tiers} for key, tiers in by_building.items()]
    excluded: list[str] = []
    fallback: list[dict] = []
    for building, (shape, nearby, overlap) in zip(buildings, overlaps, strict=True):
        if building["cat"] == "landmark" or overlap <= 0.01:
            fallback.append(building)
        elif overlap > shape.area * 0.4:
            excluded.append(building.get("source_id", building["id"]))
        else:
            for part, poly in enumerate(iter_polys(shape.difference(nearby))):
                if poly.area < 0.01:
                    continue
                area = polygon_record(poly)
                fallback.append({**building, **area, "id": f'{building["id"]}:massing-clip:{part}',
                                 "source_id": building.get("source_id", building["id"]),
                                 "source_height": building.get("source_height", building["h"]), "roofs": [area]})
    prepared = {**asset, "network_fingerprint": fingerprint, "coordinate_frame": crs, "prepared": True,
                "excluded_osm_ids": excluded, "buildings": resolved,
                "footprints": [polygon_record(p) for p in footprint_parts],
                "alignment": {"method": method, "source_sha256": source_hash, "source_network_fingerprint": asset.get("network_fingerprint"),
                              "translation_m": [dx, dz], "sampled_footprints": sample_count, "area_coverage": coverage}}
    return resolve_building_volumes(fallback), prepared
