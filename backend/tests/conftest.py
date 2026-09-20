from __future__ import annotations

import hashlib
import subprocess

import pytest
import sumolib

from cityshift.contracts import CityPack, DestinationZone, StopCandidate
from cityshift.transport.sumo_env import binary
from cityshift.transport.tiny_fixture import EDGES, GEO_NODES, STOPS


@pytest.fixture(scope="session")
def live_pack(tmp_path_factory):
    root = tmp_path_factory.mktemp("live-network")
    nodes, edges, net_path = root / "nodes.xml", root / "edges.xml", root / "network.net.xml"
    nodes.write_text(GEO_NODES)
    bypass = ''.join(
        f'<edge id="{eid}" from="{a}" to="{b}" numLanes="1" speed="13.9" sidewalkWidth="3.0"/>'
        for eid, a, b in [("e_AE", "A", "E"), ("e_EA", "E", "A"), ("e_ED", "E", "D"), ("e_DE", "D", "E")]
    )
    edges.write_text(EDGES.replace("</edges>", bypass + "</edges>"))
    subprocess.run([
        binary("netconvert"), "--node-files", str(nodes), "--edge-files", str(edges), "--output-file", str(net_path),
        "--no-turnarounds", "false", "--crossings.guess", "true", "--geometry.remove", "false", "--proj.utm", "true",
    ], capture_output=True, check=True)
    net = sumolib.net.readNet(str(net_path))
    stops = []
    for s in STOPS:
        lane = net.getLane(s.lane)
        xy = sumolib.geomhelper.positionAtShapeOffset(lane.getShape(), (s.start_pos + s.end_pos) / 2)
        lon, lat = net.convertXY2LonLat(*xy)
        stops.append(StopCandidate(stop_id=s.stop_id, name=s.name, edge_id=lane.getEdge().getID(), lane_index=lane.getIndex(), start_pos=s.start_pos, end_pos=s.end_pos, lon=lon, lat=lat))
    low = net.convertXY2LonLat(*net.getBoundary()[:2])
    high = net.convertXY2LonLat(*net.getBoundary()[2:])
    zones = [
        DestinationZone(zone_id=zid, name=name, edge_ids=[edge], lon=stops[i].lon, lat=stops[i].lat, share=share)
        for zid, name, edge, i, share in [("Z_WEST", "West", "e_AB", 0, 0.3), ("Z_EAST", "Downtown", "e_CD", 1, 0.5), ("Z_NORTH", "North", "e_CE", 2, 0.2)]
    ]
    return CityPack(pack_id="live_fixture", name="Live fixture", version="1", net_file=str(net_path), network_fingerprint=hashlib.sha256(net_path.read_bytes()).hexdigest()[:16], bbox=(*low, *high), center=(stops[0].lon, stops[0].lat), venue_edge_id="e_AB", venue_lonlat=(stops[0].lon, stops[0].lat), stops=stops, zones=zones, real_data=False)
