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
    HazardDraft,
    HazardKind,
    InterventionProposal,
    Restriction,
    ScenarioSpec,
    content_hash,
    utcnow,
)
from cityshift.domain.hazards import resolve_hazard, validate_scenario_restrictions
from cityshift.domain.network import load_corridors
from cityshift.providers import LLMClient

ProposalFactory = partial[InterventionProposal]

_TIME = re.compile(r"([+-]?\d+):(\d+)")
_NUM = re.compile(r"\b(\d+)\b")
_WORDNUM = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6}


def _window(text: str, default: tuple[int, int]) -> tuple[int, int, bool]:
    matches = list(_TIME.finditer(text))
    if matches and (len(matches) != 2 or any(m.group(1).startswith("-") or len(m.group(2)) != 2 or int(m.group(2)) >= 60 for m in matches)):
        raise ValueError("provide exactly two valid mm:ss times for the window")
    ts = [int(m.group(1)) * 60 + int(m.group(2)) for m in matches]
    if ts:
        if not (0 <= ts[0] < ts[1] <= default[1]):
            raise ValueError("window must satisfy 0 <= start < end <= scenario horizon")
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


def preview_hazard(pack: CityPack, scenario: ScenarioSpec, draft: HazardDraft, text: str = "") -> InterventionProposal:
    if pack.pack_id != scenario.pack_id:
        raise ValueError("scenario and city pack do not match")
    draft = HazardDraft.model_validate(draft.model_dump(include=set(HazardDraft.model_fields)))
    key = content_hash({"base": scenario.scenario_id, "network": pack.network_fingerprint, "hazard": draft.model_dump()})
    hazard, restriction = resolve_hazard(pack, draft, f"zone-{key}", scenario.constraints.horizon_s)
    warnings = [
        "Static exclusion: the entire highlighted edge set is restricted for the full window [start, end).",
        "Passenger cars and/or buses only; pedestrians are not restricted or protected. No evacuation demand is generated.",
        "Declared assumptions, not a weather, fire-spread, or casualty forecast; the rain/fire/storm visual is illustrative.",
    ]
    west, south, east, north = pack.bbox
    if any(not (west <= lon <= east and south <= lat <= north) for ring in hazard.footprint for lon, lat in ring):
        warnings.append("Buffer extends beyond the city pack; only roads in this pack are evaluated.")
    overlap = {eid for r in scenario.restrictions if r.start_s < hazard.end_s and r.end_s > hazard.start_s
               and set(r.modes) & set(hazard.modes) for eid in r.edge_ids} & set(restriction.edge_ids)
    if overlap:
        warnings.append(f"{len(overlap)} affected edges also have overlapping restrictions; each restriction keeps its own ownership.")
    if not restriction.edge_ids:
        warnings.append("No supported vehicle edges intersect this footprint: the event is visual only and restricts nothing.")
    return InterventionProposal(
        proposal_id=f"ip-{key}", kind="storm", text=text or draft.label, base_scenario_id=scenario.scenario_id,
        hazard=hazard, edge_ids=restriction.edge_ids, start_s=hazard.start_s, end_s=hazard.end_s,
        network_fingerprint=pack.network_fingerprint, warnings=warnings,
        reason=(f"Visual-only {hazard.kind}: no roads inside the footprint, so routes are unchanged." if not restriction.edge_ids else
                f"Static hazard zone closes {len(restriction.edge_ids)} edges for {', '.join(hazard.modes)} during {hazard.start_s}–{hazard.end_s}s."),
    )


def preview_hazard_removal(pack: CityPack, scenario: ScenarioSpec, track_id: str) -> InterventionProposal:
    validate_scenario_restrictions(pack, scenario)
    hazard = next((h for h in scenario.hazards if h.track_id == track_id), None)
    if hazard is None:
        raise ValueError("hazard does not exist in this scenario")
    owner = f"hazard:{track_id}"
    owned_edges = [eid for r in scenario.restrictions if r.source_claim_id == owner for eid in r.edge_ids]
    remaining = {eid for r in scenario.restrictions if r.source_claim_id != owner
                 and r.start_s < hazard.end_s and r.end_s > hazard.start_s and set(r.modes) & set(hazard.modes)
                 for eid in r.edge_ids} & set(owned_edges)
    return InterventionProposal(
        proposal_id=f"ip-{content_hash({'base': scenario.scenario_id, 'remove': track_id})}", kind="remove_hazard",
        text=f"remove hazard {track_id}", base_scenario_id=scenario.scenario_id, hazard=hazard.model_copy(deep=True),
        edge_ids=owned_edges, start_s=hazard.start_s, end_s=hazard.end_s,
        network_fingerprint=pack.network_fingerprint, reason=f"Remove hazard zone {track_id} from a new child scenario.",
        warnings=(["This event restricts no roads; removing it only changes the visual."] if not owned_edges else
                  ["Only this hazard and its owned restriction are removed; all independent restrictions stay in place.",
                   f"{len(remaining)} affected edges retain overlapping restrictions for at least part of this window."]),
    )


def _without_hazard(scenario: ScenarioSpec, track_id: str) -> ScenarioSpec:
    if not any(h.track_id == track_id for h in scenario.hazards):
        raise ValueError("hazard does not exist in this scenario")
    return scenario.model_copy(deep=True, update={
        "hazards": [h for h in scenario.hazards if h.track_id != track_id],
        "restrictions": [r for r in scenario.restrictions if r.source_claim_id != f"hazard:{track_id}"],
    })


def preview_hazard_replacement(pack: CityPack, scenario: ScenarioSpec, track_id: str, draft: HazardDraft) -> InterventionProposal:
    """Move/resize an existing hazard: one edit removes it and adds the new footprint, so a drag is one branch."""
    validate_scenario_restrictions(pack, scenario)
    proposal = preview_hazard(pack, _without_hazard(scenario, track_id), draft)
    proposal.kind = "replace_hazard"
    proposal.replaces_track_id = track_id
    proposal.text = f"move weather event {track_id}"
    proposal.reason = (f"Move weather event: no roads inside the new footprint (visual only); {track_id} is removed." if not proposal.edge_ids
                       else f"Move weather event: {len(proposal.edge_ids)} edges restricted at the new footprint; {track_id} is removed.")
    proposal.warnings = ["The previous footprint and its owned restriction are removed in the same edit."] + proposal.warnings
    return proposal


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
        if n is not None and not any(word in t for word in ("close", "reopen", "storm", "hazard", "fire", "rain", "weather")):
            if "add" in t:
                n = len(scenario.constraints.fleet) + n
            if n > scenario.constraints.hard_max_fleet:
                warnings.append(f"raises hard_max_fleet from {scenario.constraints.hard_max_fleet} to {n}; this is a scenario constraint change")
            return base(kind="set_fleet", fleet_count=n, warnings=warnings, reason=f"fleet size -> {n} persistent buses")

    # ---- weather event (rain / fire / storm)
    if re.search(r"\b(storm|hazard|fire|rain|weather)\b", t):
        if re.search(r"\b(remove|lift|clear)\b", t):
            matches = [h for h in scenario.hazards if h.track_id in text]
            if len(matches) != 1:
                return base(kind="remove_hazard", ambiguous=True, reason="select exactly one existing hazard id to remove", warnings=warnings)
            return preview_hazard_removal(pack, scenario, matches[0].track_id)
        pts = _match_place(text, pack, corridors)
        if not pts:
            return base(kind="storm", ambiguous=True, reason="name a place or use the hazard tool for explicit coordinates", warnings=warnings)
        rm = re.search(r"([^\s]+)\s*m\b", t)
        radius = float(rm.group(1)) if rm else 250.0
        if rm is None:
            warnings.append("no radius given; assuming 250 m")
        kind: HazardKind = "fire" if re.search(r"\bfire\b", t) else "rain" if re.search(r"\brain\b", t) else "storm"
        draft = HazardDraft(waypoints=[p[1] for p in pts], radius_m=radius, start_s=start, end_s=end, kind=kind,
                            label=f"{kind.capitalize()} via {', '.join(p[0] for p in pts)} (user-defined, not a forecast)")
        proposal = preview_hazard(pack, scenario, draft, text)
        proposal.warnings = warnings + proposal.warnings
        return proposal

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
            protected = {e for r in scenario.restrictions if (r.source_claim_id or "").startswith("hazard:") for e in r.edge_ids}
            already = {e for r in scenario.restrictions if not (r.source_claim_id or "").startswith("hazard:") for e in r.edge_ids}
            if set(edges) & protected:
                warnings.append("hazard-owned restrictions are preserved; remove the hazard explicitly to lift its exclusion")
            if not (set(edges) & already):
                warnings.append("none of these edges has a non-hazard restriction; reopening is a no-op")
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
    validate_scenario_restrictions(pack, scenario)
    hazard = None
    hazard_closure = None
    if p.kind in ("storm", "remove_hazard", "replace_hazard"):
        if p.hazard is None:
            raise ValueError("hazard geometry is required; preview the hazard again")
        if p.network_fingerprint != pack.network_fingerprint:
            raise ValueError("network changed since preview; preview the hazard again")
        hazard, hazard_closure = resolve_hazard(pack, p.hazard, p.hazard.track_id, scenario.constraints.horizon_s)
        if (p.hazard != hazard or p.edge_ids != hazard_closure.edge_ids
                or (p.start_s, p.end_s) != (hazard.start_s, hazard.end_s)):
            raise ValueError("hazard footprint, edges, or timing differ from the preview")
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
            if (r.source_claim_id or "").startswith("hazard:"):
                kept.append(r)
                continue
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
    elif p.kind == "storm" and hazard is not None and hazard_closure is not None:
        if any(h.track_id == hazard.track_id for h in hazards):
            raise ValueError("hazard already exists in this scenario")
        hazards.append(hazard)
        # Only footprints that touch supported roads own a restriction; SUMO never sees an empty closure.
        if hazard_closure.edge_ids:
            restrictions.append(hazard_closure)
        change.append(f"static hazard zone {hazard.track_id}: {len(p.edge_ids)} edges {hazard.start_s}-{hazard.end_s}s"
                      + ("" if p.edge_ids else " (visual only)"))
    elif p.kind == "remove_hazard" and hazard is not None:
        if hazard not in hazards:
            raise ValueError("hazard removal does not match an existing hazard; preview again")
        hazards = [h for h in hazards if h.track_id != hazard.track_id]
        restrictions = [r for r in restrictions if r.source_claim_id != f"hazard:{hazard.track_id}"]
        change.append(f"removed hazard zone {hazard.track_id}" + (" and its owned restriction" if p.edge_ids else " (visual only)"))
    elif p.kind == "replace_hazard" and hazard is not None and hazard_closure is not None:
        old = p.replaces_track_id
        if not old or not any(h.track_id == old for h in hazards):
            raise ValueError("the hazard being moved no longer exists in this scenario; preview again")
        hazards = [h for h in hazards if h.track_id != old]
        restrictions = [r for r in restrictions if r.source_claim_id != f"hazard:{old}"]
        if any(h.track_id == hazard.track_id for h in hazards):
            raise ValueError("hazard already exists in this scenario")
        hazards.append(hazard)
        if hazard_closure.edge_ids:
            restrictions.append(hazard_closure)
        change.append(f"moved weather event {old} -> {hazard.track_id}: {len(p.edge_ids)} edges {hazard.start_s}-{hazard.end_s}s"
                      + ("" if p.edge_ids else " (visual only)"))
    key = content_hash({
        "parent": scenario.scenario_id, "network": pack.network_fingerprint,
        "restrictions": [r.model_dump() for r in restrictions], "hazards": [h.model_dump() for h in hazards],
        "constraints": cons.model_dump(),
    })
    child = scenario.model_copy(deep=True, update={
        "scenario_id": f"{scenario.scenario_id.split('-v')[0]}-v{key[:12]}",
        "restrictions": restrictions, "hazards": hazards, "constraints": cons,
        "parent_scenario_id": scenario.scenario_id, "change_set": scenario.change_set + change,
        "label": f"{scenario.label} · edit: {p.reason}", "created_at": utcnow(),
    })
    validate_scenario_restrictions(pack, child)
    return child
