from __future__ import annotations

from collections.abc import Callable
from functools import partial

import sumolib
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from cityshift.live.contracts import AdvanceRequest, InterventionRequest, SessionConfig
from cityshift.live.preview import preview
from cityshift.live.sessions import LiveRegistry

router = APIRouter(prefix="/api/live", tags=["live-city"])
_registry: LiveRegistry | None = None


def get_registry() -> LiveRegistry:
    global _registry
    if _registry is None:
        _registry = LiveRegistry()
    return _registry


def close_registry() -> None:
    global _registry
    if _registry is not None:
        _registry.close()
        _registry = None


def handle[T](call: Callable[[], T]) -> T:
    try:
        return call()
    except (KeyError, FileNotFoundError) as exc:
        raise HTTPException(404, str(exc)) from None
    except ValueError as exc:
        raise HTTPException(409 if "revision" in str(exc) or "command id" in str(exc) else 422, str(exc)) from None
    except TimeoutError as exc:
        raise HTTPException(503, str(exc)) from None
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from None


@router.get("")
def list_sessions() -> list[dict]:
    registry = get_registry()
    ids = set(registry.sessions) | {p.parent.name for p in registry.root.glob("live-*/session.json")}
    result = []
    for sid in sorted(ids):
        session = handle(partial(registry.get, sid))
        result.append(session.snapshot())
    return result


@router.post("", status_code=201)
def create_session(config: SessionConfig) -> dict:
    return handle(lambda: get_registry().create(config).snapshot())


@router.get("/{session_id}")
def get_session(session_id: str) -> dict:
    return handle(lambda: get_registry().get(session_id).snapshot())


@router.post("/{session_id}/advance")
def advance(session_id: str, request: AdvanceRequest) -> dict:
    return handle(lambda: get_registry().get(session_id).advance(request.target_s))


@router.post("/{session_id}/pause")
def pause(session_id: str) -> dict:
    return handle(lambda: get_registry().get(session_id).pause())


@router.post("/{session_id}/resume")
def resume(session_id: str) -> dict:
    return handle(lambda: get_registry().resume(session_id).snapshot())


@router.post("/{session_id}/close")
def close(session_id: str) -> dict:
    def action():
        session = get_registry().get(session_id)
        session.close()
        return session.snapshot()
    return handle(action)


@router.get("/{session_id}/metadata")
def metadata(session_id: str) -> dict:
    return handle(lambda: get_registry().get(session_id).metadata())


@router.get("/{session_id}/frames/{start_s}")
def frames(session_id: str, start_s: int) -> Response:
    session = handle(lambda: get_registry().get(session_id))
    data = handle(lambda: session.recording.read_chunk(start_s))
    sealed = start_s + 10 <= session.recording.latest_s
    return Response(data, media_type="application/octet-stream", headers={"Cache-Control": "private, max-age=86400, immutable" if sealed else "no-store"})


@router.post("/{session_id}/preview")
def preview_change(session_id: str, request: InterventionRequest) -> dict:
    def action():
        session = get_registry().get(session_id)
        net = session._engine.net if session._engine is not None else sumolib.net.readNet(session.pack.net_file)
        return preview(session.pack, session.config, session.snapshot(), request, net)
    return handle(action)


@router.post("/{session_id}/commands")
def apply_change(session_id: str, request: InterventionRequest) -> dict:
    return handle(lambda: get_registry().apply(session_id, request).snapshot())
