"""Agent investigations: submit a problem + constraint, poll decisions and proposed (validated) plan ids."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from cityshift.api.service import get_service
from cityshift.contracts import InvestigationOptions

router = APIRouter(prefix="/api", tags=["agents"])


class InvestigateRequest(BaseModel):
    problem: str = Field(min_length=3, max_length=2000)
    constraint: str = Field(default="", max_length=2000)
    options: InvestigationOptions = Field(default_factory=InvestigationOptions)


@router.post("/scenarios/{sid}/investigate")
def investigate(sid: str, req: InvestigateRequest) -> dict:
    try:
        return get_service().investigate(sid, req.problem, req.constraint, req.options).model_dump(mode="json")
    except KeyError:
        raise HTTPException(404, f"scenario {sid} not found")


@router.get("/investigations")
def list_investigations(scenario_id: str | None = Query(default=None)) -> list[dict]:
    return [i.model_dump(mode="json") for i in get_service().store.list_investigations(scenario_id)]


@router.get("/investigations/{iid}")
def get_investigation(iid: str) -> dict:
    try:
        return get_service().investigation(iid).model_dump(mode="json")
    except KeyError:
        raise HTTPException(404, f"investigation {iid} not found")
