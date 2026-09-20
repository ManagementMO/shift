from __future__ import annotations

import hashlib
import json
import secrets
import threading
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from cityshift.contracts import ActionIntent, ActionProposal

CITY_TOOLS = frozenset({
    "observe_local_state", "recall_experience", "view_tasks", "estimate_trip", "propose_message", "propose_action",
})


class BridgeError(ValueError):
    pass


@dataclass(frozen=True)
class ActorScope:
    run_id: str
    resident_id: str
    worker_id: str


class ScopedCityBridge:
    def __init__(self, run_id: str):
        self.run_id = run_id
        self._lock = threading.RLock()
        self._scopes: dict[str, ActorScope] = {}
        self._workers: dict[str, str] = {}
        self._residents: dict[str, str] = {}
        self._observations: dict[str, str] = {}
        self._proposals: dict[tuple[str, str], ActionIntent] = {}
        self._epoch: int | None = None
        self._last_epoch = -1
        self._closed = False
        self._audit: list[dict[str, Any]] = []

    def audit(self) -> list[dict[str, Any]]:
        with self._lock:
            return [entry.copy() for entry in self._audit]

    def begin_epoch(self, epoch: int, observations: list[dict[str, Any]]) -> None:
        with self._lock:
            if self._closed:
                raise BridgeError("bridge closed")
            if self._epoch is not None or epoch <= self._last_epoch:
                raise BridgeError("epoch overlaps or is stale")
            snapshots = {}
            for item in observations:
                resident_id = item.get("resident_id")
                if (item.get("run_id") != self.run_id or item.get("epoch") != epoch
                        or not isinstance(resident_id, str) or resident_id in snapshots):
                    raise BridgeError("invalid observation scope for epoch")
                if any(not isinstance(item.get(k), int) or item[k] < 0 for k in ("t", "world_version")):
                    raise BridgeError("invalid observation time/version")
                snapshots[resident_id] = json.dumps(item, allow_nan=False, sort_keys=True)
            self._observations = snapshots
            self._proposals = {}
            self._epoch = epoch
            self._last_epoch = epoch

    def bind_worker(self, resident_id: str, worker_id: str) -> str:
        with self._lock:
            if self._closed or resident_id not in self._observations:
                raise BridgeError("resident unavailable for worker binding")
            if worker_id in self._workers or resident_id in self._residents:
                raise BridgeError("worker or resident already bound; use its existing capability")
            token = secrets.token_urlsafe(32)
            digest = hashlib.sha256(token.encode()).hexdigest()
            self._scopes[digest] = ActorScope(self.run_id, resident_id, worker_id)
            self._workers[worker_id] = resident_id
            self._residents[resident_id] = worker_id
            return token

    def call(self, capability: str, worker_id: str, epoch: int, name: str, arguments: dict[str, Any]) -> Any:
        with self._lock:
            scope = self._scopes.get(hashlib.sha256(capability.encode()).hexdigest())
            entry = None
            if scope is not None and scope.worker_id == worker_id:
                entry = {"run_id": self.run_id, "resident_id": scope.resident_id, "worker_id": worker_id,
                         "epoch": epoch, "name": name if name in CITY_TOOLS else "unavailable_tool",
                         "status": "rejected"}
            try:
                result = self._call(capability, worker_id, epoch, name, arguments)
                if entry is not None:
                    entry["status"] = "accepted"
                return result
            finally:
                if entry is not None:
                    self._audit.append(entry)

    def _call(self, capability: str, worker_id: str, epoch: int, name: str, arguments: dict[str, Any]) -> Any:
        with self._lock:
            if self._closed:
                raise BridgeError("bridge closed")
            scope = self._scopes.get(hashlib.sha256(capability.encode()).hexdigest())
            if scope is None or scope.worker_id != worker_id or scope.run_id != self.run_id:
                raise BridgeError("invalid actor capability")
            if epoch != self._epoch or scope.resident_id not in self._observations:
                raise BridgeError("inactive or stale decision epoch")
            if name not in CITY_TOOLS:
                raise BridgeError("tool is not available to residents")
            snapshot = json.loads(self._observations[scope.resident_id])
            if name in {"observe_local_state", "recall_experience", "view_tasks"}:
                if arguments:
                    raise BridgeError("unexpected tool arguments")
                field = {"recall_experience": "memories", "view_tasks": "tasks"}.get(name)
                return snapshot.get(field, []) if field else {
                    key: value for key, value in snapshot.items() if key not in {"tasks", "memories", "trip_options"}
                }
            if name == "estimate_trip":
                if set(arguments) - {"target_id", "travel_class"}:
                    raise BridgeError("unexpected tool arguments")
                return [option for option in snapshot.get("trip_options", [])
                        if all(option.get(k) == v for k, v in arguments.items())]
            if name == "propose_message":
                if set(arguments) - {"target_id", "text", "idempotency_key", "observation_refs"}:
                    raise BridgeError("unexpected tool arguments")
                arguments = arguments | {"action": "message"}
            try:
                proposal = ActionProposal.model_validate(arguments)
            except ValidationError as exc:
                raise BridgeError("invalid proposal arguments") from exc
            if proposal.action == "message" and proposal.target_id not in snapshot.get("contacts", []):
                raise BridgeError("recipient is not an eligible contact")
            intent = ActionIntent(
                **proposal.model_dump(), run_id=self.run_id, resident_id=scope.resident_id,
                epoch=epoch, world_version=snapshot["world_version"], effective_t=snapshot["t"],
                expires_t=snapshot["t"],
            )
            key = (scope.resident_id, proposal.idempotency_key)
            previous = self._proposals.get(key)
            if previous is not None and previous != intent:
                raise BridgeError("idempotency key reused with different proposal")
            if previous is None:
                staged = [p for p in self._proposals.values() if p.resident_id == scope.resident_id]
                if any((p.action == "message") == (intent.action == "message") for p in staged):
                    raise BridgeError("one action and one message per decision epoch")
                self._proposals[key] = intent
            return {"status": "proposed", "idempotency_key": proposal.idempotency_key,
                    "resident_id": scope.resident_id, "epoch": epoch}

    def end_epoch(self, epoch: int) -> list[ActionIntent]:
        with self._lock:
            if epoch != self._epoch:
                raise BridgeError("inactive decision epoch")
            proposals = [p.model_copy(deep=True) for _, p in sorted(self._proposals.items())]
            self._epoch = None
            self._observations.clear()
            self._proposals.clear()
            return proposals

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._epoch = None
            self._scopes.clear()
            self._workers.clear()
            self._residents.clear()
            self._observations.clear()
            self._proposals.clear()
