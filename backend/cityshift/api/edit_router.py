"""Prompt-to-edit: preview a typed proposal, then apply it as a new immutable scenario variant."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from cityshift.api.service import get_service
from cityshift.contracts import InterventionProposal

router = APIRouter(prefix="/api/scenarios", tags=["edit"])


class EditPrompt(BaseModel):
    prompt: str


@router.post("/{sid}/edit/preview")
def preview_edit(sid: str, req: EditPrompt) -> dict:
    try:
        return get_service().preview_edit(sid, req.prompt).model_dump(mode="json")
    except KeyError:
        raise HTTPException(404, f"scenario {sid} not found")


@router.post("/{sid}/edit/apply")
def apply_edit(sid: str, proposal: InterventionProposal) -> dict:
    svc = get_service()
    try:
        child = svc.apply_edit(sid, proposal)
    except KeyError:
        raise HTTPException(404, f"scenario {sid} not found")
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    return child.model_dump(mode="json")
