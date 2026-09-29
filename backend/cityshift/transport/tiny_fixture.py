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

# Same corridor on real ground (downtown Toronto waterfront, ~300 m spacing) for geo-aware code paths.
GEO_NODES = """<?xml version="1.0" encoding="UTF-8"?>
<nodes>
    <node id="A" x="-79.39000" y="43.64000" type="priority"/>
    <node id="B" x="-79.38628" y="43.64000" type="priority"/>
    <node id="C" x="-79.38256" y="43.64000" type="priority"/>
    <node id="D" x="-79.37884" y="43.64000" type="priority"/>
    <node id="E" x="-79.38256" y="43.64270" type="priority"/>
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


def build_tiny_network(out_dir: Path, geo: bool = False) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = "tiny_geo" if geo else "tiny"
    nodes = out_dir / f"{stem}.nod.xml"
    edges = out_dir / f"{stem}.edg.xml"
    net = out_dir / f"{stem}.net.xml"
    nodes.write_text(GEO_NODES if geo else NODES)
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
        "--proj.utm", "true" if geo else "false",
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if res.returncode != 0:
        raise RuntimeError(f"netconvert failed: {res.stderr}")
    return net


def build_grid_network(out_dir: Path, size: int = 3) -> Path:
    """A size x size geographic street grid (~210 m blocks) with sidewalks and crossings, so a closed street has a detour.

    Node `n{i}{j}` is column i (west to east), row j (south to north); edge `g_{a}_{b}` runs from node a to node b.
    Every junction has a crossing over each of its streets.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = "grid" if size == 3 else f"grid{size}"
    nodes = out_dir / f"{stem}.nod.xml"
    edges = out_dir / f"{stem}.edg.xml"
    crossings = out_dir / f"{stem}.con.xml"
    net = out_dir / f"{stem}.net.xml"
    nodes.write_text("<nodes>\n" + "".join(
        f'    <node id="n{i}{j}" x="{-79.39 + i * 0.0026:.5f}" y="{43.64 + j * 0.0019:.5f}" type="priority"/>\n'
        for i in range(size) for j in range(size)
    ) + "</nodes>\n")
    streets = ([(f"{i}{j}", f"{i + 1}{j}") for i in range(size - 1) for j in range(size)]
               + [(f"{i}{j}", f"{i}{j + 1}") for i in range(size) for j in range(size - 1)])
    edges.write_text("<edges>\n" + "".join(
        f'    <edge id="g_{a}_{b}" from="n{a}" to="n{b}" numLanes="1" speed="11.1" sidewalkWidth="2.0"/>\n'
        for p, q in streets for a, b in ((p, q), (q, p))
    ) + "</edges>\n")
    crossings.write_text("<connections>\n" + "".join(
        f'    <crossing node="n{node}" edges="g_{p}_{q} g_{q}_{p}" priority="true"/>\n'
        for p, q in streets for node in (p, q)
    ) + "</connections>\n")
    if net.exists() and net.stat().st_mtime > max(path.stat().st_mtime for path in (nodes, edges, crossings)):
        return net
    res = subprocess.run([
        binary("netconvert"), "--node-files", str(nodes), "--edge-files", str(edges), "--connection-files", str(crossings),
        "--output-file", str(net), "--geometry.remove", "false", "--proj.utm", "true",
    ], capture_output=True, text=True, check=False)
    if res.returncode != 0:
        raise RuntimeError(f"netconvert failed: {res.stderr}")
    return net
