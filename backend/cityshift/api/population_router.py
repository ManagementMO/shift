from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import Field

from cityshift.agents.population_bridge import BridgeError
from cityshift.agents.population_client import SwarmUnavailable
from cityshift.api.population_service import PopulationService, get_population_service
from cityshift.contracts import PopulationContract, PopulationSpec, PopulationStimulus

router = APIRouter(prefix="/api/population", tags=["population"])
ServiceDependency = Annotated[PopulationService, Depends(get_population_service)]
PopulationId = Annotated[str, Path(min_length=1, max_length=160, pattern=r"^[a-zA-Z0-9_-]+$")]


class PopulationRunRequest(PopulationContract):
    population_id: str = Field(min_length=1, max_length=160, pattern=r"^[a-zA-Z0-9_-]+$")
    idempotency_key: str = Field(min_length=1, max_length=160, pattern=r"^[a-zA-Z0-9_.:-]+$")
    stimuli: list[PopulationStimulus] = Field(default_factory=list, max_length=128)


class BindWorkerRequest(PopulationContract):
    resident_id: str = Field(min_length=1, max_length=160)
    worker_id: str = Field(min_length=1, max_length=160)


class CityToolRequest(PopulationContract):
    worker_id: str = Field(min_length=1, max_length=160)
    epoch: int = Field(ge=0)
    name: str = Field(min_length=1, max_length=80)
    arguments: dict[str, Any] = Field(default_factory=dict, max_length=12)


def _bearer(request: Request) -> str:
    value = request.headers.get("authorization", "")
    if not value.startswith("Bearer ") or len(value) > 300:
        raise HTTPException(status_code=401, detail="population capability required")
    return value[7:]


@router.get("/status")
def status(service: ServiceDependency) -> dict:
    return service.status()


@router.post("/scenarios", status_code=201)
def create_population(spec: PopulationSpec, service: ServiceDependency) -> dict:
    try:
        return service.create(spec).model_dump(mode="json")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="city pack has not been built") from None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


@router.get("/scenarios/{population_id}")
def get_population(population_id: PopulationId, service: ServiceDependency) -> dict:
    try:
        return service.population(population_id).model_dump(mode="json")
    except KeyError:
        raise HTTPException(status_code=404, detail="population not found") from None


@router.post("/runs", status_code=202)
def start_population(payload: PopulationRunRequest, service: ServiceDependency) -> dict:
    try:
        return service.submit(payload.population_id, payload.idempotency_key, payload.stimuli).model_dump(mode="json")
    except KeyError:
        raise HTTPException(status_code=404, detail="population or pack not found") from None
    except SwarmUnavailable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None


@router.post("/runs/{run_id}/stimuli", status_code=202)
def queue_stimulus(run_id: PopulationId, payload: PopulationStimulus, service: ServiceDependency) -> dict:
    try:
        return service.queue_stimulus(run_id, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="population run not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None


@router.get("/runs/{run_id}/stimuli")
def list_stimuli(run_id: PopulationId, service: ServiceDependency) -> dict:
    try:
        return service.stimuli(run_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="population run not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None


@router.get("/runs/{run_id}/snapshot")
def population_snapshot(run_id: PopulationId, service: ServiceDependency) -> dict:
    try:
        return service.snapshot(run_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="population run not found") from None
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="resident snapshot is not yet published") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None


@router.post("/runs/{run_id}/pause", status_code=202)
def pause_population(run_id: PopulationId, service: ServiceDependency) -> dict:
    try:
        return {"run_id": run_id, "requested": service.pause(run_id)}
    except KeyError:
        raise HTTPException(status_code=404, detail="population run not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None


@router.post("/runs/{run_id}/resume", status_code=202)
def resume_population(run_id: PopulationId, service: ServiceDependency) -> dict:
    try:
        return service.resume(run_id).model_dump(mode="json")
    except KeyError:
        raise HTTPException(status_code=404, detail="population run not found") from None
    except FileNotFoundError:
        raise HTTPException(status_code=409, detail="a complete paired checkpoint is not available") from None
    except (ValueError, SwarmUnavailable) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None


@router.post("/bridge/{run_id}/bind")
def bind_worker(run_id: PopulationId, payload: BindWorkerRequest, request: Request, service: ServiceDependency) -> dict:
    if not service.authenticate_controller(_bearer(request)):
        raise HTTPException(status_code=403, detail="controller authority required")
    try:
        token = service.bridge(run_id).bind_worker(payload.resident_id, payload.worker_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="population run is not active") from None
    except BridgeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from None
    return {"capability": token}


@router.post("/bridge/{run_id}/tool")
def city_tool(run_id: PopulationId, payload: CityToolRequest, request: Request, service: ServiceDependency) -> Any:
    try:
        return service.bridge(run_id).call(_bearer(request), payload.worker_id, payload.epoch,
                                           payload.name, payload.arguments)
    except KeyError:
        raise HTTPException(status_code=404, detail="population run is not active") from None
    except BridgeError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from None
