from __future__ import annotations

import hmac
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

import uvicorn
from fastapi import FastAPI, HTTPException, Path, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from cityshift_swarm.contracts import (
    CheckpointBoundary,
    CheckpointResponse,
    DecisionRequest,
    DecisionResponse,
    RunRequest,
)
from cityshift_swarm.control import NativeUnavailable, RunConflict
from cityshift_swarm.native import NativeHost
from cityshift_swarm.prepare import prepare_core
from cityshift_swarm.settings import Settings

RunPath = Annotated[str, Path(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")]


def create_app(settings: Settings, host: NativeHost | None = None) -> FastAPI:
    native = host or NativeHost(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await native.initialize()
        try:
            yield
        finally:
            await native.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.native = native

    @app.middleware("http")
    async def authenticate(request: Request, call_next):
        authorization = request.headers.get("authorization", "")
        prefix, _, supplied = authorization.partition(" ")
        if prefix != "Bearer" or not hmac.compare_digest(supplied.encode(), settings.control_token.encode()):
            return JSONResponse({"detail": "unauthorized"}, status_code=401, headers={"WWW-Authenticate": "Bearer"})
        try:
            if int(request.headers.get("content-length", "0")) > 2_000_000:
                return JSONResponse({"detail": "request_too_large"}, status_code=413)
        except ValueError:
            return JSONResponse({"detail": "invalid_content_length"}, status_code=400)
        body = await request.body()
        if len(body) > 2_000_000:
            return JSONResponse({"detail": "request_too_large"}, status_code=413)
        return await call_next(request)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse({"detail": "invalid_request"}, status_code=422)

    @app.exception_handler(RunConflict)
    async def conflict(request: Request, exc: RunConflict) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.exception_handler(NativeUnavailable)
    async def unavailable(request: Request, exc: NativeUnavailable) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=503)

    @app.get("/health")
    async def health():
        return native.health()

    @app.post("/runs", status_code=201)
    async def start_run(payload: RunRequest):
        try:
            settings.validate_request(payload)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="unapproved_endpoint") from exc
        try:
            return await native.start(payload)
        except (RunConflict, NativeUnavailable):
            raise
        except Exception as exc:
            raise HTTPException(status_code=503, detail="native_startup_failed") from exc

    @app.post("/runs/{run_id}/decisions", response_model=DecisionResponse)
    async def decisions(run_id: RunPath, payload: DecisionRequest):
        return await native.decisions(run_id, payload)

    @app.post("/runs/{run_id}/checkpoint", response_model=CheckpointResponse)
    async def checkpoint(run_id: RunPath, payload: CheckpointBoundary):
        return await native.checkpoint(run_id, payload)

    @app.post("/runs/{run_id}/stop")
    async def stop_run(run_id: RunPath):
        return await native.stop(run_id)

    return app


def main() -> None:
    settings = Settings.from_env()
    prepare_core()
    settings.isolate_environment()
    settings.write_native_config()
    os.chdir(settings.root)
    uvicorn.run(create_app(settings), host="127.0.0.1", port=settings.port, access_log=False, log_level="warning")


if __name__ == "__main__":
    main()
