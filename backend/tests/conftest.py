from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

import pytest
import sumolib

from cityshift.contracts import (
    CityPack,
    ConstraintSet,
    DestinationZone,
    DevelopmentSpec,
    DevelopmentWave,
    FleetVehicle,
    ScenarioSpec,
    StopCandidate,
)
from cityshift.domain import network
from cityshift.transport.sumo_env import binary
from cityshift.transport.tiny_fixture import EDGES, GEO_NODES, STOPS


@pytest.fixture(scope="session")
def development_net_path(tmp_path_factory) -> Path:
    root = tmp_path_factory.mktemp("development-net")
    nodes, edges, net = root / "nodes.xml", root / "edges.xml", root / "net.xml"
    nodes.write_text(GEO_NODES.replace("</nodes>", '''
        <node id="I" x="-79.389" y="43.646"/>
        <node id="J" x="-79.387" y="43.646"/>
        <node id="P" x="-79.389" y="43.648"/>
        <node id="Q" x="-79.387" y="43.648"/>
    </nodes>'''))
    edges.write_text(EDGES.replace("</edges>", '''
        <edge id="isolated" from="I" to="J" numLanes="1" speed="13.9" sidewalkWidth="2.0"/>
        <edge id="isolated-back" from="J" to="I" numLanes="1" speed="13.9" sidewalkWidth="2.0"/>
        <edge id="footpath" from="P" to="Q" numLanes="1" speed="1.4" allow="pedestrian"/>
    </edges>'''))
    subprocess.run([
        binary("netconvert"), "--node-files", str(nodes), "--edge-files", str(edges),
        "--output-file", str(net), "--proj.utm", "true", "--no-turnarounds", "false", "--crossings.guess", "true",
    ], check=True, capture_output=True, text=True)
    return net


@pytest.fixture
def transport_world(development_net_path, monkeypatch):
    net = sumolib.net.readNet(str(development_net_path))

    def point(edge_id, fraction=0.5):
        edge = net.getEdge(edge_id)
        xy = sumolib.geomhelper.positionAtShapeOffset(edge.getShape(), edge.getLength() * fraction)
        return net.convertXY2LonLat(*xy)

    stops = []
    for stop in STOPS:
        edge_id, lane = stop.lane.rsplit("_", 1)
        lon, lat = point(edge_id, (stop.start_pos + stop.end_pos) / 2 / net.getEdge(edge_id).getLength())
        stops.append(StopCandidate(
            stop_id=stop.stop_id, name=stop.name, edge_id=edge_id, lane_index=int(lane),
            start_pos=stop.start_pos, end_pos=stop.end_pos, lon=lon, lat=lat,
        ))
    pack = CityPack(
        pack_id="development-test", name="Development transport fixture", version="1",
        net_file=str(development_net_path), network_fingerprint="tiny-development-v1",
        bbox=(-79.395, 43.635, -79.370, 43.650), center=point("e_BC"),
        venue_edge_id="e_AB", venue_lonlat=point("e_AB"), stops=stops,
        zones=[
            DestinationZone(zone_id="east", name="East", edge_ids=["e_CD", "e_DC"],
                            lon=point("e_CD")[0], lat=point("e_CD")[1], share=0.6),
            DestinationZone(zone_id="north", name="North", edge_ids=["e_CE", "e_EC"],
                            lon=point("e_CE")[0], lat=point("e_CE")[1], share=0.4),
        ], real_data=False,
    )
    scenario = ScenarioSpec(
        scenario_id="parent", pack_id=pack.pack_id, demand_id="parent-demand",
        constraints=ConstraintSet(
            fleet=[FleetVehicle(vehicle_id="bus_A", capacity=3, depot_edge="e_AB"),
                   FleetVehicle(vehicle_id="bus_B", capacity=3, depot_edge="e_AB")],
            horizon_s=1800, service_window_s=(0, 1500), allowed_stop_ids=[s.stop_id for s in stops],
        ),
    )
    monkeypatch.setattr(network, "load_pack", lambda _: pack)
    network.load_net.cache_clear()
    network._walk_graph.cache_clear()
    network._walk_cache.clear()
    yield pack, scenario, net
    network.load_net.cache_clear()
    network._walk_graph.cache_clear()
    network._walk_cache.clear()


@pytest.fixture
def development_spec(transport_world):
    pack, _, _ = transport_world
    return DevelopmentSpec(
        name="Test apartments", land_use="residential", position=pack.venue_lonlat,
        footprint_m=(30, 20), height_m=24, capacity=8, people_per_unit=1, trip_rate=1,
        car_share=0.25, walk_limit_m=400, zone_shares={"east": 1},
        first_wave=DevelopmentWave(start_s=0, end_s=60, profile="uniform"), seed=7,
    )


@pytest.fixture(scope="session")
def live_pack(tmp_path_factory):
    root = tmp_path_factory.mktemp("live-network")
    nodes, edges, net_path = root / "nodes.xml", root / "edges.xml", root / "network.net.xml"
    nodes.write_text(GEO_NODES)
    bypass = ''.join(
        f'<edge id="{eid}" from="{a}" to="{b}" numLanes="1" speed="13.9" sidewalkWidth="3.0"/>'
        for eid, a, b in [("e_AE", "A", "E"), ("e_EA", "E", "A"), ("e_ED", "E", "D"), ("e_DE", "D", "E"), ("e_BE", "B", "E"), ("e_EB", "E", "B")]
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
