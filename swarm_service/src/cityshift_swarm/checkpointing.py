from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import time
import uuid
from collections import Counter
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from cityshift_swarm.contracts import (
    Binding,
    CheckpointBoundary,
    CheckpointId,
    CheckpointResponse,
    Contract,
    DecisionRequest,
    DecisionResponse,
    Digest,
    Identifier,
    ResidentDecision,
    RunRequest,
)
from cityshift_swarm.control import RunConflict
from cityshift_swarm.prepare import attest_core_patch
from cityshift_swarm.settings import CORE_SHA, SWARM_SHA, WORKFLOW_NAME, Settings


class CheckpointManifest(Contract):
    format: Literal[1]
    sealed: Literal[True]
    checkpoint_id: CheckpointId
    boundary: CheckpointBoundary
    request: dict[str, Any]
    source_shas: dict[str, str]
    core_patch: dict[str, Any]
    adapter_hash: Digest
    workflow_name: str
    team_id: Identifier
    team_session_id: Identifier
    workflow_id: Identifier
    bindings: dict[Identifier, Binding]
    context_hashes: dict[Identifier, Digest]
    team_state_hash: Digest
    session_tokens_spent: int = Field(ge=0)
    workflow_tokens_spent: int = Field(ge=0)
    generation: int = Field(ge=0)
    elapsed_seconds: float = Field(ge=0)
    epoch_count: int = Field(ge=1)
    last_response: DecisionResponse
    files: dict[str, Digest]


class RecordedBoundary(Contract):
    request: DecisionRequest
    native_results: dict[Identifier, ResidentDecision | None]


async def verify_complete_native_journal(control: Any) -> None:
    from openjiuwen.agent_teams.paths import workflow_journal_path
    from openjiuwen.agent_teams.workflow.engine.journal import Journal

    path = workflow_journal_path(control.team_id, control.team_session_id, WORKFLOW_NAME)
    journal = await Journal.load(str(path), wal_path=f"{path}.wal")
    expected = Counter()
    labels = {resident.resident_id: label for label, resident in control.labels.items()}
    for item in control.history:
        recorded = RecordedBoundary.model_validate(item)
        due = {packet["resident_id"] for packet in recorded.request.observations}
        if set(recorded.native_results) != due:
            raise RunConflict("checkpoint_requires_complete_native_journal")
        for resident_id, result in recorded.native_results.items():
            expected[(labels[resident_id], digest(result))] += 1
    actual = Counter()
    tokens = 0
    for record in journal.prior.values():
        if record.get("type") in {"pause", "seal"}:
            continue
        if record.get("run_id") != control.workflow_id or record.get("label") not in control.labels:
            raise RunConflict("checkpoint_native_journal_scope_mismatch")
        label = record["label"]
        resident_id = control.labels[label].resident_id
        result = record.get("result")
        if result is None:
            failure = record.get("stateful_failure")
            if (
                not isinstance(failure, dict) or failure.get("version") != 1
                or failure.get("member_name") != control.bindings[resident_id].worker_id
                or record.get("kind") != "null" or not isinstance(failure.get("error"), str)
            ):
                raise RunConflict("checkpoint_requires_complete_native_journal")
        else:
            if "stateful_failure" in record:
                raise RunConflict("checkpoint_native_journal_result_mismatch")
            result = ResidentDecision.model_validate(result)
        value = record.get("tokens")
        if value is not None and (type(value) is not int or value < 0):
            raise RunConflict("checkpoint_native_journal_usage_mismatch")
        tokens += value or 0
        actual[(label, digest(result))] += 1
    if actual != expected or tokens > control.workflow_budget.spent:
        raise RunConflict("checkpoint_requires_complete_native_journal")


async def verify_native_state(data: dict[str, Any]) -> None:
    from openjiuwen.agent_teams.runtime.metadata import read_team_namespace
    from openjiuwen.core.session.agent import create_agent_session
    from openjiuwen.core.session.agent_team import Session
    from openjiuwen.core.single_agent import AgentCard

    team_session = Session(session_id=data["team_session_id"], source_metadata_enabled=False)
    await team_session.pre_run()
    if digest(read_team_namespace(team_session, data["team_id"])) != data["team_state_hash"]:
        raise RunConflict("native_team_checkpoint_missing_or_changed")
    await team_session.close_stream()
    for resident_id, expected in data["context_hashes"].items():
        binding = data["bindings"][resident_id]
        session = create_agent_session(
            session_id=binding["session_id"],
            card=AgentCard(id=f"{binding['team_id']}_{binding['worker_id']}", name=binding["worker_id"]),
        )
        await session.pre_run()
        if digest(session.get_state("context")) != expected:
            raise RunConflict("native_resident_checkpoint_missing_or_changed")
        await session.close_stream()


def canonical(value: Any) -> bytes:
    def encode(item: Any) -> Any:
        if isinstance(item, BaseModel):
            return item.model_dump(mode="json")
        raise TypeError("unsupported checkpoint value")

    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False, default=encode).encode()


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def file_hash(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def adapter_hash() -> str:
    root = Path(__file__).parent
    return digest({path.name: file_hash(path) for path in sorted(root.glob("*.py"))})


def frozen_request(request: RunRequest) -> dict[str, Any]:
    return request.model_dump(exclude={"resume_checkpoint", "resume_boundary"})


def durable_json(path: Path, value: Any) -> None:
    temp = path.with_suffix(".tmp")
    with temp.open("wb") as stream:
        stream.write(canonical(value))
        stream.flush()
        os.fsync(stream.fileno())
    temp.replace(path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def durable_copy(source: Path, destination: Path) -> None:
    shutil.copyfile(source, destination)
    with destination.open("rb") as stream:
        os.fsync(stream.fileno())


def sqlite_snapshot(source: Path, destination: Path) -> None:
    if not source.is_file() or source.is_symlink():
        raise RunConflict("native_checkpoint_database_missing")
    with sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True) as original:
        if original.execute("PRAGMA quick_check").fetchone() != ("ok",):
            raise RunConflict("native_checkpoint_database_corrupt")
        with sqlite3.connect(destination) as target:
            original.backup(target)
    with destination.open("rb") as stream:
        os.fsync(stream.fileno())


class NativePersistence:
    def __init__(self):
        self.engine = None
        self.path: Path | None = None

    async def initialize(self) -> None:
        from jiuwenswarm.common.utils import get_checkpoint_dir
        from openjiuwen.core.session.checkpointer import CheckpointerFactory
        from openjiuwen.core.session.checkpointer.checkpointer import CheckpointerConfig
        from sqlalchemy import event
        from sqlalchemy.ext.asyncio import create_async_engine

        self.path = get_checkpoint_dir() / "checkpoint.db"
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.engine = create_async_engine(f"sqlite+aiosqlite:///{self.path}", connect_args={"timeout": 30})

        @event.listens_for(self.engine.sync_engine, "connect")
        def wal(connection, record):
            cursor = connection.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.close()

        checkpointer = await CheckpointerFactory.create(CheckpointerConfig(
            type="persistence", conf={"db_type": "sqlite", "db_path": str(self.path), "db_client": self.engine},
        ))
        CheckpointerFactory.set_default_checkpointer(checkpointer)

    async def close(self) -> None:
        if self.engine is not None:
            await self.engine.dispose()
            self.engine = None


class CheckpointStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.root = settings.root / "checkpoints"

    def paths(self, team_id: str, session_id: str) -> dict[str, Path]:
        from jiuwenswarm.common.utils import get_checkpoint_dir
        from openjiuwen.agent_teams.paths import get_agent_teams_home, workflow_journal_path

        journal = workflow_journal_path(team_id, session_id, WORKFLOW_NAME)
        return {
            "checkpoint.db": get_checkpoint_dir() / "checkpoint.db",
            "team.db": get_agent_teams_home() / "team.db",
            "journal.jsonl.wal": Path(f"{journal}.wal"),
        }

    def seal(
        self, control: Any, boundary: CheckpointBoundary, contexts: dict[str, str], team_state_hash: str,
    ) -> CheckpointResponse:
        checkpoint_id = f"cp_{uuid.uuid4().hex}"
        folder = self.root / checkpoint_id
        folder.mkdir(mode=0o700, parents=True, exist_ok=False)
        artifacts = self.paths(control.team_id, control.team_session_id)
        for name, source in artifacts.items():
            target = folder / name
            if name.endswith(".db"):
                sqlite_snapshot(source, target)
            else:
                if not source.is_file() or source.is_symlink():
                    raise RunConflict("native_workflow_journal_missing")
                durable_copy(source, target)
        durable_json(folder / "boundaries.json", control.history)
        artifacts["boundaries.json"] = folder / "boundaries.json"
        data = {
            "format": 1,
            "sealed": True,
            "checkpoint_id": checkpoint_id,
            "boundary": boundary.model_dump(),
            "request": frozen_request(control.request),
            "source_shas": {"workswarm": SWARM_SHA, "openjiuwen": CORE_SHA},
            "core_patch": attest_core_patch(),
            "adapter_hash": adapter_hash(),
            "workflow_name": WORKFLOW_NAME,
            "team_id": control.team_id,
            "team_session_id": control.team_session_id,
            "workflow_id": control.workflow_id,
            "bindings": {key: value.model_dump() for key, value in control.bindings.items()},
            "context_hashes": contexts,
            "team_state_hash": team_state_hash,
            "session_tokens_spent": control.native_budget.spent,
            "workflow_tokens_spent": control.workflow_budget.spent,
            "generation": control.generation,
            "elapsed_seconds": time.monotonic() - control.created_at,
            "epoch_count": control.epoch_count,
            "last_response": control.last_response.model_dump(),
            "files": {name: file_hash(folder / name) for name in artifacts},
        }
        CheckpointManifest.model_validate(data)
        durable_json(folder / "manifest.json", data)
        return CheckpointResponse(
            **boundary.model_dump(), run_id=control.request.run_id, checkpoint_id=checkpoint_id,
            checkpoint_hash=digest(data), generation=control.generation,
            native_tokens_spent=control.native_budget.spent,
        )

    def load(self, request: RunRequest) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        folder = self.root / str(request.resume_checkpoint)
        boundary = request.resume_boundary
        try:
            if folder.is_symlink() or not folder.is_dir() or boundary is None:
                raise RunConflict("checkpoint_missing")
            manifest = folder / "manifest.json"
            if manifest.is_symlink():
                raise RunConflict("checkpoint_corrupt")
            data = json.loads(manifest.read_bytes())
            if digest(data) != boundary.checkpoint_hash:
                raise RunConflict("checkpoint_hash_mismatch")
            CheckpointManifest.model_validate(data)
            if (
                data.get("format") != 1 or data.get("sealed") is not True
                or data.get("checkpoint_id") != request.resume_checkpoint
                or data.get("request") != frozen_request(request)
                or data.get("boundary") != boundary.model_dump(exclude={"checkpoint_hash"})
                or data.get("adapter_hash") != adapter_hash()
                or data.get("source_shas") != {"workswarm": SWARM_SHA, "openjiuwen": CORE_SHA}
                or data.get("core_patch") != attest_core_patch()
                or data.get("workflow_name") != WORKFLOW_NAME
            ):
                raise RunConflict("checkpoint_configuration_or_boundary_mismatch")
            if set(data["files"]) != {"checkpoint.db", "team.db", "journal.jsonl.wal", "boundaries.json"}:
                raise RunConflict("checkpoint_artifacts_missing")
            for name, expected in data["files"].items():
                artifact = folder / name
                if artifact.is_symlink() or not artifact.is_file() or file_hash(artifact) != expected:
                    raise RunConflict("checkpoint_artifact_hash_mismatch")
            history = json.loads((folder / "boundaries.json").read_bytes())
            if not isinstance(history, list) or not history or len(history) != data["epoch_count"]:
                raise RunConflict("checkpoint_boundary_history_missing")
            self.validate_history(request, data, history)
            return data, history
        except (OSError, ValueError, KeyError, TypeError) as exc:
            if isinstance(exc, RunConflict):
                raise
            raise RunConflict("checkpoint_missing_or_corrupt") from exc

    def validate_history(self, request: RunRequest, data: dict[str, Any], history: list[dict[str, Any]]) -> None:
        roster = {resident.resident_id: resident for resident in request.residents}
        if set(data["bindings"]) != set(roster):
            raise RunConflict("checkpoint_binding_mismatch")
        expected_contexts = set()
        for resident_id, binding in data["bindings"].items():
            if (binding["team_id"] != data["team_id"] or binding["workflow_id"] != data["workflow_id"]
                    or binding["requested_model_id"] != roster[resident_id].model_id):
                raise RunConflict("checkpoint_binding_mismatch")
            if binding["session_id"] is not None:
                expected = f"{data['team_id']}/{WORKFLOW_NAME}/{binding['worker_id']}"
                if binding["session_id"] != expected or binding["resolved_model_id"] != roster[resident_id].model_id:
                    raise RunConflict("checkpoint_native_identity_mismatch")
                expected_contexts.add(resident_id)
        if set(data["context_hashes"]) != expected_contexts:
            raise RunConflict("checkpoint_native_context_set_mismatch")
        previous = (-1, -1, -1)
        for item in history:
            recorded = RecordedBoundary.model_validate(item)
            boundary = recorded.request
            current = (boundary.epoch, boundary.t, boundary.world_version)
            if current[0] <= previous[0] or current[1] < previous[1] or current[2] < previous[2]:
                raise RunConflict("checkpoint_observation_history_mismatch")
            due = {packet["resident_id"] for packet in boundary.observations}
            if set(recorded.native_results) != due or not due.issubset(roster):
                raise RunConflict("checkpoint_observation_history_mismatch")
            if any(packet["run_id"] != request.run_id for packet in boundary.observations):
                raise RunConflict("checkpoint_observation_history_mismatch")
            previous = current
        final = data["boundary"]
        if previous != (final["epoch"], final["t"], final["world_version"]):
            raise RunConflict("checkpoint_boundary_history_mismatch")
        if (data["last_response"]["run_id"] != request.run_id
                or data["last_response"]["epoch"] != final["epoch"]
                or data["last_response"]["native_tokens_spent"] != data["session_tokens_spent"]
                or data["epoch_count"] > self.settings.max_epochs
                or data["session_tokens_spent"] >= request.budget.max_tokens
                or data["workflow_tokens_spent"] > data["session_tokens_spent"]):
            raise RunConflict("checkpoint_budget_or_boundary_mismatch")

    async def restore(self, request: RunRequest, data: dict[str, Any], persistence: NativePersistence) -> None:
        folder = self.root / str(request.resume_checkpoint)
        try:
            descriptor = os.open(folder / "claimed", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError as exc:
            raise RunConflict("checkpoint_already_consumed") from exc
        try:
            os.write(descriptor, b"consumed\n")
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        directory = os.open(folder, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        await persistence.close()
        self.restore_files(folder, data)
        await persistence.initialize()
        await verify_native_state(data)

    def restore_files(self, folder: Path, data: dict[str, Any]) -> None:
        for name, target in self.paths(data["team_id"], data["team_session_id"]).items():
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            if target.is_symlink():
                raise RunConflict("unsafe_native_restore_path")
            if name.endswith(".db"):
                for suffix in ("", "-wal", "-shm"):
                    Path(f"{target}{suffix}").unlink(missing_ok=True)
                sqlite_snapshot(folder / name, target)
            else:
                target.with_suffix("").unlink(missing_ok=True)
                durable_copy(folder / name, target)
