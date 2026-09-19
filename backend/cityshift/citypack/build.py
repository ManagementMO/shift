"""Build a city pack from a netconvert'ed OSM network + extracted transit stops.

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
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
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
    out = []
    for el in ET.parse(stops_xml).getroot().iter("busStop"):
        sid = el.get("id", "")
        if "@" in sid:  # netconvert duplicates for split ways
            continue
        lane = net.getLane(el.get("lane"))
        edge = lane.getEdge()
        if not edge.allows("bus"):
            continue
        s, e = float(el.get("startPos", "0")), float(el.get("endPos", "0"))
        x, y = sumolib.geomhelper.positionAtShapeOffset(lane.getShape(), (s + e) / 2)
        lon, lat = net.convertXY2LonLat(x, y)
        out.append(
            StopCandidate(
                stop_id=sid, name=el.get("name", ""), edge_id=edge.getID(), lane_index=lane.getIndex(),
                start_pos=s, end_pos=e, lon=lon, lat=lat,
            )
        )
    return out


@dataclass(frozen=True)
class ExtraStopSpec:
    """A declared shuttle bay: placed on the nearest real bus-permitted lane, never on a closed corridor by construction."""

    stop_id: str
    name: str
    lonlat: tuple[float, float]
    length_m: float = 25.0


def _bus_lane(edge):
    for lane in edge.getLanes():
        if lane.allows("bus"):
            return lane
    raise ValueError(f"edge {edge.getID()} has no bus lane")


def ensure_extra_stops(net, stops_xml: Path, specs: tuple[ExtraStopSpec, ...]) -> list[str]:
    """Append declared stops to stops.add.xml (idempotent by id). Returns ids added this call."""
    if not specs:
        return []
    txt = stops_xml.read_text()
    added: list[str] = []
    lines: list[str] = []
    for spec in specs:
        if re.search(rf'<busStop id="{re.escape(spec.stop_id)}"', txt):
            continue
        x, y = net.convertLonLat2XY(*spec.lonlat)
        cands = [
            (d, e) for e, d in net.getNeighboringEdges(x, y, 150.0)
            if e.allows("bus") and not e.isSpecial() and e.getLength() >= spec.length_m
        ]
        if not cands:
            raise ValueError(f"no bus edge >= {spec.length_m} m within 150 m of {spec.lonlat} for {spec.stop_id}")
        edge = min(cands, key=lambda t: t[0])[1]
        lane = _bus_lane(edge)
        offset, _ = sumolib.geomhelper.polygonOffsetAndDistanceToPoint((x, y), lane.getShape())
        length = lane.getLength()
        end = min(length, max(spec.length_m, offset + spec.length_m / 2))
        start = max(0.0, end - spec.length_m)
        lines.append(
            f'    <busStop id="{spec.stop_id}" name="{spec.name}" lane="{lane.getID()}" '
            f'startPos="{start:.2f}" endPos="{end:.2f}" friendlyPos="true" lines="declared"/>'
        )
        added.append(spec.stop_id)
    if added:
        head, sep, _tail = txt.rpartition("</additional>")
        if not sep:
            raise ValueError(f"{stops_xml} is not a SUMO additional file")
        stops_xml.write_text(head + "\n".join(lines) + "\n</additional>\n")
    return added


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


@dataclass(frozen=True)
class ZoneSpec:
    zone_id: str
    name: str
    share: float
    anchor_stop_id: str | None = None  # explicit stop id, or
    anchor_lonlat: tuple[float, float] | None = None  # nearest bus stop to this point


@dataclass(frozen=True)
class CorridorSpec:
    key: str
    label: str
    street_name: str
    lat_range: tuple[float, float]
    lon_range: tuple[float, float]


@dataclass(frozen=True)
class CityConfig:
    pack_id: str
    name: str
    osm_bbox: tuple[float, float, float, float]  # minlon, minlat, maxlon, maxlat
    center: tuple[float, float]
    venue_lonlat: tuple[float, float]
    venue_name: str
    zones: tuple[ZoneSpec, ...]
    corridors: tuple[CorridorSpec, ...]
    flagship_closure: str  # corridor key closed in the flagship scenario
    transit_agency: str
    extra_stops: tuple[ExtraStopSpec, ...] = ()  # declared shuttle bays where OSM has no usable stop
    limitations: tuple[str, ...] = field(default_factory=tuple)
    lake_relations: tuple[int, ...] = ()  # OSM water relations too big for the tile API (world compiler only)

    @property
    def net_name(self) -> str:
        return f"{self.pack_id}.net.xml"


WATERLOO = CityConfig(
    pack_id="waterloo",
    name="Waterloo, ON (Uptown / Universities) — OpenStreetMap",
    osm_bbox=(-80.5620, 43.4560, -80.5120, 43.4880),
    center=(-80.5275, 43.4700),
    venue_lonlat=(-80.5276, 43.4656),  # Waterloo Park bandshell / Rec Complex grounds
    venue_name="Waterloo Park bandshell",
    zones=(
        ZoneSpec("Z_UW", "University of Waterloo (Transit Plaza)", 0.35, anchor_stop_id="9536179464"),
        ZoneSpec("Z_WLU", "Wilfrid Laurier / University Ave", 0.20, anchor_stop_id="2043274974"),
        ZoneSpec("Z_GRH", "Grand River Hospital Station", 0.20, anchor_stop_id="8573591217"),
        ZoneSpec("Z_NE", "Columbia / Weber (northeast)", 0.15, anchor_stop_id="12626553252"),
        ZoneSpec("Z_UPTOWN", "Uptown / Willis Way", 0.10, anchor_stop_id="7742870034"),
    ),
    corridors=(
        CorridorSpec("king_uptown", "King St S, William → Erb (Uptown)", "King Street South", (43.4600, 43.4660), (-80.5240, -80.5200)),
        CorridorSpec("erb_uptown", "Erb St W, Caroline → King", "Erb Street West", (43.4630, 43.4650), (-80.5260, -80.5215)),
        CorridorSpec("university_king", "University Ave W, Albert → King", "University Avenue West", (43.4740, 43.4770), (-80.5330, -80.5250)),
        CorridorSpec("columbia_king", "Columbia St W, Hazel → King", "Columbia Street West", (43.4795, 43.4825), (-80.5320, -80.5255)),
    ),
    flagship_closure="king_uptown",
    transit_agency="GRT/ION",
)

TORONTO = CityConfig(
    pack_id="toronto",
    name="Toronto, ON (Downtown / Waterfront) — OpenStreetMap",
    osm_bbox=(-79.425, 43.628, -79.355, 43.662),
    center=(-79.3840, 43.6440),
    venue_lonlat=(-79.3893, 43.6414),  # Rogers Centre, beside the CN Tower
    venue_name="Rogers Centre",
    zones=(
        ZoneSpec("Z_UNION", "Union Station", 0.30, anchor_lonlat=(-79.3807, 43.6453)),
        ZoneSpec("Z_FIN", "Financial District (King / Bay)", 0.20, anchor_lonlat=(-79.3817, 43.6489)),
        ZoneSpec("Z_HARBOUR", "Harbourfront (Queens Quay)", 0.15, anchor_lonlat=(-79.3800, 43.6390)),
        ZoneSpec("Z_STLAW", "St. Lawrence Market", 0.15, anchor_lonlat=(-79.3716, 43.6487)),
        ZoneSpec("Z_LIBERTY", "Liberty Village", 0.20, anchor_lonlat=(-79.4180, 43.6385)),
    ),
    corridors=(
        CorridorSpec("front_west", "Front St W, Blue Jays Way → York", "Front Street West", (43.6420, 43.6460), (-79.3950, -79.3825)),
        CorridorSpec("lakeshore_west", "Lake Shore Blvd W, Bathurst → York", "Lake Shore Boulevard West", (43.6350, 43.6420), (-79.4000, -79.3820)),
        CorridorSpec("queens_quay", "Queens Quay W, Spadina → Bay", "Queens Quay West", (43.6360, 43.6410), (-79.3960, -79.3770)),
        CorridorSpec("bremner", "Bremner Blvd, Spadina → York", "Bremner Boulevard", (43.6400, 43.6440), (-79.3950, -79.3820)),
        CorridorSpec("king_west", "King St W, Spadina → University", "King Street West", (43.6440, 43.6490), (-79.3960, -79.3860)),
        CorridorSpec("spadina", "Spadina Ave, Lake Shore → King", "Spadina Avenue", (43.6380, 43.6480), (-79.3960, -79.3930)),
    ),
    flagship_closure="front_west",
    transit_agency="TTC/GO",
    extra_stops=(
        ExtraStopSpec("SB_BREMNER", "Bremner Blvd shuttle bay — Rogers Centre (declared)", (-79.3878, 43.6418)),
        ExtraStopSpec("SB_REES", "Rees St / Lake Shore shuttle bay (declared)", (-79.3905, 43.6402)),
    ),
    limitations=(
        "OSM has no bus stop within 900 m of Rogers Centre; two shuttle bays are declared on real bus-permitted lanes (ids SB_*).",
        "Streetcar/subway service is not simulated; only the declared shuttle fleet and background traffic run.",
    ),
    lake_relations=(1206310,),  # Lake Ontario
)

WATERLOO_E7 = CityConfig(
    pack_id="waterloo_e7",
    name="Waterloo · E7, ON (University of Waterloo / Engineering) — OpenStreetMap",
    osm_bbox=(-80.5550, 43.4650, -80.5250, 43.4830),
    center=(-80.5395046, 43.4729528),
    venue_lonlat=(-80.5395046, 43.4729528),
    venue_name="Engineering 7 (E7) / Pearl Sullivan Engineering Building",
    zones=(
        ZoneSpec("Z_UW_TRANSIT", "University of Waterloo Station / Transit Plaza", 0.35, anchor_lonlat=(-80.5404298, 43.4740482)),
        ZoneSpec("Z_VILLAGE", "Village 1 / Columbia", 0.20, anchor_lonlat=(-80.5510484, 43.4731675)),
        ZoneSpec("Z_WLU", "Wilfrid Laurier / University Ave", 0.20, anchor_lonlat=(-80.5274582, 43.4751553)),
        ZoneSpec("Z_SOUTH_CAMPUS", "South campus / Environment 3", 0.15, anchor_lonlat=(-80.5435900, 43.4678112)),
        ZoneSpec("Z_PHILLIP", "Phillip / Columbia", 0.10, anchor_lonlat=(-80.5394934, 43.4765035)),
    ),
    corridors=(
        CorridorSpec("phillip_campus", "Phillip St, University Ave → Columbia St", "Phillip Street", (43.4715, 43.4773), (-80.5405, -80.5353)),
        CorridorSpec("university_campus", "University Ave W, campus frontage", "University Avenue West", (43.4670, 43.4740), (-80.5460, -80.5335)),
        CorridorSpec("columbia_campus", "Columbia St W, Village 1 → Phillip", "Columbia Street West", (43.4715, 43.4785), (-80.5530, -80.5385)),
    ),
    flagship_closure="phillip_campus",
    transit_agency="GRT/ION",
    limitations=(
        "E7 is mapped as Pearl Sullivan Engineering Building (PSE) in OpenStreetMap.",
        "Building heights use OSM levels/defaults; facade materials are procedural, not surveyed or photographic.",
    ),
)

CITIES: dict[str, CityConfig] = {c.pack_id: c for c in (WATERLOO, TORONTO, WATERLOO_E7)}


def _nearest_stop(stops: list[StopCandidate], lonlat: tuple[float, float]) -> StopCandidate:
    return min(stops, key=lambda s: _dist_m((s.lon, s.lat), lonlat))


def build_pack(cfg: CityConfig, pack_dir: Path) -> CityPack:
    net_file = pack_dir / cfg.net_name
    stops_xml = pack_dir / "stops.add.xml"
    net = sumolib.net.readNet(str(net_file))
    ensure_extra_stops(net, stops_xml, cfg.extra_stops)
    stops = load_stops(net, stops_xml)
    by_id = {s.stop_id: s for s in stops}

    zones: list[DestinationZone] = []
    for z in cfg.zones:
        if z.anchor_stop_id is not None:
            st = by_id[z.anchor_stop_id]
        elif z.anchor_lonlat is not None:
            st = _nearest_stop(stops, z.anchor_lonlat)
        else:
            raise ValueError(f"zone {z.zone_id} needs an anchor")
        walk_edges = edges_near(net, (st.lon, st.lat), "pedestrian", 180.0)
        zones.append(DestinationZone(zone_id=z.zone_id, name=z.name, edge_ids=walk_edges, lon=st.lon, lat=st.lat, share=z.share))

    venue_edge = nearest_edge(net, cfg.venue_lonlat, "pedestrian", 300.0)
    bmin = net.convertXY2LonLat(*net.getBoundary()[:2])
    bmax = net.convertXY2LonLat(*net.getBoundary()[2:])
    pack = CityPack(
        pack_id=cfg.pack_id,
        name=cfg.name,
        version="2026-09-19",
        net_file=str(net_file),
        network_fingerprint=_fingerprint(net_file),
        bbox=(bmin[0], bmin[1], bmax[0], bmax[1]),
        center=cfg.center,
        venue_edge_id=venue_edge.getID(),
        venue_lonlat=cfg.venue_lonlat,
        stops=stops,
        zones=zones,
        limitations=[
            "Road geometry, sidewalks and bus stop positions are real (OpenStreetMap, netconvert 1.27).",
            f"Signal timings are SUMO defaults (actuated), not {cfg.transit_agency} / municipal plans.",
            "Demand is synthetic: a declared venue-egress cohort, not observed ridership.",
            "Background traffic is a fixed synthetic count, not calibrated to counts.",
            f"Scheduled {cfg.transit_agency} service is not simulated; only the scenario shuttle fleet and cohort cars.",
            *cfg.limitations,
        ],
        real_data=True,
    )
    (pack_dir / "pack.json").write_text(pack.model_dump_json(indent=1))

    roads: dict = {"type": "FeatureCollection", "features": []}
    walk: dict = {"type": "FeatureCollection", "features": []}
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
        c.key: {
            "label": c.label,
            "edge_ids": corridor_edges(net, c.street_name, c.lat_range, c.lon_range),
            "flagship_closure": c.key == cfg.flagship_closure,
        }
        for c in cfg.corridors
    }
    (pack_dir / "corridors.json").write_text(json.dumps(corridors, indent=1))
    return pack


def build_waterloo(pack_dir: Path) -> CityPack:
    return build_pack(WATERLOO, pack_dir)


if __name__ == "__main__":
    cfg = CITIES[sys.argv[1] if len(sys.argv) > 1 else "waterloo"]
    d = PACK_ROOT / cfg.pack_id
    p = build_pack(cfg, d)
    print(p.pack_id, len(p.stops), "stops", len(p.zones), "zones", "venue edge", p.venue_edge_id, p.network_fingerprint)
    print(json.dumps({k: len(v["edge_ids"]) for k, v in json.loads((d / "corridors.json").read_text()).items()}))
