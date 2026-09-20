"""CITY//SHIFT HTTP API. Every response is backed by a stored artifact; nothing here fabricates simulation output."""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from pymongo.errors import PyMongoError

from cityshift.api.live_router import close_registry
from cityshift.api.live_router import router as live_router
from cityshift.api.service import close_service, get_service
from cityshift.contracts import SCHEMA_VERSION, DemandSet, ScenarioSpec, ServicePlan
from cityshift.domain.network import pack_dir
from cityshift.domain.runs import RUN_ROOT
from cityshift.store import STORAGE_UNAVAILABLE_MESSAGE, StorageUnavailable, storage_backend
from cityshift.transport.sumo_env import sumo_version


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    try:
        yield
    finally:
        close_registry()
        close_service()


app = FastAPI(title="Concrete Consequences", version="0.1.0", lifespan=lifespan)
app.include_router(live_router)
app.add_middleware(GZipMiddleware, minimum_size=2048)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

RUN_ARTIFACTS = {
    "tracks": "tracks.json",
    "events": "events.json",
    "occupancy": "occupancy.json",
    "stop_queue": "stop_queue.json",
    "metrics": "metrics.json",
    "cohort": "cohort.json",
    "compile": "compile.json",
    "validation": "validation.json",
    "manifest": "manifest.json",
    "demand": "demand.json",
    "scenario": "scenario.json",
    "tripinfo_summary": "tripinfo_summary.json",
}
PACK_ARTIFACTS = {"roads": "roads.geojson", "walk": "walk.geojson", "corridors": "corridors.json", "world": "world.json", "massing": "massing.json"}


def _not_found(what: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"{what} not found")


@app.exception_handler(StorageUnavailable)
@app.exception_handler(PyMongoError)
async def storage_error(_request: Request, exc: Exception) -> JSONResponse:
    detail = str(exc) if isinstance(exc, StorageUnavailable) else STORAGE_UNAVAILABLE_MESSAGE
    return JSONResponse(status_code=503, content={"detail": detail})


def storage_status() -> dict:
    backend = storage_backend()
    configured = backend == "json" or bool(os.environ.get("MONGODB_URI") and os.environ.get("MONGODB_DATABASE"))
    try:
        store = get_service().store
        return {"backend": store.backend, "configured": True, "available": store.ping()}
    except (StorageUnavailable, PyMongoError) as exc:
        return {
            "backend": backend if backend in {"mongodb", "json"} else "invalid",
            "configured": configured, "available": False,
            "message": str(exc) if isinstance(exc, StorageUnavailable) else STORAGE_UNAVAILABLE_MESSAGE,
        }


# --- health / providers -----------------------------------------------------------------------
@app.get("/api/health")
def health() -> dict:
    from cityshift.providers import provider_status

    storage = storage_status()
    return {
        "ok": storage["available"],
        "storage": storage,
        "schema_version": SCHEMA_VERSION,
        "sumo": sumo_version(),
        "providers": provider_status(),
        "pid": os.getpid(),
    }


# --- packs --------------------------------------------------------------------------------------
@app.get("/api/packs")
def list_packs() -> list[dict]:
    svc = get_service()
    return [
        {
            "pack_id": p.pack_id, "name": p.name, "version": p.version, "bbox": p.bbox, "center": p.center,
            "stops": len(p.stops), "zones": len(p.zones), "real_data": p.real_data, "limitations": p.limitations,
        }
        for p in svc.list_packs()
    ]


@app.get("/api/packs/{pack_id}")
def get_pack(pack_id: str) -> dict:
    try:
        return get_service().pack(pack_id).model_dump(mode="json")
    except FileNotFoundError:
        raise _not_found("pack") from None


@app.get("/api/packs/{pack_id}/{artifact}")
def get_pack_artifact(pack_id: str, artifact: str) -> FileResponse:
    if artifact not in PACK_ARTIFACTS:
        raise _not_found("artifact")
    p = pack_dir(pack_id) / PACK_ARTIFACTS[artifact]
    if not p.exists():
        raise _not_found("artifact")
    return FileResponse(p, media_type="application/json")


# --- scenarios ----------------------------------------------------------------------------------
class FlagshipRequest(BaseModel):
    pack_id: str = "toronto"
    seed: int = 7
    cohort_size: int = Field(default=240, ge=10, le=2000)
    horizon_s: int = Field(default=2700, ge=600, le=14400)


@app.post("/api/scenarios/flagship")
def create_flagship(req: FlagshipRequest) -> dict:
    svc = get_service()
    try:
        s = svc.create_flagship(req.pack_id, req.seed, req.cohort_size, req.horizon_s)
    except FileNotFoundError:
        raise _not_found("pack") from None
    return s.model_dump(mode="json")


class ScenarioCreate(BaseModel):
    scenario: ScenarioSpec
    demand: DemandSet


@app.post("/api/scenarios")
def create_scenario(req: ScenarioCreate) -> dict:
    try:
        return get_service().register_scenario(req.scenario, req.demand).model_dump(mode="json")
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@app.get("/api/scenarios")
def list_scenarios() -> list[dict]:
    return [s.model_dump(mode="json") for s in get_service().store.list_scenarios()]


@app.get("/api/scenarios/{sid}")
def get_scenario(sid: str) -> dict:
    try:
        return get_service().scenario(sid).model_dump(mode="json")
    except KeyError:
        raise _not_found("scenario") from None


@app.get("/api/scenarios/{sid}/demand")
def get_demand(sid: str) -> dict:
    try:
        return get_service().demand(sid).model_dump(mode="json")
    except KeyError:
        raise _not_found("scenario") from None


@app.get("/api/scenarios/{sid}/plans")
def list_plans(sid: str) -> list[dict]:
    svc = get_service()
    try:
        svc.scenario(sid)
    except KeyError:
        raise _not_found("scenario") from None
    out = []
    for p in svc.store.list_plans(sid):
        rep = svc.store.get_validation(sid, p.plan_id)
        out.append({"plan": p.model_dump(mode="json"), "validation": rep.model_dump(mode="json") if rep else None})
    return out


@app.post("/api/scenarios/{sid}/plans")
def submit_plan(sid: str, plan: ServicePlan) -> dict:
    svc = get_service()
    try:
        scenario = svc.scenario(sid)
    except KeyError:
        raise _not_found("scenario") from None
    if svc.store.get_plan(sid, plan.plan_id) is not None:
        raise HTTPException(status_code=409, detail="plan_id already exists for this scenario (plans are immutable)")
    report = svc.register_plan(scenario, plan)
    return {"plan": plan.model_dump(mode="json"), "validation": report.model_dump(mode="json")}


@app.post("/api/scenarios/{sid}/validate")
def validate_only(sid: str, plan: ServicePlan) -> dict:
    """Dry-run validation: does not store the plan."""
    from cityshift.domain.validators import validate_plan

    svc = get_service()
    try:
        scenario = svc.scenario(sid)
    except KeyError:
        raise _not_found("scenario") from None
    return validate_plan(svc.pack(scenario.pack_id), scenario, plan, svc.store.get_demand(sid)).model_dump(mode="json")


# --- runs ---------------------------------------------------------------------------------------
class RunRequest(BaseModel):
    scenario_id: str
    plan_id: str
    seed: int = 1


@app.post("/api/runs")
def submit_run(req: RunRequest) -> dict:
    try:
        return get_service().submit_run(req.scenario_id, req.plan_id, req.seed).model_dump(mode="json")
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"{exc.args[0]} not found") from None


@app.get("/api/runs")
def list_runs(scenario_id: str | None = Query(default=None)) -> list[dict]:
    svc = get_service()
    try:
        runs = svc.current_runs(scenario_id) if scenario_id else svc.store.list_runs()
    except KeyError:
        raise _not_found("scenario") from None
    return [r.model_dump(mode="json") for r in runs]


@app.get("/api/runs/{rid}")
def get_run(rid: str) -> dict:
    try:
        return get_service().run(rid).model_dump(mode="json")
    except KeyError:
        raise _not_found("run") from None


@app.post("/api/runs/{rid}/cancel")
def cancel_run(rid: str) -> dict:
    return {"canceled": get_service().cancel_run(rid)}


@app.get("/api/runs/{rid}/{artifact}")
def get_run_artifact(rid: str, artifact: str) -> FileResponse:
    if artifact not in RUN_ARTIFACTS:
        raise _not_found("artifact")
    p = RUN_ROOT / rid / RUN_ARTIFACTS[artifact]
    if not p.exists() or not p.resolve().is_relative_to(RUN_ROOT.resolve()):
        raise _not_found("artifact")
    return FileResponse(p, media_type="application/json")


@app.get("/api/runs/{rid}/journey/{person_id}")
def get_journey(rid: str, person_id: str) -> JSONResponse:
    """One traveler's evidence: their events, final state, and track (from stored records only)."""
    d = RUN_ROOT / rid
    if not (d / "events.json").exists():
        raise _not_found("run")
    events = [e for e in json.loads((d / "events.json").read_text()) if e["person_id"] == person_id]
    cohort = json.loads((d / "cohort.json").read_text())
    tracks = json.loads((d / "tracks.json").read_text())
    vehicle_ids = sorted({e["vehicle_id"] for e in events if e.get("vehicle_id")})
    return JSONResponse(
        {
            "person_id": person_id,
            "events": events,
            "desired_depart": cohort["desired_depart"].get(person_id),
            "arrived": cohort["arrived"].get(person_id),
            "track": tracks.get(person_id),
            "vehicle_tracks": {v: tracks[v] for v in vehicle_ids if v in tracks},
        }
    )


def _include_optional_routers() -> None:
    for mod in ("cityshift.api.edit_router", "cityshift.api.agents_router", "cityshift.api.evidence_router",
                "cityshift.api.share_router", "cityshift.api.llm_router"):
        try:
            module = __import__(mod, fromlist=["router"])
        except ImportError:
            continue
        app.include_router(module.router)


_include_optional_routers()

STATIC_DIR = Path(__file__).resolve().parents[3] / "frontend" / "dist"
if STATIC_DIR.exists():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
