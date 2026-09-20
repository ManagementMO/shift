from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import httpx
from pydantic import ValidationError

from cityshift_swarm.contracts import TOOL_ARGUMENTS


class BridgeFailure(RuntimeError):
    pass


@dataclass
class WorkerScope:
    resident_id: str
    worker_id: str
    epoch: int | None = None
    capability: str | None = field(default=None, repr=False)
    bind_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)


class CityBridge:
    def __init__(
        self,
        run_id: str,
        base_url: str,
        control_token: str,
        timeout_s: int,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.run_id = run_id
        self._token = control_token
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=min(timeout_s, 10),
            verify=True,
            trust_env=False,
            follow_redirects=False,
            transport=transport,
        )
        self._closed = False

    async def bind(self, scope: WorkerScope) -> None:
        if self._closed or scope.epoch is None:
            raise BridgeFailure("inactive_worker")
        async with scope.bind_lock:
            if scope.capability is not None:
                return
            try:
                response = await self._client.post(
                    f"/api/population/bridge/{self.run_id}/bind",
                    headers={"Authorization": f"Bearer {self._token}"},
                    json={"resident_id": scope.resident_id, "worker_id": scope.worker_id},
                )
                response.raise_for_status()
                data = response.json()
                token = data.get("capability") if isinstance(data, dict) else None
                if not isinstance(token, str) or not 16 <= len(token) <= 512:
                    raise BridgeFailure("invalid_capability_response")
                scope.capability = token
            except (httpx.HTTPError, ValueError) as exc:
                raise BridgeFailure("city_binding_failed") from exc

    async def call(self, scope: WorkerScope, name: str, arguments: dict[str, Any]) -> Any:
        if self._closed or scope.epoch is None:
            raise BridgeFailure("inactive_worker")
        epoch = scope.epoch
        validator = TOOL_ARGUMENTS.get(name)
        if validator is None:
            raise BridgeFailure("unavailable_city_tool")
        try:
            validated = validator.model_validate(arguments).model_dump(exclude_none=True)
        except ValidationError as exc:
            raise BridgeFailure("invalid_city_tool_arguments") from exc
        await self.bind(scope)
        if self._closed or scope.epoch != epoch:
            raise BridgeFailure("inactive_worker")
        try:
            response = await self._client.post(
                f"/api/population/bridge/{self.run_id}/tool",
                headers={"Authorization": f"Bearer {scope.capability}"},
                json={"worker_id": scope.worker_id, "epoch": epoch, "name": name, "arguments": validated},
            )
            response.raise_for_status()
            if len(response.content) > 262144:
                raise BridgeFailure("city_tool_response_too_large")
            return response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise BridgeFailure("city_tool_failed") from exc

    async def close(self) -> None:
        self._closed = True
        self._token = ""
        await self._client.aclose()
