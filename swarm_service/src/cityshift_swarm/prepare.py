from __future__ import annotations

import argparse
import ast
import difflib
import fcntl
import hashlib
import importlib.metadata
import json
import os
import stat
import sys
import tempfile
from pathlib import Path
from typing import Any

from cityshift_swarm.settings import CORE_SHA

PROFILE = "cityshift-stateful-failures-v1"
SDK_FILE = "openjiuwen/agent_teams/workflow/engine/primitives.py"
SDK_MODULE = "openjiuwen.agent_teams.workflow.engine.primitives"
SERVICE_ROOT = Path(__file__).resolve().parents[2]
PATCH_FILE = SERVICE_ROOT / "patches" / "core-stateful-failures-v1.patch.json"
BASE_FILE_SHA256 = "978a8c302265531f8a71d395c0fa515d74f88b14c9a823346904822a3c5ea369"
PATCHED_FILE_SHA256 = "af2c2bd5c55d43c4906d0d7b3a5f0a5e747cf8197f54d9ded9462ce7d464f7cf"
PATCH_SHA256 = "ec257e7577d1ed9274166900abeec1af02b896680e5c03b6e8284c3b5b8324f2"


class CorePatchError(RuntimeError):
    pass


def sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def installed_target() -> Path:
    environment = (SERVICE_ROOT / ".venv").resolve()
    if Path(sys.prefix).resolve() != environment:
        raise CorePatchError("patch_requires_the_isolated_swarm_service_venv")
    try:
        distribution = importlib.metadata.distribution("openjiuwen")
        direct = json.loads(distribution.read_text("direct_url.json") or "{}")
        if distribution.version != "0.1.17" or direct.get("vcs_info", {}).get("commit_id") != CORE_SHA:
            raise CorePatchError("core_patch_base_commit_mismatch")
        path = Path(distribution.locate_file(SDK_FILE))
        if path.is_symlink() or not path.resolve().is_relative_to(environment) or not path.is_file():
            raise CorePatchError("core_patch_target_outside_isolated_installation")
        module = sys.modules.get(SDK_MODULE)
        if module is not None and Path(module.__file__).resolve() != path.resolve():
            raise CorePatchError("loaded_core_module_origin_mismatch")
        return path
    except (importlib.metadata.PackageNotFoundError, ValueError, OSError) as exc:
        raise CorePatchError("core_patch_installation_unavailable") from exc


def read_patch() -> dict[str, Any]:
    if PATCH_FILE.is_symlink():
        raise CorePatchError("unsafe_core_patch_path")
    raw = PATCH_FILE.read_bytes()
    if sha256(raw) != PATCH_SHA256:
        raise CorePatchError("core_patch_digest_mismatch")
    patch = json.loads(raw)
    if (
        set(patch) != {"format", "profile", "base_commit", "file", "base_sha256", "patched_sha256", "edits"}
        or patch["format"] != "exact-replacements-v1" or patch["profile"] != PROFILE
        or patch["base_commit"] != CORE_SHA or patch["file"] != SDK_FILE
        or patch["base_sha256"] != BASE_FILE_SHA256 or patch["patched_sha256"] != PATCHED_FILE_SHA256
        or not isinstance(patch["edits"], list) or not patch["edits"]
    ):
        raise CorePatchError("core_patch_profile_mismatch")
    return patch


def transform(source: bytes, patch: dict[str, Any]) -> bytes:
    if sha256(source) != BASE_FILE_SHA256:
        raise CorePatchError("core_patch_unknown_source_file_hash")
    text = source.decode("utf-8")
    for replacement in patch["edits"]:
        if (
            set(replacement) != {"old", "new"}
            or not isinstance(replacement["old"], str) or not isinstance(replacement["new"], str)
            or not replacement["old"] or text.count(replacement["old"]) != 1
        ):
            raise CorePatchError("core_patch_context_mismatch")
        text = text.replace(replacement["old"], replacement["new"], 1)
    updated = text.encode("utf-8")
    if sha256(updated) != PATCHED_FILE_SHA256:
        raise CorePatchError("core_patch_result_hash_mismatch")
    ast.parse(text, filename=SDK_FILE)
    return updated


def attest_core_patch() -> dict[str, Any]:
    read_patch()
    target = installed_target()
    if sha256(target.read_bytes()) != PATCHED_FILE_SHA256:
        raise CorePatchError("core_patch_installed_file_hash_mismatch")
    return {
        "profile": PROFILE,
        "base_commit": CORE_SHA,
        "patch_sha256": PATCH_SHA256,
        "files": {SDK_FILE: {"base_sha256": BASE_FILE_SHA256, "patched_sha256": PATCHED_FILE_SHA256}},
        "source_modified": True,
    }


def prepare_core() -> dict[str, Any]:
    patch = read_patch()
    target = installed_target()
    lock = SERVICE_ROOT / ".venv" / ".cityshift-core-patch.lock"
    if lock.is_symlink():
        raise CorePatchError("unsafe_core_patch_lock")
    with lock.open("a+b") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        current = target.read_bytes()
        current_hash = sha256(current)
        if current_hash == PATCHED_FILE_SHA256:
            return attest_core_patch()
        if current_hash != BASE_FILE_SHA256:
            raise CorePatchError("core_patch_unknown_source_file_hash")
        if SDK_MODULE in sys.modules:
            raise CorePatchError("core_already_loaded_prepare_before_import")
        updated = transform(current, patch)
        if sha256(updated) != PATCHED_FILE_SHA256:
            raise CorePatchError("core_patch_result_hash_mismatch")
        descriptor, name = tempfile.mkstemp(prefix=".cityshift-core-", dir=target.parent)
        temporary = Path(name)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(updated)
                stream.flush()
                os.fsync(stream.fileno())
                os.fchmod(stream.fileno(), stat.S_IMODE(target.stat().st_mode))
            temporary.replace(target)
            directory = os.open(target.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            temporary.unlink(missing_ok=True)
    return attest_core_patch()


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Prepare the reviewed Core patch after uv sync --locked --python 3.12; "
            "only swarm_service/.venv is writable."
        ),
    )
    parser.add_argument("--check", action="store_true", help="Verify the installed patch without changing files")
    parser.add_argument(
        "--audit", action="store_true", help="Print source, candidate, and patch digests without installation",
    )
    parser.add_argument(
        "--show-diff", action="store_true", help="Display the exact reviewed source changes without installation",
    )
    arguments = parser.parse_args()
    try:
        if arguments.audit or arguments.show_diff:
            target = installed_target()
            source = target.read_bytes()
            patch = read_patch()
            if sha256(source) != BASE_FILE_SHA256:
                raise CorePatchError("audit_requires_the_unmodified_pinned_installation")
            updated = transform(source, patch)
            if arguments.show_diff:
                print("".join(difflib.unified_diff(
                    source.decode().splitlines(keepends=True), updated.decode().splitlines(keepends=True),
                    fromfile=f"a/{SDK_FILE}", tofile=f"b/{SDK_FILE}",
                )), end="")
            else:
                print(json.dumps({"base_commit": CORE_SHA, "file": SDK_FILE, "profile": PROFILE,
                                  "base_sha256": sha256(source), "patched_sha256": sha256(updated),
                                  "patch_sha256": sha256(PATCH_FILE.read_bytes())}, sort_keys=True))
        else:
            result = attest_core_patch() if arguments.check else prepare_core()
            print(json.dumps(result, sort_keys=True))
    except (CorePatchError, OSError, ValueError) as exc:
        parser.exit(1, f"Core preparation refused: {exc}\n")


if __name__ == "__main__":
    main()
