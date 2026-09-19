"""Build the Waterloo city pack from a netconvert'ed OSM network + extracted GRT stops.

Outputs (under var/citypacks/<pack_id>/):
  pack.json        CityPack contract (stops, zones, venue, bbox, fingerprint, limitations)
  roads.geojson    bus/passenger-drivable edges as LineStrings (for the map overlay)
  walk.geojson     pedestrian-only edges (thin overlay)
  stops.add.xml    (already produced by netconvert)
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import sys
from pathlib import Path

import sumolib

from cityshift.contracts import CityPack, DestinationZone, StopCandidate

PACK_ROOT = Path(__file__).resolve().parents[3] / "var" / "citypacks"


def _fingerprint(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def _dist_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    dlat = (b[1] - a[1]) * 110_574.0
    dlon = (b[0] - a[0]) * 111_320.0 * math.cos(math.radians(a[1]))
    return math.hypot(dlat, dlon)


def load_stops(net, stops_xml: Path) -> list[StopCandidate]:
    txt = stops_xml.read_text()
    rows = re.findall(
        r'<busStop id="([^"]+)" name="([^"]*)" lane="([^"]+)" startPos="([^"]+)" endPos="([^"]+)"', txt
    )
    out = []
    for sid, name, lane_id, s, e in rows:
        if "@" in sid:  # netconvert duplicates for split ways
            continue
        lane = net.getLane(lane_id)
        edge = lane.getEdge()
        if not edge.allows("bus"):
            continue
        x, y = sumolib.geomhelper.positionAtShapeOffset(lane.getShape(), (float(s) + float(e)) / 2)
        lon, lat = net.convertXY2LonLat(x, y)
        out.append(
            StopCandidate(
                stop_id=sid, name=name, edge_id=edge.getID(), lane_index=lane.getIndex(),
                start_pos=float(s), end_pos=float(e), lon=lon, lat=lat,
            )
        )
    return out


def nearest_edge(net, lonlat: tuple[float, float], vclass: str, radius: float = 250.0):
    x, y = net.convertLonLat2XY(*lonlat)
    cands = net.getNeighboringEdges(x, y, radius)
    cands = [(d, e) for e, d in cands if e.allows(vclass) and not e.isSpecial()]
    if not cands:
        raise ValueError(f"no {vclass} edge within {radius} m of {lonlat}")
    cands.sort(key=lambda t: t[0])
    return cands[0][1]


def edges_near(net, lonlat: tuple[float, float], vclass: str, radius: float, limit: int = 8) -> list[str]:
    x, y = net.convertLonLat2XY(*lonlat)
    cands = [(d, e) for e, d in net.getNeighboringEdges(x, y, radius) if e.allows(vclass) and not e.isSpecial()]
    cands.sort(key=lambda t: t[0])
    return [e.getID() for _, e in cands[:limit]]


def corridor_edges(net, street_name: str, lat_range: tuple[float, float], lon_range: tuple[float, float]) -> list[str]:
    out = []
    for e in net.getEdges():
        if e.getName() != street_name or not e.allows("passenger"):
            continue
        shape = e.getShape()
        mx = sum(p[0] for p in shape) / len(shape)
        my = sum(p[1] for p in shape) / len(shape)
        lon, lat = net.convertXY2LonLat(mx, my)
        if lat_range[0] <= lat <= lat_range[1] and lon_range[0] <= lon <= lon_range[1]:
            out.append(e.getID())
    return sorted(out)


def edge_feature(net, e, props: dict) -> dict:
    coords = [list(net.convertXY2LonLat(x, y)) for x, y in e.getShape()]
    coords = [[round(c[0], 6), round(c[1], 6)] for c in coords]
    return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords}, "properties": props}


WATERLOO_ZONES = [
    # zone_id, name, anchor stop name (first match), declared share
    ("Z_UW", "University of Waterloo (Transit Plaza)", "9536179464", 0.35),
    ("Z_WLU", "Wilfrid Laurier / University Ave", "2043274974", 0.20),
    ("Z_GRH", "Grand River Hospital Station", "8573591217", 0.20),
    ("Z_NE", "Columbia / Weber (northeast)", "12626553252", 0.15),
    ("Z_UPTOWN", "Uptown / Willis Way", "7742870034", 0.10),
]

WATERLOO_VENUE_LONLAT = (-80.5276, 43.4656)  # Waterloo Park bandshell / Rec Complex grounds
WATERLOO_VENUE_STOP_IDS = ["10309209994", "-1630975813"]  # Erb / Father David Bauer (both sides)


def build_waterloo(pack_dir: Path) -> CityPack:
    net_file = pack_dir / "waterloo.net.xml"
    stops_xml = pack_dir / "stops.add.xml"
    net = sumolib.net.readNet(str(net_file))
    stops = load_stops(net, stops_xml)
    by_id = {s.stop_id: s for s in stops}

    zones: list[DestinationZone] = []
    for zid, name, anchor, share in WATERLOO_ZONES:
        st = by_id[anchor]
        walk_edges = edges_near(net, (st.lon, st.lat), "pedestrian", 180.0)
        zones.append(DestinationZone(zone_id=zid, name=name, edge_ids=walk_edges, lon=st.lon, lat=st.lat, share=share))

    venue_edge = nearest_edge(net, WATERLOO_VENUE_LONLAT, "pedestrian", 300.0)
    bmin = net.convertXY2LonLat(*net.getBoundary()[:2])
    bmax = net.convertXY2LonLat(*net.getBoundary()[2:])
    pack = CityPack(
        pack_id="waterloo",
        name="Waterloo, ON (Uptown / Universities) — OpenStreetMap",
        version="2026-09-19",
        net_file=str(net_file),
        network_fingerprint=_fingerprint(net_file),
        bbox=(bmin[0], bmin[1], bmax[0], bmax[1]),
        center=(-80.5275, 43.4700),
        venue_edge_id=venue_edge.getID(),
        venue_lonlat=WATERLOO_VENUE_LONLAT,
        stops=stops,
        zones=zones,
        limitations=[
            "Road geometry, sidewalks and bus stop positions are real (OpenStreetMap, netconvert 1.27).",
            "Signal timings are SUMO defaults (actuated), not GRT/City of Waterloo plans.",
            "Demand is synthetic: a declared venue-egress cohort, not observed ridership.",
            "Background traffic is a fixed synthetic count, not calibrated to counts.",
            "Scheduled GRT/ION service is not simulated; only the scenario shuttle fleet and cohort cars.",
        ],
        real_data=True,
    )
    (pack_dir / "pack.json").write_text(pack.model_dump_json(indent=1))

    roads = {"type": "FeatureCollection", "features": []}
    walk = {"type": "FeatureCollection", "features": []}
    for e in net.getEdges():
        if e.isSpecial():
            continue
        if e.allows("passenger") or e.allows("bus"):
            roads["features"].append(edge_feature(net, e, {"id": e.getID(), "name": e.getName(), "lanes": e.getLaneNumber(), "bus": e.allows("bus"), "speed": round(e.getSpeed(), 1)}))
        elif e.allows("pedestrian"):
            walk["features"].append(edge_feature(net, e, {"id": e.getID()}))
    (pack_dir / "roads.geojson").write_text(json.dumps(roads, separators=(",", ":")))
    (pack_dir / "walk.geojson").write_text(json.dumps(walk, separators=(",", ":")))
    # Named closure candidates used by the flagship scenario and the prompt-to-edit resolver.
    corridors = {
        "king_uptown": {
            "label": "King St S, William → Erb (Uptown)",
            "edge_ids": corridor_edges(net, "King Street South", (43.4600, 43.4660), (-80.5240, -80.5200)),
        },
        "erb_uptown": {
            "label": "Erb St W, Caroline → King",
            "edge_ids": corridor_edges(net, "Erb Street West", (43.4630, 43.4650), (-80.5260, -80.5215)),
        },
        "university_king": {
            "label": "University Ave W, Albert → King",
            "edge_ids": corridor_edges(net, "University Avenue West", (43.4740, 43.4770), (-80.5330, -80.5250)),
        },
        "columbia_king": {
            "label": "Columbia St W, Hazel → King",
            "edge_ids": corridor_edges(net, "Columbia Street West", (43.4795, 43.4825), (-80.5320, -80.5255)),
        },
    }
    (pack_dir / "corridors.json").write_text(json.dumps(corridors, indent=1))
    return pack


if __name__ == "__main__":
    d = PACK_ROOT / (sys.argv[1] if len(sys.argv) > 1 else "waterloo")
    p = build_waterloo(d)
    print(p.pack_id, len(p.stops), "stops", len(p.zones), "zones", "venue edge", p.venue_edge_id, p.network_fingerprint)
    print(json.dumps({k: len(v["edge_ids"]) for k, v in json.loads((d / "corridors.json").read_text()).items()}))
