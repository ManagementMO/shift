"""Durable operator inbox. Acknowledgement is authoritative only in world checkpoints."""
from __future__ import annotations

import json
import re
import threading
from pathlib import Path

from cityshift.contracts import PopulationStimulus
from cityshift.domain.population_checkpoints import atomic_json

_LOCK = threading.RLock()
_IDENTIFIER = re.compile(r"^[a-zA-Z0-9_-]{1,160}$")
MAX_STIMULI = 128


def _path(root: Path, run_id: str) -> Path:
    if not _IDENTIFIER.fullmatch(run_id):
        raise ValueError("invalid population run identity")
    # Separate from the run directory: inputs can arrive before its worker starts,
    # and appending a paused input must never mutate a sealed checkpoint.
    return root / "population-inputs" / f"{run_id}.json"


def read_stimuli(root: Path, run_id: str) -> list[PopulationStimulus]:
    with _LOCK:
        path = _path(root, run_id)
        if not path.exists():
            return []
        data = json.loads(path.read_text())
        if not isinstance(data, list) or len(data) > MAX_STIMULI:
            raise ValueError("invalid population input journal")
        rows = [PopulationStimulus.model_validate(row) for row in data]
        if len({row.stimulus_id for row in rows}) != len(rows):
            raise ValueError("duplicate population input journal identity")
        return rows


def enqueue_stimuli(root: Path, run_id: str, values: list[PopulationStimulus]) -> None:
    with _LOCK:
        rows = read_stimuli(root, run_id)
        known = {row.stimulus_id: row for row in rows}
        for value in values:
            existing = known.get(value.stimulus_id)
            if existing is not None and existing != value:
                raise ValueError("stimulus identity already belongs to a different observation")
            if existing is None:
                rows.append(value)
                known[value.stimulus_id] = value
        if len(rows) > MAX_STIMULI:
            raise ValueError("population input journal is full")
        atomic_json(_path(root, run_id), [row.model_dump(mode="json") for row in rows])
