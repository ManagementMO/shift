from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import uuid
from pathlib import Path
from typing import Any

from cityshift.agents.population_client import NativePopulationClient
from cityshift.contracts import PopulationDefinition
from cityshift.domain.population_checkpoint_state import SavedSociety
from cityshift.domain.society import SocietyWorld
from cityshift.transport.population import PopulationMobility

CHECKPOINT_VERSION = "population-checkpoint-1"
CHECKPOINT_ID = re.compile(r"cp_[a-f0-9]{32}\Z")
RULE_FILES = (
    "contracts.py", "domain/population.py", "domain/society.py", "domain/population_checkpoint_state.py",
    "domain/population_checkpoints.py", "domain/population_runs.py",
    "agents/population_baseline.py", "agents/population_client.py", "agents/population_bridge.py", "transport/population.py",
)


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, prefix=".artifact-",
                                     suffix=".tmp", delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(json.dumps(value, allow_nan=False, separators=(",", ":")))
            stream.flush()
            os.fsync(stream.fileno())
            os.replace(temporary, path)
            descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        finally:
            temporary.unlink(missing_ok=True)


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rules_hash() -> str:
    root = Path(__file__).resolve().parents[1]
    digest = hashlib.sha256()
    for name in RULE_FILES:
        digest.update(name.encode())
        digest.update((root / name).read_bytes())
    return digest.hexdigest()


def save_checkpoint(run_dir: Path, attempt_id: str, world: SocietyWorld, mobility: PopulationMobility,
                    native: NativePopulationClient | None, wall_time_s: float,
                    bridge_audit: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    if world.t != mobility.t:
        raise ValueError("world and transport must share one checkpoint time")
    boundary = world.align_epoch()
    if native is not None:
        native.align_boundary(**boundary)
    checkpoint_id = f"cp_{uuid.uuid4().hex}"
    directory = run_dir / "checkpoints" / checkpoint_id
    directory.mkdir(parents=True, mode=0o700, exist_ok=False)
    state = world.checkpoint_state()
    atomic_json(directory / "world.json", state)
    atomic_json(directory / "bridge.json", bridge_audit or [])
    mobility_state = mobility.save_checkpoint(directory / "sumo.xml")
    atomic_json(directory / "mobility.json", mobility_state)
    if mobility_state["t"] != state["t"]:
        raise ValueError("transport checkpoint time mismatch")
    world_hash = file_hash(directory / "world.json")
    native_state = native.checkpoint(boundary | {"world_state_hash": world_hash}) if native is not None else None
    if native_state is not None and any(native_state.get(key) != value for key, value in (
        boundary | {"world_state_hash": world_hash, "run_id": world.run_id}
    ).items()):
        raise ValueError("native checkpoint does not match the authoritative world boundary")
    manifest = {
        "version": CHECKPOINT_VERSION, "checkpoint_id": checkpoint_id, "run_id": world.run_id,
        "population_id": world.definition.population_id, "attempt_id": attempt_id,
        "control_mode": world.definition.spec.brains[0].control_mode,
        "rules_hash": rules_hash(), "boundary": boundary, "wall_time_s": wall_time_s,
        "files": {name: file_hash(directory / name) for name in ("world.json", "sumo.xml", "mobility.json", "bridge.json")},
        "native": native_state,
    }
    atomic_json(directory / "manifest.json", manifest)
    atomic_json(run_dir / "checkpoint.json", {
        "checkpoint_id": checkpoint_id, "manifest_hash": file_hash(directory / "manifest.json"),
    })
    return manifest


def load_checkpoint(run_dir: Path, run_id: str, population: PopulationDefinition) -> dict[str, Any]:
    pointer = json.loads((run_dir / "checkpoint.json").read_text())
    checkpoint_id = pointer.get("checkpoint_id", "")
    if not isinstance(checkpoint_id, str) or CHECKPOINT_ID.fullmatch(checkpoint_id) is None:
        raise ValueError("invalid checkpoint identifier")
    directory = run_dir / "checkpoints" / checkpoint_id
    if directory.is_symlink() or not directory.resolve().is_relative_to(run_dir.resolve()):
        raise ValueError("checkpoint path is outside this run")
    if (directory / "consumed.json").exists():
        raise ValueError("checkpoint was already consumed; arbitrary rollback is not supported")
    if file_hash(directory / "manifest.json") != pointer.get("manifest_hash"):
        raise ValueError("checkpoint manifest hash mismatch")
    manifest = json.loads((directory / "manifest.json").read_text())
    if (manifest.get("version") != CHECKPOINT_VERSION or manifest.get("checkpoint_id") != checkpoint_id
            or manifest.get("run_id") != run_id or manifest.get("population_id") != population.population_id
            or manifest.get("rules_hash") != rules_hash()):
        raise ValueError("checkpoint identity, version, or rules mismatch")
    expected_files = {"world.json", "sumo.xml", "mobility.json", "bridge.json"}
    if set(manifest.get("files", {})) != expected_files:
        raise ValueError("checkpoint artifact set mismatch")
    for name, expected in manifest["files"].items():
        if (directory / name).is_symlink() or file_hash(directory / name) != expected:
            raise ValueError("checkpoint artifact hash mismatch")
    state = SavedSociety.model_validate_json((directory / "world.json").read_text())
    mobility = json.loads((directory / "mobility.json").read_text())
    expected_boundary = {"epoch": state.epoch, "t": state.t, "world_version": state.world_version}
    if (manifest.get("boundary") != expected_boundary or state.run_id != run_id
            or state.population_id != population.population_id or mobility.get("run_id") != run_id
            or mobility.get("t") != state.t or mobility.get("seed") != population.spec.seed
            or mobility.get("horizon_s") != population.spec.horizon_s):
        raise ValueError("checkpoint clock or transport identity mismatch")
    active = {binding.entity_id: binding for binding in state.mobility_bindings if binding.measured and binding.end_s is None}
    if set(active) != set(mobility.get("active", {})):
        raise ValueError("checkpoint world and SUMO body sets disagree")
    for entity_id, binding in active.items():
        trip = mobility["active"][entity_id]
        resident = state.states[binding.resident_id]
        if (trip["resident_id"] != binding.resident_id or trip["travel_class"] != binding.vehicle_class
                or trip["destination_id"] != resident.destination_id):
            raise ValueError("checkpoint world and SUMO ownership disagree")
    native = manifest.get("native")
    is_native = population.spec.brains[0].control_mode == "jiuwenswarm"
    if manifest.get("control_mode") != population.spec.brains[0].control_mode or is_native != (native is not None):
        raise ValueError("checkpoint cognition mode mismatch")
    if native is not None:
        boundary = expected_boundary | {"run_id": run_id, "world_state_hash": manifest["files"]["world.json"]}
        if any(native.get(key) != value for key, value in boundary.items()):
            raise ValueError("checkpoint native boundary mismatch")
    audit = json.loads((directory / "bridge.json").read_text())
    if not isinstance(audit, list) or any(
        not isinstance(entry, dict) or entry.get("run_id") != run_id or entry.get("resident_id") not in state.states
        or type(entry.get("epoch")) is not int or not 0 <= entry["epoch"] <= state.epoch for entry in audit
    ):
        raise ValueError("checkpoint bridge audit scope mismatch")
    return {"manifest": manifest, "world": state.model_dump(mode="json"), "mobility": mobility,
            "bridge_audit": audit, "directory": directory, "sumo_path": directory / "sumo.xml"}


def consume_checkpoint(checkpoint: dict[str, Any]) -> None:
    directory = Path(checkpoint["directory"])
    target = directory / "consumed.json"
    with target.open("x", encoding="utf-8") as stream:
        json.dump({"checkpoint_id": checkpoint["manifest"]["checkpoint_id"]}, stream)
        stream.flush()
        os.fsync(stream.fileno())
