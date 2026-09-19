"""City Evidence: frozen bundles and ad-hoc scoped search (fixture corpus; Elasticsearch when reachable)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from cityshift.api.service import get_service
from cityshift.evidence import CORPORA, ensure_indexed, search

router = APIRouter(prefix="/api/evidence", tags=["evidence"])


@router.get("/corpus/{pack_id}")
def corpus(pack_id: str) -> dict:
    docs = CORPORA.get(pack_id)
    if docs is None:
        raise HTTPException(404, f"no evidence corpus for pack {pack_id}")
    return {"pack_id": pack_id, "label": "fixture", "count": len(docs), "index": ensure_indexed(pack_id), "documents": docs}


@router.get("/search/{pack_id}")
def search_pack(pack_id: str, q: str = Query(min_length=2), size: int = Query(default=8, le=20)) -> dict:
    if pack_id not in CORPORA:
        raise HTTPException(404, f"no evidence corpus for pack {pack_id}")
    hits, record = search(pack_id, q, size)
    return {"hits": hits, "query_record": record}


@router.get("/{bid}")
def get_bundle(bid: str) -> dict:
    b = get_service().store.get_bundle(bid)
    if b is None:
        raise HTTPException(404, f"evidence bundle {bid} not found")
    return b.model_dump(mode="json")
