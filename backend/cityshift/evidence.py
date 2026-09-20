"""City Evidence: a small labeled notice corpus, scoped retrieval, frozen EvidenceBundles.

Retrieval goes through Elasticsearch when a server is reachable (local or Elastic Cloud); otherwise a plain
token-overlap search over the same corpus is used and the bundle says so in `query_records[*].provider`.
Documents are fixtures written for this scenario lab; they are labeled `fixture`, never presented as live
advisories. Claims carry the corridor edge ids resolved from the city pack's corridors.json.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime
from typing import Literal

from cityshift.contracts import EvidenceBundle, EvidenceClaim
from cityshift.domain.network import load_corridors
from cityshift.providers import ELASTIC_URL, elastic_client, elastic_provider_name

ClaimType = Literal["closure", "restriction", "stop_change", "cancellation", "event", "note"]
CLAIM_TYPES: frozenset[str] = frozenset({"closure", "restriction", "stop_change", "cancellation", "event", "note"})
CORPUS_SNAPSHOT = "fixture-corpus-2026-09-19"
INDEX_PREFIX = "cityshift-evidence"

# Each document: id, title, body, published, kind, corridor (key into corridors.json or None), claim fields.
CORPUS_WATERLOO: list[dict] = [
    {
        "source_id": "notice-king-uptown-full-closure",
        "title": "King Street South full closure — William St to Erb St (event period)",
        "body": (
            "King Street South will be closed to all vehicle traffic in both directions between William Street and "
            "Erb Street for the duration of the Waterloo Park concert egress period. Transit vehicles are included "
            "in the closure. Pedestrian access is maintained on both sidewalks."
        ),
        "published": "2026-09-17T09:00:00Z",
        "kind": "closure",
        "corridor": "king_uptown",
        "direction": "both",
        "effective_start_s": 0,
        "effective_end_s": 2700,
        "status": "confirmed",
        "supersedes": "notice-king-uptown-partial-closure",
        "label": "fixture",
    },
    {
        "source_id": "notice-king-uptown-partial-closure",
        "title": "King Street South — southbound lane closure William to Erb (earlier notice)",
        "body": (
            "Earlier notice: the southbound curb lane of King Street South between William Street and Erb Street "
            "will be closed. Northbound traffic and buses are unaffected."
        ),
        "published": "2026-09-15T14:00:00Z",
        "kind": "restriction",
        "corridor": "king_uptown",
        "direction": "forward",
        "effective_start_s": 0,
        "effective_end_s": 2700,
        "status": "superseded",
        "supersedes": None,
        "label": "fixture",
    },
    {
        "source_id": "notice-erb-west-lane-reduction",
        "title": "Erb Street West — lane reduction Caroline St to King St",
        "body": (
            "Erb Street West is reduced to one lane in each direction between Caroline Street and King Street for "
            "utility work. Expect delays. Buses may be delayed; no detour is in effect."
        ),
        "published": "2026-09-16T08:00:00Z",
        "kind": "note",
        "corridor": "erb_uptown",
        "direction": "both",
        "effective_start_s": None,
        "effective_end_s": None,
        "status": "pending",
        "supersedes": None,
        "label": "fixture",
    },
    {
        "source_id": "event-waterloo-park-concert",
        "title": "Waterloo Park concert — scheduled end 22:30",
        "body": (
            "The Waterloo Park bandshell concert is scheduled to end at 22:30. Organizers expect attendees to "
            "leave over roughly 35 minutes. Attendance is not published; the scenario cohort is synthetic."
        ),
        "published": "2026-09-10T12:00:00Z",
        "kind": "event",
        "corridor": None,
        "direction": "n/a",
        "effective_start_s": 0,
        "effective_end_s": 2100,
        "status": "confirmed",
        "supersedes": None,
        "label": "fixture",
    },
    {
        "source_id": "notice-columbia-resurfacing",
        "title": "Columbia Street West resurfacing — Hazel St to King St (next month)",
        "body": (
            "Columbia Street West will be resurfaced between Hazel Street and King Street starting next month. "
            "Not in effect during the concert period."
        ),
        "published": "2026-09-12T10:00:00Z",
        "kind": "note",
        "corridor": "columbia_king",
        "direction": "both",
        "effective_start_s": None,
        "effective_end_s": None,
        "status": "pending",
        "supersedes": None,
        "label": "fixture",
    },
    {
        "source_id": "note-grt-route7-detour",
        "title": "GRT Route 7 detour around Uptown during the closure",
        "body": (
            "Route 7 buses will detour around the King Street closure via Caroline Street. Stops on King between "
            "William and Erb are not served. No scheduled GRT or ION service is simulated in this lab."
        ),
        "published": "2026-09-17T11:00:00Z",
        "kind": "note",
        "corridor": None,
        "direction": "n/a",
        "effective_start_s": 0,
        "effective_end_s": 2700,
        "status": "confirmed",
        "supersedes": None,
        "label": "fixture",
    },
]

CORPUS_TORONTO: list[dict] = [
    {
        "source_id": "notice-front-west-full-closure",
        "title": "Front Street West full closure — Blue Jays Way to York St (event egress period)",
        "body": (
            "Front Street West will be closed to all vehicle traffic in both directions between Blue Jays Way and "
            "York Street for the duration of the Rogers Centre event egress period. Transit vehicles are included "
            "in the closure. Pedestrian access is maintained on both sidewalks and the SkyWalk."
        ),
        "published": "2026-09-17T09:00:00Z",
        "kind": "closure",
        "corridor": "front_west",
        "direction": "both",
        "effective_start_s": 0,
        "effective_end_s": 2700,
        "status": "confirmed",
        "supersedes": "notice-front-west-partial-closure",
        "label": "fixture",
    },
    {
        "source_id": "notice-front-west-partial-closure",
        "title": "Front Street West — eastbound lane closure Blue Jays Way to York (earlier notice)",
        "body": (
            "Earlier notice: the eastbound curb lane of Front Street West between Blue Jays Way and York Street "
            "will be closed. Westbound traffic and buses are unaffected."
        ),
        "published": "2026-09-15T14:00:00Z",
        "kind": "restriction",
        "corridor": "front_west",
        "direction": "forward",
        "effective_start_s": 0,
        "effective_end_s": 2700,
        "status": "superseded",
        "supersedes": None,
        "label": "fixture",
    },
    {
        "source_id": "notice-bremner-lane-reduction",
        "title": "Bremner Boulevard — lane reduction near Rogers Centre for event servicing",
        "body": (
            "Bremner Boulevard is reduced to one lane per direction between Spadina Avenue and York Street while "
            "event servicing vehicles are staged. Buses are permitted."
        ),
        "published": "2026-09-16T08:00:00Z",
        "kind": "restriction",
        "corridor": "bremner",
        "direction": "both",
        "effective_start_s": 0,
        "effective_end_s": 2700,
        "status": "confirmed",
        "supersedes": None,
        "label": "fixture",
    },
    {
        "source_id": "event-rogers-centre",
        "title": "Rogers Centre event — scheduled end 22:30",
        "body": (
            "The Rogers Centre event is scheduled to end at 22:30. Organizers expect attendees to leave over "
            "roughly 35 minutes toward Union Station, the Financial District, Harbourfront and Liberty Village. "
            "Attendance is not published; the scenario cohort is synthetic."
        ),
        "published": "2026-09-10T12:00:00Z",
        "kind": "event",
        "corridor": None,
        "direction": "n/a",
        "effective_start_s": 0,
        "effective_end_s": 2100,
        "status": "confirmed",
        "supersedes": None,
        "label": "fixture",
    },
    {
        "source_id": "notice-lakeshore-resurfacing",
        "title": "Lake Shore Boulevard West resurfacing — Bathurst to York (next month)",
        "body": (
            "Lake Shore Boulevard West will be resurfaced between Bathurst Street and York Street starting next "
            "month. Not in effect during the event period."
        ),
        "published": "2026-09-12T10:00:00Z",
        "kind": "note",
        "corridor": "lakeshore_west",
        "direction": "both",
        "effective_start_s": None,
        "effective_end_s": None,
        "status": "pending",
        "supersedes": None,
        "label": "fixture",
    },
    {
        "source_id": "note-ttc-504-detour",
        "title": "TTC 504 King detour around the Front Street closure",
        "body": (
            "504 King replacement buses will detour around the Front Street closure via Wellington Street. "
            "Stops on Front between Blue Jays Way and York are not served. No scheduled TTC or GO service is "
            "simulated in this lab."
        ),
        "published": "2026-09-17T11:00:00Z",
        "kind": "note",
        "corridor": None,
        "direction": "n/a",
        "effective_start_s": 0,
        "effective_end_s": 2700,
        "status": "confirmed",
        "supersedes": None,
        "label": "fixture",
    },
]

CORPORA: dict[str, list[dict]] = {"waterloo": CORPUS_WATERLOO, "toronto": CORPUS_TORONTO}

_STOP = {"the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "is", "are", "at", "with", "no", "by", "from"}


def index_name(pack_id: str) -> str:
    return f"{INDEX_PREFIX}-{pack_id}"


def _tokens(text: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9]+", text.lower()) if t not in _STOP and len(t) > 1]


def ensure_indexed(pack_id: str) -> dict:
    """Index the fixture corpus into Elasticsearch if reachable. Returns a status dict; never fakes success."""
    es = elastic_client()
    docs = CORPORA.get(pack_id, [])
    if es is None:
        return {"indexed": False, "provider": None, "reason": f"Elasticsearch not reachable at {ELASTIC_URL}"}
    idx = index_name(pack_id)
    try:
        if not es.indices.exists(index=idx):
            es.indices.create(index=idx, mappings={"properties": {
                "title": {"type": "text"}, "body": {"type": "text"}, "kind": {"type": "keyword"},
                "corridor": {"type": "keyword"}, "status": {"type": "keyword"}, "published": {"type": "date"},
            }})
        for d in docs:
            es.index(index=idx, id=d["source_id"], document=d)
        es.indices.refresh(index=idx)
        return {"indexed": True, "provider": elastic_provider_name(), "count": len(docs), "index": idx}
    except Exception as exc:  # noqa: BLE001
        return {"indexed": False, "provider": elastic_provider_name(), "reason": str(exc)[:200]}


def search(pack_id: str, query: str, size: int = 8, use_elasticsearch: bool = True) -> tuple[list[dict], dict]:
    """Scoped retrieval: only this pack's index/corpus. Returns (hits, query_record)."""
    docs = CORPORA.get(pack_id, [])
    es = elastic_client() if use_elasticsearch else None
    record: dict = {"pack_id": pack_id, "query": query, "size": size, "at": datetime.now(UTC).isoformat()}
    if es is not None:
        status = ensure_indexed(pack_id)
        if status.get("indexed"):
            body = {"query": {"multi_match": {"query": query, "fields": ["title^2", "body"], "fuzziness": "AUTO"}}}
            try:
                res = es.search(index=index_name(pack_id), size=size, **body)
                hits = [dict(h["_source"], _score=h["_score"]) for h in res["hits"]["hits"]]
                record.update(provider=status["provider"], engine="elasticsearch", es_query=body, hit_count=len(hits))
                return hits, record
            except Exception as exc:  # noqa: BLE001
                record["es_error"] = str(exc)[:200]
    # Fallback: token overlap over the same fixture corpus. Explicitly labeled.
    q = set(_tokens(query))
    scored = []
    for d in docs:
        toks = _tokens(d["title"] + " " + d["body"])
        overlap = sum(1 for t in toks if t in q)
        if overlap:
            scored.append((overlap / (len(toks) ** 0.5), d))
    scored.sort(key=lambda x: -x[0])
    hits = [dict(d, _score=round(s, 4)) for s, d in scored[:size]]
    reason = "unavailable" if use_elasticsearch else "disabled"
    record.update(provider=f"local-corpus (Elasticsearch {reason})", engine="token-overlap", hit_count=len(hits))
    return hits, record


def build_bundle(pack_id: str, queries: list[str], use_elasticsearch: bool = True) -> EvidenceBundle:
    corridors = load_corridors(pack_id)
    seen: dict[str, dict] = {}
    records: list[dict] = []
    for q in queries:
        hits, rec = search(pack_id, q, use_elasticsearch=use_elasticsearch)
        records.append(rec)
        for h in hits:
            seen.setdefault(h["source_id"], h)
    claims: list[EvidenceClaim] = []
    unresolved: list[str] = []
    for sid, d in seen.items():
        edge_ids = corridors.get(d["corridor"], {}).get("edge_ids", []) if d.get("corridor") else []
        claim_type: ClaimType = d["kind"] if d["kind"] in CLAIM_TYPES else "note"
        if d["kind"] in {"closure", "restriction"} and not edge_ids:
            unresolved.append(f"{sid}: no corridor mapping; edges unresolved")
        if d.get("effective_start_s") is None and d["kind"] != "note":
            unresolved.append(f"{sid}: effective window not stated")
        claims.append(EvidenceClaim(
            claim_id=f"claim-{sid}",
            source_id=sid,
            claim_type=claim_type,
            text_span=d["body"],
            edge_ids=edge_ids,
            direction=d.get("direction", "both"),
            effective_start_s=d.get("effective_start_s"),
            effective_end_s=d.get("effective_end_s"),
            status=d.get("status", "pending"),
            supersedes=d.get("supersedes"),
            location_candidates=[d["corridor"]] if d.get("corridor") else [],
        ))
    retrieval = [{k: v for k, v in record.items() if k != "at"} for record in records]
    identity = json.dumps({"pack": pack_id, "sources": sorted(seen), "queries": retrieval}, sort_keys=True)
    bundle_id = "eb-" + hashlib.sha1(identity.encode()).hexdigest()[:12]
    bundle = EvidenceBundle(
        bundle_id=bundle_id,
        corpus_snapshot=CORPUS_SNAPSHOT,
        query_records=records,
        source_ids=sorted(seen),
        claims=claims,
        assumptions=[
            "All documents are scenario fixtures labeled 'fixture'; none is a live municipal advisory.",
            "Corridor edge ids come from the city pack's corridors.json (OpenStreetMap geometry via netconvert).",
            "Effective windows are expressed in scenario seconds from t=0 (concert end).",
        ],
        unresolved=unresolved,
    )
    return bundle.freeze()
