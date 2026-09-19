"""Smallest valid transport fixture: a straight 4-node corridor with sidewalks and two bus stops.

Layout (x in metres):   A(0) --e_AB--> B(300) --e_BC--> C(600) --e_CD--> D(900)
Reverse edges exist for return legs.  Bus stop S1 on e_AB (near B), S2 on e_CD (near D).
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from cityshift.transport.sumo_env import binary
from cityshift.transport.sumo_xml import BusStopDef

NODES = """<?xml version="1.0" encoding="UTF-8"?>
<nodes>
    <node id="A" x="0" y="0" type="priority"/>
    <node id="B" x="300" y="0" type="priority"/>
    <node id="C" x="600" y="0" type="priority"/>
    <node id="D" x="900" y="0" type="priority"/>
    <node id="E" x="600" y="300" type="priority"/>
</nodes>
"""

EDGES = """<?xml version="1.0" encoding="UTF-8"?>
<edges>
    <edge id="e_AB" from="A" to="B" numLanes="1" speed="13.9" sidewalkWidth="2.0"/>
    <edge id="e_BA" from="B" to="A" numLanes="1" speed="13.9" sidewalkWidth="2.0"/>
    <edge id="e_BC" from="B" to="C" numLanes="1" speed="13.9" sidewalkWidth="2.0"/>
    <edge id="e_CB" from="C" to="B" numLanes="1" speed="13.9" sidewalkWidth="2.0"/>
    <edge id="e_CD" from="C" to="D" numLanes="1" speed="13.9" sidewalkWidth="2.0"/>
    <edge id="e_DC" from="D" to="C" numLanes="1" speed="13.9" sidewalkWidth="2.0"/>
    <edge id="e_CE" from="C" to="E" numLanes="1" speed="13.9" sidewalkWidth="2.0"/>
    <edge id="e_EC" from="E" to="C" numLanes="1" speed="13.9" sidewalkWidth="2.0"/>
</edges>
"""

# Bus stops are on the driving lane (lane index 1, since lane 0 is the sidewalk).
STOPS = [
    BusStopDef("S1", "e_AB_1", 230.0, 280.0, "Venue Gate"),
    BusStopDef("S2", "e_CD_1", 230.0, 280.0, "East Terminal"),
    BusStopDef("S3", "e_CE_1", 200.0, 250.0, "North Branch"),
    BusStopDef("S1r", "e_BA_1", 20.0, 70.0, "Venue Gate (return)"),
]


def build_tiny_network(out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    nodes = out_dir / "tiny.nod.xml"
    edges = out_dir / "tiny.edg.xml"
    net = out_dir / "tiny.net.xml"
    nodes.write_text(NODES)
    edges.write_text(EDGES)
    if net.exists() and net.stat().st_mtime > max(nodes.stat().st_mtime, edges.stat().st_mtime):
        return net
    cmd = [
        binary("netconvert"),
        "--node-files", str(nodes),
        "--edge-files", str(edges),
        "--output-file", str(net),
        "--no-turnarounds", "false",
        "--crossings.guess", "true",
        "--geometry.remove", "false",
        "--proj.utm", "false",
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"netconvert failed: {res.stderr}")
    return net
