"""Toronto World Compiler: OSM tiles + the SUMO network -> one `world.json` the Babylon renderer loads.

    python -m cityshift.citypack.world toronto        # -> var/citypacks/toronto/world.json

World coordinates are SUMO network metres re-centred on `origin_net` (x = east, z = north), so every road,
junction and stop in the visible world is the *same geometry* the simulator drives on.  Buildings, water,
parks and rail come from the cached OSM tiles and are projected through the network's own projection, so the
rendered and simulated geography share one coordinate system by construction.  Everything is quantised to
0.1 m.  Nothing here is simulated: the file is a static description of the miniature.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import xml.etree.ElementTree as ET
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

import sumolib
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import polygonize, unary_union

from cityshift.citypack.build import PACK_ROOT
from cityshift.citypack.geometry import iter_polys, polygon_record, resolve_building_volumes
from cityshift.citypack.massing import prepare_massing

MASSING_ASSET = PACK_ROOT.parents[1] / "frontend" / "public" / "assets" / "city" / "toronto-massing.json"

LEVEL_M = 3.3
DEFAULT_HEIGHT = {
    "house": 7.0, "detached": 7.0, "semidetached_house": 7.5, "terrace": 9.0, "residential": 12.0,
    "apartments": 24.0, "commercial": 16.0, "retail": 7.0, "office": 45.0, "industrial": 9.0,
    "warehouse": 9.0, "garage": 3.2, "garages": 3.2, "shed": 3.0, "roof": 4.0, "hotel": 40.0,
    "school": 9.0, "university": 16.0, "hospital": 22.0, "church": 14.0, "parking": 12.0,
    "train_station": 18.0, "transportation": 10.0, "public": 12.0, "civic": 12.0, "stadium": 30.0,
    "yes": 10.0,
}
CATEGORY = {
    "house": "residential", "detached": "residential", "semidetached_house": "residential",
    "terrace": "residential", "residential": "residential", "apartments": "apartments",
    "dormitory": "apartments", "hotel": "hotel", "commercial": "commercial", "retail": "retail",
    "office": "office", "industrial": "industrial", "warehouse": "industrial", "garage": "utility",
    "garages": "utility", "shed": "utility", "roof": "utility", "parking": "utility", "service": "utility",
    "school": "civic", "university": "civic", "hospital": "civic", "church": "civic", "public": "civic",
    "civic": "civic", "government": "civic", "train_station": "civic", "transportation": "civic",
    "stadium": "civic", "sports_centre": "civic",
}
LANDMARKS: dict[str, tuple[str, str, float | None]] = {  # osm way id -> (kind, display name, height override)
    "w32742038": ("cn_tower", "CN Tower", 553.0),
    "w7969701": ("rogers_centre", "Rogers Centre", 86.0),
    "w19882585": ("scotiabank_arena", "Scotiabank Arena", 40.0),
    "w14744491": ("union_station", "Union Station", 26.0),
    "w198500761": ("city_hall", "Toronto City Hall", 12.0),
    "w141694015": ("roy_thomson_hall", "Roy Thomson Hall", 22.0),
    "w197447638": ("ripleys_aquarium", "Ripley's Aquarium", 14.0),
    "w382735686": ("engineering_7", "Engineering 7 (E7) / Pearl Sullivan Engineering", None),
    "w51125806": ("engineering_5", "Engineering 5 (E5)", None),
    "w158807251": ("engineering_6", "Engineering 6 (E6)", None),
    "r8765264": ("davis_centre", "Davis Centre (DC)", None),
    "w182091547": ("quantum_nano", "Quantum Nano Centre (QNC)", None),
}
GREEN_TAGS = {
    ("leisure", "park"), ("leisure", "garden"), ("leisure", "pitch"), ("leisure", "playground"),
    ("leisure", "golf_course"), ("leisure", "dog_park"), ("landuse", "grass"), ("landuse", "recreation_ground"),
    ("landuse", "cemetery"), ("landuse", "meadow"), ("landuse", "village_green"), ("natural", "wood"),
    ("natural", "scrub"), ("natural", "grassland"), ("landuse", "forest"),
}
SAND_TAGS = {("natural", "sand"), ("natural", "beach")}
RAIL_VALUES = {"rail", "light_rail", "tram", "narrow_gauge"}


def q(v: float) -> float:
    return round(v, 1)


def parse_height(v: str | None) -> float | None:
    if not v:
        return None
    m = re.match(r"\s*([0-9]+(?:\.[0-9]+)?)\s*(m|ft|')?", v)
    if not m:
        return None
    val = float(m.group(1))
    if m.group(2) in ("ft", "'"):
        val *= 0.3048
    return val if 1.0 <= val <= 600.0 else None


@dataclass
class OsmData:
    nodes: dict[str, tuple[float, float]] = field(default_factory=dict)
    ways: dict[str, tuple[list[str], dict[str, str]]] = field(default_factory=dict)
    relations: dict[str, tuple[list[tuple[str, str, str]], dict[str, str]]] = field(default_factory=dict)


def load_osm_tiles(paths: Iterable[Path]) -> OsmData:
    data = OsmData()
    for p in paths:
        root = ET.parse(p).getroot()
        for n in root.iter("node"):
            data.nodes[n.get("id", "")] = (float(n.get("lon", "0")), float(n.get("lat", "0")))
        for w in root.iter("way"):
            wid = w.get("id", "")
            if wid in data.ways:
                continue
            refs = [nd.get("ref", "") for nd in w.findall("nd")]
            tags = {t.get("k", ""): t.get("v", "") for t in w.findall("tag")}
            data.ways[wid] = (refs, tags)
        for r in root.iter("relation"):
            rid = r.get("id", "")
            if rid in data.relations:
                continue
            members = [(m.get("type", ""), m.get("ref", ""), m.get("role", "")) for m in r.findall("member")]
            tags = {t.get("k", ""): t.get("v", "") for t in r.findall("tag")}
            data.relations[rid] = (members, tags)
    return data


class WorldFrame:
    """The one place lon/lat, SUMO-net and world coordinates meet."""

    def __init__(self, net: sumolib.net.Net) -> None:
        self.net = net
        xmin, ymin, xmax, ymax = net.getBoundary()
        self.origin = ((xmin + xmax) / 2.0, (ymin + ymax) / 2.0)
        self.bounds_net = (xmin, ymin, xmax, ymax)

    def lonlat_to_world(self, lon: float, lat: float) -> tuple[float, float]:
        x, y = self.net.convertLonLat2XY(lon, lat)
        return x - self.origin[0], y - self.origin[1]

    def net_to_world(self, x: float, y: float) -> tuple[float, float]:
        return x - self.origin[0], y - self.origin[1]

    def world_to_lonlat(self, x: float, z: float) -> tuple[float, float]:
        return self.net.convertXY2LonLat(x + self.origin[0], z + self.origin[1])

    def bounds_world(self) -> tuple[float, float, float, float]:
        xmin, ymin, xmax, ymax = self.bounds_net
        return (xmin - self.origin[0], ymin - self.origin[1], xmax - self.origin[0], ymax - self.origin[1])


def flat(ring: Iterable[tuple[float, float]]) -> list[float]:
    out: list[float] = []
    for x, z in ring:
        out.extend((q(x), q(z)))
    return out


def polygon_rings(poly: Polygon) -> tuple[list[float], list[list[float]]]:
    ext = list(poly.exterior.coords)[:-1]
    holes = [flat(list(h.coords)[:-1]) for h in poly.interiors]
    return flat(ext), holes


def way_coords(osm: OsmData, refs: list[str], frame: WorldFrame) -> list[tuple[float, float]]:
    pts = []
    for r in refs:
        n = osm.nodes.get(r)
        if n:
            pts.append(frame.lonlat_to_world(*n))
    return pts


def relation_polygons(osm: OsmData, members: list[tuple[str, str, str]], frame: WorldFrame) -> list[Polygon]:
    """Assemble a multipolygon relation's outer/inner ways into polygons (best effort, shapely polygonize)."""
    outer_lines: list[LineString] = []
    inner_lines: list[LineString] = []
    for mtype, ref, role in members:
        if mtype != "way" or ref not in osm.ways:
            continue
        pts = way_coords(osm, osm.ways[ref][0], frame)
        if len(pts) < 2:
            continue
        (inner_lines if role == "inner" else outer_lines).append(LineString(pts))
    if not outer_lines:
        return []
    outers = list(polygonize(unary_union(outer_lines)))
    if not outers:
        return []
    result = unary_union(outers)
    if inner_lines:
        inners = list(polygonize(unary_union(inner_lines)))
        if inners:
            result = result.difference(unary_union(inners))
    return [p for p in iter_polys(result) if p.area > 1.0]


def building_base(tags: dict[str, str]) -> float:
    height = parse_height(tags.get("min_height")) or parse_height(tags.get("building:min_height"))
    if height is not None:
        return height
    try:
        return max(0.0, min(600.0, float(tags.get("building:min_level", "0")) * LEVEL_M))
    except ValueError:
        return 0.0


def building_height(tags: dict[str, str]) -> float:
    h = parse_height(tags.get("height")) or parse_height(tags.get("building:height"))
    if h is None:
        lv = tags.get("building:levels")
        try:
            levels = float(lv) if lv else None
        except ValueError:
            levels = None
        if levels:
            h = levels * LEVEL_M + (1.5 if tags.get("roof:shape") not in (None, "flat") else 0.6)
    if h is None:
        h = DEFAULT_HEIGHT.get(tags.get("building", "yes"), 10.0)
    return max(2.5, h - building_base(tags))


def compile_buildings(osm: OsmData, frame: WorldFrame, clip: Polygon) -> tuple[list[dict], list[dict]]:
    buildings: list[dict] = []
    landmarks: list[dict] = []
    seen_relation_ways: set[str] = set()

    def emit(poly: Polygon, tags: dict[str, str], key: str) -> None:
        if poly.area < 12.0 or not poly.intersects(clip):
            return
        ring, holes = polygon_rings(poly)
        if len(ring) < 6:
            return
        h = building_height(tags)
        btype = tags.get("building", "yes")
        cat = CATEGORY.get(btype, "generic")
        lm = LANDMARKS.get(key)
        if lm:
            cat = "landmark"
            h = lm[2] or h
        elif h >= 90:
            cat = "tower"
        rec: dict = {"id": key, "ring": ring, "h": q(h), "base": q(building_base(tags)), "cat": cat}
        if holes:
            rec["holes"] = holes
        name = tags.get("name")
        if name and (lm or h >= 60):
            rec["name"] = name
        if lm:
            rec["lm"] = lm[0]
            c = poly.centroid
            landmark = {"id": key, "kind": lm[0], "name": lm[1], "x": q(c.x), "z": q(c.y), "h": q(h), "ring": ring}
            if holes:
                landmark["holes"] = holes
            landmarks.append(landmark)
        buildings.append(rec)

    for rid, (members, tags) in osm.relations.items():
        if tags.get("type") != "multipolygon" or ("building" not in tags and f"r{rid}" not in LANDMARKS):
            continue
        for mtype, ref, _ in members:
            if mtype == "way":
                seen_relation_ways.add(ref)
        for i, poly in enumerate(relation_polygons(osm, members, frame)):
            emit(poly, {**tags, "building": tags.get("building", "yes")}, f"r{rid}" if i == 0 else f"r{rid}.{i}")
    for wid, (refs, tags) in osm.ways.items():
        if "building" not in tags or tags.get("building") == "no" or wid in seen_relation_ways:
            continue
        if len(refs) < 4 or refs[0] != refs[-1]:
            continue
        pts = way_coords(osm, refs, frame)
        if len(pts) < 4:
            continue
        poly = Polygon(pts)
        if not poly.is_valid:
            poly = poly.buffer(0)
        for i, p in enumerate(iter_polys(poly)):
            emit(p, tags, f"w{wid}" if i == 0 else f"w{wid}.{i}")
    return resolve_building_volumes(buildings), landmarks


def compile_areas(osm: OsmData, frame: WorldFrame, clip: Polygon) -> tuple[list[dict], list[dict], list[list[float]]]:
    green: list[dict] = []
    sand: list[dict] = []
    rail: list[list[float]] = []
    seen_relation_ways: set[str] = set()

    def polys_for(tags: dict[str, str]) -> list[dict] | None:
        keys = {(k, v) for k, v in tags.items()}
        if keys & GREEN_TAGS:
            return green
        if keys & SAND_TAGS:
            return sand
        return None

    for members, tags in osm.relations.values():
        target = polys_for(tags) if tags.get("type") == "multipolygon" else None
        if target is None:
            continue
        polygons = relation_polygons(osm, members, frame)
        if polygons:
            seen_relation_ways.update(ref for kind, ref, _ in members if kind == "way")
        for poly in polygons:
            if poly.intersects(clip) and poly.area > 40:
                ring, holes = polygon_rings(poly)
                target.append({"ring": ring, "holes": holes})
    for wid, (refs, tags) in osm.ways.items():
        if wid in seen_relation_ways:
            continue
        if tags.get("railway") in RAIL_VALUES and tags.get("tunnel") != "yes" and tags.get("service") not in ("yard", "siding", "spur"):
            pts = way_coords(osm, refs, frame)
            if len(pts) >= 2 and LineString(pts).intersects(clip):
                rail.append(flat(pts))
            continue
        target = polys_for(tags)
        if target is None or len(refs) < 4 or refs[0] != refs[-1]:
            continue
        pts = way_coords(osm, refs, frame)
        if len(pts) < 4:
            continue
        poly = Polygon(pts)
        if not poly.is_valid:
            poly = poly.buffer(0)
        for p in iter_polys(poly):
            if p.intersects(clip) and p.area > 40:
                ring, holes = polygon_rings(p)
                target.append({"ring": ring, "holes": holes})
    return green, sand, rail


def compile_water(water_json: Path | None, osm: OsmData, frame: WorldFrame, clip: Polygon, land_probes: list[Point]) -> list[dict]:
    """Water polygons.  Lake Ontario arrives as shoreline linework (Overpass `out geom`), so the bbox is
    partitioned along that linework and each face is classed land/water by whether it contains any building
    centroid or road node.  Closed water ways/relations (ponds, slips) are emitted directly."""
    lines: list[LineString] = []
    direct: list[Polygon] = []
    lake_ways = water_json.with_name("lake_ways.json") if water_json else None
    if lake_ways and lake_ways.exists():
        for e in json.loads(lake_ways.read_text())["elements"]:
            if e["type"] == "way" and len(e.get("geometry", [])) >= 2:
                lines.append(LineString([frame.lonlat_to_world(p["lon"], p["lat"]) for p in e["geometry"]]))
    if water_json and water_json.exists():
        data = json.loads(water_json.read_text())
        ways_by_id = {e["id"]: e for e in data["elements"] if e["type"] == "way" and "geometry" in e}
        used: set[int] = set()
        for e in data["elements"]:
            if e["type"] != "relation":
                continue
            outer = []
            for m in e.get("members", []):
                if m["type"] == "way" and m["ref"] in ways_by_id and m.get("role") != "inner":
                    used.add(m["ref"])
                    outer.append(LineString([frame.lonlat_to_world(p["lon"], p["lat"]) for p in ways_by_id[m["ref"]]["geometry"]]))
            if not outer:
                continue
            if e.get("tags", {}).get("name") == "Lake Ontario" or len(outer) > 12:
                lines.extend(outer)
            else:
                for poly in polygonize(unary_union(outer)):
                    if poly.intersects(clip):
                        direct.append(poly)
        for wid, w in ways_by_id.items():
            if wid in used:
                continue
            pts = [frame.lonlat_to_world(p["lon"], p["lat"]) for p in w["geometry"]]
            if len(pts) >= 4 and pts[0] == pts[-1]:
                poly = Polygon(pts)
                if poly.is_valid and poly.intersects(clip):
                    direct.append(poly)
            elif len(pts) >= 2:
                lines.append(LineString(pts))
    for refs, tags in osm.ways.values():
        if tags.get("natural") == "water" and len(refs) >= 4 and refs[0] == refs[-1]:
            pts = way_coords(osm, refs, frame)
            if len(pts) >= 4:
                poly = Polygon(pts)
                if poly.is_valid and poly.intersects(clip):
                    direct.append(poly)

    water: list[Polygon] = list(direct)
    if lines:
        big = clip.buffer(400.0)
        network = unary_union([*lines, big.exterior])
        faces = [f for f in polygonize(network) if f.intersects(clip)]
        # Piers, ferry docks and bridges put a handful of road nodes over open water; land has ~1000 nodes/km².
        for f in faces:
            if f.area < 2000.0:
                continue
            inside = sum(1 for p in land_probes if f.contains(p))
            if inside / (f.area / 1e6) > 10.0:
                continue
            water.append(f)
    out: list[dict] = []
    merged = unary_union(water) if water else None
    if merged is not None:
        for p in iter_polys(merged.intersection(clip)):
            if p.area > 30:
                ring, holes = polygon_rings(p)
                out.append({"ring": ring, "holes": holes} if holes else {"ring": ring})
    return out


def compile_network(net: sumolib.net.Net, frame: WorldFrame) -> tuple[list[dict], list[dict], list[Point]]:
    roads: list[dict] = []
    probes: list[Point] = []
    for e in net.getEdges(withInternal=False):
        if e.getFunction() not in ("", "normal"):
            continue
        shape = [frame.net_to_world(x, y) for x, y in e.getShape()]
        if len(shape) < 2:
            continue
        lanes = []
        allow: set[str] = set()
        for ln in e.getLanes():
            lane_allow = []
            if ln.allows("passenger"):
                lane_allow.append("car")
                allow.add("car")
            if ln.allows("bus"):
                lane_allow.append("bus")
                allow.add("bus")
            if ln.allows("pedestrian"):
                lane_allow.append("ped")
                allow.add("ped")
            lanes.append({"shape": flat(frame.net_to_world(x, y) for x, y in ln.getShape()), "w": q(ln.getWidth()), "allow": lane_allow})
        rtype = e.getType() or ""
        kind = "path" if allow == {"ped"} else ("rail" if "railway" in rtype else "road")
        rec: dict = {
            "id": e.getID(),
            "shape": flat(shape),
            "w": q(sum(ln.getWidth() for ln in e.getLanes())),
            "type": rtype,
            "kind": kind,
            "allow": sorted(allow),
            "prio": e.getPriority(),
            "speed": q(e.getSpeed()),
            "from": e.getFromNode().getID(),
            "to": e.getToNode().getID(),
        }
        if kind != "path":
            rec["lanes"] = lanes
            if e.getName():
                rec["name"] = e.getName()
        roads.append(rec)
        probes.append(Point(shape[len(shape) // 2]))
    junctions: list[dict] = []
    for n in net.getNodes():
        if n.getType() in ("internal", "dead_end"):
            continue
        shp = [frame.net_to_world(x, y) for x, y in n.getShape()]
        if len(shp) < 3:
            continue
        poly = Polygon(shp)
        if not poly.is_valid or poly.area < 2.0:
            continue
        ped_only = all(not (e.allows("passenger") or e.allows("bus")) for e in [*n.getIncoming(), *n.getOutgoing()])
        junctions.append({"id": n.getID(), "ring": flat(shp), "type": n.getType(), "kind": "path" if ped_only else "road", "x": q(n.getCoord()[0] - frame.origin[0]), "z": q(n.getCoord()[1] - frame.origin[1])})
    return roads, junctions, probes


def compile_surfaces(plate: Polygon, roads: list[dict], junctions: list[dict], green: list[dict],
                     sand: list[dict], rail: list[list[float]], water: list[dict]) -> dict[str, list[dict]]:
    def points(ring):
        return list(zip(ring[::2], ring[1::2], strict=True))

    def polygon(area):
        return Polygon(points(area["ring"]), [points(h) for h in area.get("holes", [])]).buffer(0)

    def ribbon(shape, width):
        return LineString(points(shape)).buffer(width / 2, cap_style=2, join_style=2, mitre_limit=2)

    raw: dict[str, list] = {k: [] for k in ("asphalt", "pavement", "rail", "sand", "grass")}
    for road in roads:
        if road["kind"] == "path" or not road.get("lanes"):
            raw["pavement"].append(ribbon(road["shape"], max(1.6, min(road["w"], 4))))
        else:
            for lane in road["lanes"]:
                kind = "pavement" if lane["allow"] == ["ped"] else "asphalt"
                raw[kind].append(ribbon(lane["shape"], lane["w"]))
    for junction in junctions:
        raw["asphalt" if junction["kind"] == "road" else "pavement"].append(polygon(junction))
    raw["rail"] = [ribbon(line, 1.6) for line in rail if len(line) >= 4]
    raw["grass"] = [polygon(a) for a in green]
    raw["sand"] = [polygon(a) for a in sand]
    land = plate.difference(unary_union([polygon(a) for a in water]))
    occupied = Polygon()
    out: dict[str, list[dict]] = {}
    x0, z0, x1, z1 = plate.bounds
    tiles = [box(x, z, min(x + 800, x1), min(z + 800, z1))
             for x in range(int(x0 // 800) * 800, int(x1) + 1, 800)
             for z in range(int(z0 // 800) * 800, int(z1) + 1, 800)]

    def emit(kind, surface):
        out[kind] = []
        for tile in tiles:
            if not surface.intersects(tile):
                continue
            for poly in iter_polys(surface.intersection(tile)):
                if poly.area < 0.01:
                    continue
                out[kind].append(polygon_record(poly))

    for kind, pieces in raw.items():
        surface = unary_union(pieces).intersection(plate)
        if kind in ("grass", "sand"):
            surface = surface.intersection(land)
        surface = surface.difference(occupied)
        emit(kind, surface)
        occupied = unary_union([occupied, surface])
    emit("ground", land.difference(occupied))
    return out


def compile_world(pack_id: str, out_path: Path | None = None) -> Path:
    pack_dir = PACK_ROOT / pack_id
    pack = json.loads((pack_dir / "pack.json").read_text())
    net = sumolib.net.readNet(pack["net_file"], withInternal=False)
    frame = WorldFrame(net)
    osm_dir = PACK_ROOT.parent / "osm" / pack_id
    tiles = sorted(osm_dir.rglob("*.osm"))
    osm = load_osm_tiles(tiles)
    bw = frame.bounds_world()
    clip = box(*bw)

    roads, junctions, probes = compile_network(net, frame)
    buildings, landmarks = compile_buildings(osm, frame, clip)
    for b in buildings:
        r = b["ring"]
        probes.append(Point(sum(r[0::2]) / (len(r) // 2), sum(r[1::2]) / (len(r) // 2)))
    green, sand, rail = compile_areas(osm, frame, clip)
    water = compile_water(PACK_ROOT.parent / "osm" / f"{pack_id}_water" / "lake.json", osm, frame, clip, probes)

    x0, z0, x1, z1 = bw
    pad_x, pad_z = (x1 - x0) * 0.3, (z1 - z0) * 0.3
    surfaces = compile_surfaces(box(x0 - pad_x, z0 - pad_z, x1 + pad_x, z1 + pad_z),
                                roads, junctions, green, sand, rail, water)

    stops = []
    for s in pack["stops"]:
        x, z = frame.lonlat_to_world(s["lon"], s["lat"])
        stops.append({"id": s["stop_id"], "name": s["name"], "edge": s["edge_id"], "x": q(x), "z": q(z)})
    zones = []
    for zn in pack["zones"]:
        x, z = frame.lonlat_to_world(zn["lon"], zn["lat"])
        zones.append({"id": zn["zone_id"], "name": zn["name"], "x": q(x), "z": q(z), "share": zn.get("share")})
    vx, vz = frame.lonlat_to_world(*pack["venue_lonlat"])

    # Landmark anchors: world position from the OSM footprint centroid, lon/lat by the inverse projection, plus one
    # real junction.  The frontend coordinate service must reproduce x/z from lon/lat to within centimetres.
    anchors = []
    for lm in landmarks:
        lon, lat = frame.world_to_lonlat(lm["x"], lm["z"])
        anchors.append({"name": lm["name"], "lon": round(lon, 7), "lat": round(lat, 7), "x": lm["x"], "z": lm["z"]})
    for jn in junctions:
        if jn["kind"] == "road" and jn["type"] == "traffic_light" and abs(jn["x"] - 800) < 400 and abs(jn["z"] + 270) < 400:
            lon, lat = frame.world_to_lonlat(jn["x"], jn["z"])
            anchors.append({"name": f"junction {jn['id']}", "lon": round(lon, 7), "lat": round(lat, 7), "x": jn["x"], "z": jn["z"], "junction": jn["id"]})
            break

    loc = net.getLocationOffset()
    crs = {
        "proj": "+proj=utm +zone=17 +ellps=WGS84 +datum=WGS84 +units=m +no_defs",
        "utm_zone": 17,
        "net_offset": [loc[0], loc[1]],
        "origin_net": [round(frame.origin[0], 3), round(frame.origin[1], 3)],
        "origin_lonlat": [round(v, 7) for v in frame.world_to_lonlat(0.0, 0.0)],
        "bounds_world": [round(v, 1) for v in bw],
    }
    massing = None
    if pack_id == "toronto" and MASSING_ASSET.exists():
        raw = MASSING_ASSET.read_bytes()
        asset = json.loads(raw)
        try:
            buildings, massing = prepare_massing(asset, crs, landmarks, buildings, pack["network_fingerprint"],
                                                 hashlib.sha256(raw).hexdigest())
            massing_path = pack_dir / "massing.json"
            massing_path.write_text(json.dumps(massing, separators=(",", ":")))
            print(json.dumps({"massing": massing["alignment"], "buildings": len(massing["buildings"])}), f"-> {massing_path}", file=sys.stderr)
        except ValueError as exc:
            print(f"massing skipped: {exc}", file=sys.stderr)
    world = {
        "version": 1,
        "pack_id": pack_id,
        "network_fingerprint": pack["network_fingerprint"],
        "crs": crs,
        "anchors": anchors,
        "venue": {"x": q(vx), "z": q(vz), "edge": pack["venue_edge_id"]},
        "stops": stops,
        "zones": zones,
        "roads": roads,
        "junctions": junctions,
        "buildings": buildings,
        "landmarks": landmarks,
        "green": [a["ring"] for a in green],
        "sand": [a["ring"] for a in sand],
        "surfaces": surfaces,
        "rail": rail,
        "water": water,
        "counts": {"roads": len(roads), "junctions": len(junctions), "buildings": len(buildings), "water": len(water), "green": len(green), "rail": len(rail)},
        "provenance": ["OpenStreetMap (ODbL) via api.openstreetmap.org tiles + Overpass shoreline", f"SUMO netconvert network {pack['network_fingerprint']}"],
    }
    if massing:
        world["massing_url"] = f"/api/packs/{pack_id}/massing"
        world["counts"]["massing"] = len(massing["buildings"])
        world["provenance"].append(f"{massing['source']} ({massing['license']}), aligned by {massing['alignment']['method']}")
    out = out_path or (pack_dir / "world.json")
    out.write_text(json.dumps(world, separators=(",", ":")))
    print(json.dumps(world["counts"]), f"-> {out} ({out.stat().st_size / 1e6:.1f} MB)", file=sys.stderr)
    return out


if __name__ == "__main__":
    compile_world(sys.argv[1] if len(sys.argv) > 1 else "toronto")
