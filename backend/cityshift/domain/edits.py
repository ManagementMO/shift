"""Prompt -> typed InterventionProposal -> new immutable ScenarioSpec variant.

Parsing is rule-first (corridor names, stop names, zone names, numbers, mm:ss windows). The LLM is consulted
only to classify intent when the rules cannot, and its answer is coerced into the same typed proposal and
re-validated against the city pack. Nothing here ever mutates an existing scenario; `apply` returns a child
scenario with `parent_scenario_id` and a human-readable `change_set`.
"""

from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime
from functools import partial

from cityshift.contracts import (
    CityPack,
    FleetVehicle,
    HazardTrack,
    InterventionProposal,
    Restriction,
    ScenarioSpec,
)
from cityshift.domain.hazards import hazard_restriction
from cityshift.domain.network import load_corridors
from cityshift.providers import LLMClient

ProposalFactory = partial[InterventionProposal]

_TIME = re.compile(r"(\d{1,2}):(\d{2})")
_NUM = re.compile(r"\b(\d+)\b")
_WORDNUM = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6}


def _window(text: str, default: tuple[int, int]) -> tuple[int, int, bool]:
    ts = [int(m.group(1)) * 60 + int(m.group(2)) for m in _TIME.finditer(text)]
    if len(ts) >= 2:
        return ts[0], ts[1], True
    return default[0], default[1], False


def _match_corridor(text: str, corridors: dict) -> list[str]:
    """Corridors named in `text`. A full corridor label wins over street names that merely occur inside it."""
    t = text.lower()
    exact = [key for key, c in corridors.items() if c["label"].lower() in t]
    if exact:
        return exact
    found = []
    for key, c in corridors.items():
        label = c["label"].lower()
        street = label.split(",")[0].strip()
        short = street.split(" st")[0].strip()
        if street in t or short in t or key.replace("_", " ") in t:
            found.append(key)
    return found


def _match_stop(text: str, pack: CityPack) -> list[str]:
    t = text.lower()
    out = []
    for s in pack.stops:
        if s.name.lower() in t or s.stop_id in text:
            out.append(s.stop_id)
    return out


def _match_place(text: str, pack: CityPack, corridors: dict) -> list[tuple[str, tuple[float, float]]]:
    """Named places usable as storm waypoints: venue, zones, corridor midpoints."""
    t = text.lower()
    pts: list[tuple[str, tuple[float, float]]] = []
    if "venue" in t or "park" in t:
        pts.append(("venue", pack.venue_lonlat))
    for z in pack.zones:
        names = {z.name.lower(), z.zone_id.lower()} | {w for w in z.name.lower().replace("/", " ").split() if len(w) > 3}
        if any(n in t for n in names):
            pts.append((z.zone_id, (z.lon, z.lat)))
    return pts


def _proposal_id(sid: str, text: str) -> str:
    return "ip-" + hashlib.sha1(f"{sid}|{text}|{datetime.now(UTC).isoformat()}".encode()).hexdigest()[:10]


def preview(pack: CityPack, scenario: ScenarioSpec, text: str, llm: LLMClient | None = None) -> InterventionProposal:
    corridors = load_corridors(pack.pack_id)
    t = text.lower()
    horizon = scenario.constraints.horizon_s
    pid = _proposal_id(scenario.scenario_id, text)
    base = partial(InterventionProposal, proposal_id=pid, text=text, base_scenario_id=scenario.scenario_id)
    start, end, explicit = _window(text, (0, horizon))
    warnings: list[str] = []
    if not explicit:
        warnings.append(f"no mm:ss window given; using the whole horizon 00:00–{horizon // 60:02d}:{horizon % 60:02d}")

    # ---- fleet
    if re.search(r"\b(bus|buses|fleet|vehicles?)\b", t) and re.search(r"\b(set|use|only|add|with|to)\b", t):
        m = _NUM.search(re.sub(_TIME.pattern, "", t))
        n = int(m.group(1)) if m else next((v for k, v in _WORDNUM.items() if re.search(rf"\b{k}\b", t)), None)
        if n is not None and ("close" not in t and "reopen" not in t and "storm" not in t):
            if "add" in t:
                n = len(scenario.constraints.fleet) + n
            if n > scenario.constraints.hard_max_fleet:
                warnings.append(f"raises hard_max_fleet from {scenario.constraints.hard_max_fleet} to {n}; this is a scenario constraint change")
            return base(kind="set_fleet", fleet_count=n, warnings=warnings, reason=f"fleet size -> {n} persistent buses")

    # ---- storm
    if "storm" in t or "hazard" in t or "flood" in t:
        pts = _match_place(text, pack, corridors)
        if len(pts) < 1:
            return base(kind="storm", ambiguous=True, reason="name at least one place (venue, a zone name) for the storm corridor", warnings=warnings)
        rm = re.search(r"(\d+)\s*m\b", t)
        radius = float(rm.group(1)) if rm else 250.0
        wps = [p[1] for p in pts]
        if len(wps) == 1:
            wps = [wps[0], (wps[0][0] + 0.006, wps[0][1] + 0.004)]
            warnings.append("single place named; corridor extended ~600 m north-east")
        hz = HazardTrack(track_id=f"storm-{pid[3:]}", waypoints=wps, radius_m=radius, start_s=start, end_s=end,
                         label=f"assumed storm corridor via {', '.join(p[0] for p in pts)} (user-defined, not a forecast)")
        r = hazard_restriction(pack.pack_id, hz)
        return base(kind="storm", hazard=hz, edge_ids=r.edge_ids, start_s=start, end_s=end, warnings=warnings,
                                    reason=f"modeled storm corridor closes {len(r.edge_ids)} edges within {radius:.0f} m for {start}-{end}s")

    # ---- move stop
    if "move" in t and "stop" in t:
        stops = _match_stop(text, pack)
        if len(stops) != 2:
            return base(kind="move_stop", ambiguous=True, reason=f"need exactly two known stop names (found {len(stops)})", warnings=warnings)
        return base(kind="move_stop", stop_id=stops[0], target_stop_id=stops[1], warnings=warnings,
                                    reason=f"plans serving {stops[0]} will be re-validated against {stops[1]}")

    # ---- close / reopen corridor
    if re.search(r"\b(close|closed|closure|block|shut)\b", t) or re.search(r"\b(reopen|open|lift|remove)\b", t):
        keys = _match_corridor(text, corridors)
        reopen = bool(re.search(r"\b(reopen|lift|remove)\b", t)) or (re.search(r"\bopen\b", t) and "close" not in t)
        if not keys:
            if llm is not None and llm.available():
                return _llm_classify(pack, scenario, text, corridors, llm, base, warnings)
            return base(kind="unsupported", ambiguous=True, warnings=warnings,
                                        reason="no known corridor named; known: " + ", ".join(c["label"] for c in corridors.values()))
        edges = sorted({e for k in keys for e in corridors[k]["edge_ids"]})
        if reopen:
            already = {e for r in scenario.restrictions for e in r.edge_ids}
            if not (set(edges) & already):
                warnings.append("none of these edges is currently restricted; reopening is a no-op")
            return base(kind="reopen_edge", edge_ids=edges, start_s=start, end_s=end, warnings=warnings,
                                        reason=f"reopen {', '.join(corridors[k]['label'] for k in keys)}")
        return base(kind="close_edge", edge_ids=edges, start_s=start, end_s=end, warnings=warnings,
                                    reason=f"close {', '.join(corridors[k]['label'] for k in keys)} ({len(edges)} edges)")

    if llm is not None and llm.available():
        return _llm_classify(pack, scenario, text, corridors, llm, base, warnings)
    return base(kind="unsupported", ambiguous=True, warnings=warnings,
                                reason="could not parse; try 'close <corridor> from mm:ss to mm:ss', 'reopen <corridor>', 'set fleet to N buses', 'storm corridor via <place>'")


def _llm_classify(pack: CityPack, scenario: ScenarioSpec, text: str, corridors: dict, llm: LLMClient, base: ProposalFactory, warnings: list[str]) -> InterventionProposal:
    """Bounded LLM fallback: it may only pick from the enumerated corridor keys / kinds. Output is re-validated."""
    system = "You map a city operator's edit request to a typed intervention. Only use the provided keys. If unsure, kind='unsupported'."
    user = (
        f"Request: {text!r}\nCorridor keys: {[ (k, c['label']) for k, c in corridors.items()] }\n"
        f"Horizon seconds: {scenario.constraints.horizon_s}"
    )
    hint = '{"kind": "close_edge|reopen_edge|set_fleet|unsupported", "corridor_keys": ["..."], "fleet_count": null, "start_s": 0, "end_s": 0, "reason": "..."}'
    try:
        out, res = llm.chat_json(system, user, hint)
    except Exception as exc:  # noqa: BLE001
        return base(kind="unsupported", ambiguous=True, warnings=warnings + [f"llm error: {exc}"], reason="parser and model both failed")
    warnings = warnings + [f"intent classified by {res.provider}/{res.model}; edges resolved deterministically"]
    kind = out.get("kind", "unsupported")
    keys = [k for k in out.get("corridor_keys", []) if k in corridors]
    horizon = scenario.constraints.horizon_s
    start = max(0, int(out.get("start_s") or 0))
    end = min(horizon, int(out.get("end_s") or horizon))
    if kind in ("close_edge", "reopen_edge") and keys:
        edges = sorted({e for k in keys for e in corridors[k]["edge_ids"]})
        return base(kind=kind, edge_ids=edges, start_s=start, end_s=end, warnings=warnings, reason=str(out.get("reason", "")))
    if kind == "set_fleet" and out.get("fleet_count"):
        return base(kind="set_fleet", fleet_count=int(out["fleet_count"]), warnings=warnings, reason=str(out.get("reason", "")))
    return base(kind="unsupported", ambiguous=True, warnings=warnings, reason=str(out.get("reason", "unsupported")))


def apply(pack: CityPack, scenario: ScenarioSpec, p: InterventionProposal) -> ScenarioSpec:
    if p.base_scenario_id != scenario.scenario_id:
        raise ValueError("proposal was previewed against a different scenario")
    if p.kind == "unsupported" or p.ambiguous:
        raise ValueError("proposal is ambiguous/unsupported; refine the prompt")
    restrictions = [r.model_copy(deep=True) for r in scenario.restrictions]
    hazards = [h.model_copy(deep=True) for h in scenario.hazards]
    cons = scenario.constraints.model_copy(deep=True)
    change: list[str] = []
    if p.kind == "close_edge":
        restrictions.append(Restriction(
            restriction_id=f"closure-{p.proposal_id[3:]}", edge_ids=p.edge_ids, start_s=p.start_s or 0,
            end_s=p.end_s or cons.horizon_s, label=p.reason + " (operator edit, not a live advisory)",
        ))
        change.append(f"close {len(p.edge_ids)} edges {p.start_s}-{p.end_s}s: {p.reason}")
    elif p.kind == "reopen_edge":
        drop = set(p.edge_ids)
        kept = []
        for r in restrictions:
            remaining = [e for e in r.edge_ids if e not in drop]
            if remaining:
                kept.append(r.model_copy(update={"edge_ids": remaining}))
            else:
                change.append(f"removed restriction {r.restriction_id}")
        restrictions = kept
        change.append(f"reopen {len(drop)} edges: {p.reason}")
    elif p.kind == "set_fleet":
        n = p.fleet_count or 0
        depot = cons.fleet[0].depot_edge if cons.fleet else pack.venue_edge_id
        cap = cons.fleet[0].capacity if cons.fleet else 60
        cons.fleet = [FleetVehicle(vehicle_id=f"bus_{chr(65 + i)}", capacity=cap, depot_edge=depot) for i in range(n)]
        cons.hard_max_fleet = n
        change.append(f"fleet -> {n} buses ({', '.join(v.vehicle_id for v in cons.fleet)})")
    elif p.kind == "move_stop":
        if p.stop_id in cons.allowed_stop_ids and p.stop_id:
            cons.allowed_stop_ids = [s for s in cons.allowed_stop_ids if s != p.stop_id]
        change.append(f"stop {p.stop_id} withdrawn from allowed stops; use {p.target_stop_id}")
    elif p.kind == "storm" and p.hazard:
        hazards.append(p.hazard)
        restrictions.append(hazard_restriction(pack.pack_id, p.hazard))
        change.append(f"storm corridor {p.hazard.track_id}: {len(p.edge_ids)} edges {p.start_s}-{p.end_s}s")
    child_id = f"{scenario.scenario_id.split('-v')[0]}-v{hashlib.sha1(('|'.join(change) + scenario.scenario_id).encode()).hexdigest()[:6]}"
    return scenario.model_copy(deep=True, update={
        "scenario_id": child_id,
        "restrictions": restrictions,
        "hazards": hazards,
        "constraints": cons,
        "parent_scenario_id": scenario.scenario_id,
        "change_set": scenario.change_set + change,
        "label": f"{scenario.label} · edit: {p.reason}",
        "created_at": datetime.now(UTC),
    })
