"""OpenAI-compatible chat surface backed by the configured provider.

Exists so agent frameworks that only speak `/v1/chat/completions` (openJiuwen's OpenAI client) can use providers
that do not, currently Backboard. Non-streaming only; tool calls round-trip through BackboardChat's thread map.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from cityshift.providers import LLM_MODEL, LLM_PROVIDER, BackboardChat, BackboardError

log = logging.getLogger(__name__)
router = APIRouter(prefix="/llm/v1", tags=["llm-shim"])


@router.get("/models")
def models() -> dict:
    return {"object": "list", "data": [{"id": LLM_MODEL, "object": "model", "owned_by": LLM_PROVIDER}]}


@router.post("/chat/completions")
def chat_completions(body: dict) -> JSONResponse:
    if LLM_PROVIDER != "backboard":
        raise HTTPException(status_code=503, detail=f"llm shim only serves the backboard provider (configured: {LLM_PROVIDER})")
    if body.get("stream"):
        raise HTTPException(status_code=400, detail="streaming is not supported by the llm shim")
    messages = body.get("messages") or []
    if not messages:
        raise HTTPException(status_code=400, detail="messages required")
    json_mode = (body.get("response_format") or {}).get("type") == "json_object"
    try:
        out = BackboardChat().complete(messages, str(body.get("model") or LLM_MODEL), tools=body.get("tools"), json_mode=json_mode)
    except BackboardError as exc:
        log.warning("backboard refused: %s", exc)
        return JSONResponse(status_code=402, content={"error": {"message": str(exc), "type": "provider_error"}})
    return JSONResponse(out)
