"""Locate the SUMO binaries shipped in the ``eclipse-sumo`` wheel (or an external SUMO_HOME)."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import sumo  # noqa: F401  (import sets SUMO_HOME / PROJ_LIB in os.environ)

SUMO_HOME = Path(os.environ["SUMO_HOME"])


def binary(name: str) -> str:
    candidate = SUMO_HOME / "bin" / name
    if candidate.exists():
        return str(candidate)
    found = shutil.which(name)
    if found:
        return found
    raise FileNotFoundError(f"SUMO binary {name!r} not found under {SUMO_HOME}/bin or PATH")


def sumo_version() -> str:
    import subprocess

    out = subprocess.run([binary("sumo"), "--version"], capture_output=True, text=True, check=False)
    for line in out.stdout.splitlines():
        if line.startswith("Eclipse SUMO"):
            return line.strip()
    return out.stdout.strip().splitlines()[0] if out.stdout.strip() else "unknown"
