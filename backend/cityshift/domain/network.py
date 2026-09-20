"""Network access for the compiler and validators: cached sumolib net per pack, restriction-aware routing."""

from __future__ import annotations

import heapq
import json
import math
from functools import lru_cache
from pathlib import Path

import sumolib

from cityshift.citypack.build import PACK_ROOT
from cityshift.contracts import CityPack, Restriction


@lru_cache(maxsize=4)
def load_pack(pack_id: str) -> CityPack:
    return CityPack.model_validate_json((PACK_ROOT / pack_id / "pack.json").read_text())


@lru_cache(maxsize=4)
def load_net(pack_id: str):
    pack = load_pack(pack_id)
    return sumolib.net.readNet(pack.net_file)


@lru_cache(maxsize=4)
def load_corridors(pack_id: str) -> dict:
    p = PACK_ROOT / pack_id / "corridors.json"
    return json.loads(p.read_text()) if p.exists() else {}


def pack_dir(pack_id: str) -> Path:
    return PACK_ROOT / pack_id


def closed_edges_during(restrictions: list[Restriction], start_s: int, end_s: int, mode: str) -> set[str]:
    """Edges closed to `mode` at any time overlapping [start_s, end_s]."""
    out: set[str] = set()
    for r in restrictions:
        if mode in r.modes and r.start_s < end_s and r.end_s > start_s:
            out.update(r.edge_ids)
    return out


def _first_hops(src, vclass: str, from_lane: int | None, max_lane_shift: int = 1):
    """Outgoing edges reachable from `from_lane` (or a lane within `max_lane_shift`).  A bus leaving a
    curb-side stop cannot cut across three lanes to make a turn; SUMO would stall and teleport it."""
    out = []
    for e2, conns in src.getOutgoing().items():
        if not e2.allows(vclass):
            continue
        if from_lane is None:
            out.append(e2)
            continue
        if any(abs(c.getFromLane().getIndex() - from_lane) <= max_lane_shift and c.getFromLane().allows(vclass) for c in conns):
            out.append(e2)
    return out


def route(net, from_edge_id: str, to_edge_id: str, vclass: str, closed: set[str], vmax: float = 15.0, from_lane: int | None = None):
    """Fastest path (seconds) avoiding closed edges.  Returns (edge_id list, seconds) or (None, inf).
    If from == to the route is a loop through the network back to the same edge."""
    src = net.getEdge(from_edge_id)
    dst = net.getEdge(to_edge_id)
    if not src.allows(vclass) or not dst.allows(vclass):
        return None, math.inf

    def cost(e) -> float:
        return e.getLength() / max(1.0, min(e.getSpeed(), vmax))

    dist: dict = {}
    pred: dict = {}
    q: list = []
    if src == dst or from_lane is not None:
        pred[src] = None
        dist[src] = 0.0
        for e2 in _first_hops(src, vclass, from_lane):
            if e2.getID() in closed:
                continue
            dist[e2] = cost(e2)
            pred[e2] = src
            heapq.heappush(q, (dist[e2], e2.getID(), e2))
        if src == dst:
            pred[src] = None
    else:
        dist[src] = 0.0
        pred[src] = None
        heapq.heappush(q, (0.0, src.getID(), src))
    seen = set()
    while q:
        c, _, e1 = heapq.heappop(q)
        if e1 in seen:
            continue
        seen.add(e1)
        if e1 == dst and (src != dst or c > 0):
            path = [e1]
            while pred[path[-1]] is not None:
                path.append(pred[path[-1]])
                if path[-1] == src:
                    break
            path.reverse()
            return [e.getID() for e in path], c + (cost(src) if src != dst else 0.0)
        for e2 in e1.getAllowedOutgoing(vclass):
            if e2.getID() in closed or e2 in seen:
                continue
            nc = c + cost(e2)
            if e2 not in dist or nc < dist[e2]:
                dist[e2] = nc
                pred[e2] = e1
                heapq.heappush(q, (nc, e2.getID(), e2))
    return None, math.inf


@lru_cache(maxsize=4)
def _walk_graph(pack_id: str) -> dict[str, list[tuple[str, float]]]:
    net = load_net(pack_id)
    adj: dict[str, list[tuple[str, float]]] = {}
    for e in net.getEdges():
        if e.isSpecial() or not e.allows("pedestrian"):
            continue
        a, b, length = e.getFromNode().getID(), e.getToNode().getID(), e.getLength()
        adj.setdefault(a, []).append((b, length))
        adj.setdefault(b, []).append((a, length))
    return adj


_walk_cache: dict[tuple[str, str], dict[str, float]] = {}


def walk_distance_m(pack_id: str, from_edge_id: str, to_edge_id: str) -> float | None:
    """Pedestrian network distance (metres) between the far node of `from` and the near node of `to`;
    sidewalks are walked in both directions."""
    net = load_net(pack_id)
    adj = _walk_graph(pack_id)
    try:
        src_edge = net.getEdge(from_edge_id)
        src = src_edge.getFromNode().getID()
        dst_edge = net.getEdge(to_edge_id)
    except KeyError:
        return None
    if not src_edge.allows("pedestrian") or not dst_edge.allows("pedestrian"):
        return None
    key = (pack_id, src)
    if key not in _walk_cache:
        dist: dict[str, float] = {src: 0.0}
        q = [(0.0, src)]
        while q:
            d, n = heapq.heappop(q)
            if d > dist.get(n, math.inf):
                continue
            for m, w in adj.get(n, []):
                nd = d + w
                if nd < dist.get(m, math.inf):
                    dist[m] = nd
                    heapq.heappush(q, (nd, m))
        _walk_cache[key] = dist
    dist = _walk_cache[key]
    cands = [dist.get(dst_edge.getFromNode().getID()), dist.get(dst_edge.getToNode().getID())]
    present = [c for c in cands if c is not None]
    return min(present) + dst_edge.getLength() / 2 if present else None
