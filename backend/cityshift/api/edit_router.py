"""Prompt-to-edit: preview a typed proposal, then apply it as a new immutable scenario variant."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from cityshift.api.service import get_service
from cityshift.contracts import DevelopmentPreview, DevelopmentSpec, InterventionProposal

router = APIRouter(prefix="/api/scenarios", tags=["edit"])


class EditPrompt(BaseModel):
    prompt: str
    use_ai: bool = True


@router.post("/{sid}/edit/preview")
def preview_edit(sid: str, req: EditPrompt) -> dict:
    try:
        return get_service().preview_edit(sid, req.prompt, req.use_ai).model_dump(mode="json")
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


@router.post("/{sid}/developments/preview")
def preview_development(sid: str, spec: DevelopmentSpec) -> DevelopmentPreview:
    try:
        return get_service().preview_development(sid, spec)
    except KeyError:
        raise HTTPException(404, f"scenario {sid} not found") from None
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@router.post("/{sid}/developments/apply")
def apply_development(sid: str, proposal: DevelopmentPreview) -> dict:
    try:
        return get_service().apply_development(sid, proposal).model_dump(mode="json")
    except KeyError:
        raise HTTPException(404, f"scenario {sid} not found") from None
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@router.delete("/{sid}/developments/{development_id}")
def remove_development(sid: str, development_id: str) -> dict:
    """In-place: drops the development and exactly its trips from this scenario; runs of the old content go stale."""
    try:
        return get_service().remove_development(sid, development_id).model_dump(mode="json")
    except KeyError as exc:
        raise HTTPException(404, f"{exc.args[0]} not found") from None
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


class DemolitionRequest(BaseModel):
    building_id: str


@router.post("/{sid}/demolitions")
def demolish_building(sid: str, req: DemolitionRequest) -> dict:
    """In-place, visual only: hides a base-city building in this scenario. Base buildings generate no trips."""
    try:
        return get_service().demolish_building(sid, req.building_id).model_dump(mode="json")
    except KeyError:
        raise HTTPException(404, f"scenario {sid} not found") from None
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
