from __future__ import annotations

import asyncio
from collections.abc import Callable, Coroutine
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.routing import APIRoute

from cityshift.agents.population_gateway import (
    GatewayError,
    PopulationGateway,
    completion_sse,
    get_population_gateway,
    parse_json,
)


class PopulationGatewayRoute(APIRoute):
    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def protected(request: Request) -> Response:
            try:
                return await handler(request)
            except GatewayError as error:
                headers = {"Cache-Control": "no-store"}
                if error.status_code == 401:
                    headers["WWW-Authenticate"] = "Bearer"
                return JSONResponse(error.public_error(), status_code=error.status_code, headers=headers)

        return protected


router = APIRouter(prefix="/api/population/model/v1", tags=["population-model-gateway"],
                   route_class=PopulationGatewayRoute)
GatewayDependency = Annotated[PopulationGateway, Depends(get_population_gateway)]


def _bearer(request: Request) -> str:
    value = request.headers.get("authorization", "")
    if len(value) > 300 or not value.startswith("Bearer "):
        raise GatewayError("unauthorized")
    return value[7:]


@router.get("/models")
async def models(request: Request, gateway: GatewayDependency) -> JSONResponse:
    return JSONResponse(gateway.models(_bearer(request)), headers={"Cache-Control": "no-store"})


@router.post("/chat/completions")
async def chat_completions(request: Request, gateway: GatewayDependency) -> Response:
    token = _bearer(request)
    scope = gateway.authenticate(token)
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            length = int(content_length)
        except ValueError:
            raise GatewayError("invalid_request") from None
        if length < 0:
            raise GatewayError("invalid_request")
        if length > scope.limits.max_request_bytes:
            raise GatewayError("payload_too_large")
    if request.headers.get("content-encoding", "identity") != "identity":
        raise GatewayError("invalid_request")
    content_type = request.headers.get("content-type", "application/json").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        raise GatewayError("invalid_request")
    raw = bytearray()
    try:
        async with asyncio.timeout(10):
            async for chunk in request.stream():
                raw.extend(chunk)
                if len(raw) > scope.limits.max_request_bytes:
                    raise GatewayError("payload_too_large")
    except TimeoutError:
        raise GatewayError("invalid_request") from None
    body = parse_json(bytes(raw))
    completion = await gateway.complete(token, body)
    if body.get("stream"):
        include_usage = bool((body.get("stream_options") or {}).get("include_usage"))
        return StreamingResponse(completion_sse(completion, include_usage), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
    return JSONResponse(completion, headers={"Cache-Control": "no-store"})
