import ast
import asyncio
import copy
import json
import os
import shutil
import sys
from pathlib import Path

import pytest

from cityshift_swarm import prepare
from cityshift_swarm.native import installed_sources


@pytest.fixture
def base_source():
    source = prepare.installed_target().read_bytes()
    if prepare.sha256(source) == prepare.BASE_FILE_SHA256:
        return source
    assert prepare.sha256(source) == prepare.PATCHED_FILE_SHA256
    text = source.decode("utf-8")
    for edit in reversed(prepare.read_patch()["edits"]):
        assert text.count(edit["new"]) == 1
        text = text.replace(edit["new"], edit["old"], 1)
    source = text.encode("utf-8")
    assert prepare.sha256(source) == prepare.BASE_FILE_SHA256
    return source


def test_reviewed_patch_hashes_and_unchanged_single_shot_ast(base_source):
    source = base_source
    assert prepare.sha256(source) == prepare.BASE_FILE_SHA256
    updated = prepare.transform(source, prepare.read_patch())
    assert prepare.sha256(updated) == prepare.PATCHED_FILE_SHA256
    before = ast.parse(source)
    after = ast.parse(updated)
    unchanged = {"agent", "_call_backend", "_check_budget", "_check_abort", "_make_record", "parallel", "map_parallel"}

    def extract(tree):
        return [ast.dump(node) for node in tree.body if getattr(node, "name", None) in unchanged]

    assert extract(before) == extract(after)
    assert "openjiuwen==0.1.18" in (prepare.SERVICE_ROOT.parent / "backend" / "pyproject.toml").read_text()


def test_patch_rejects_unknown_source_and_unreviewed_results(base_source):
    source = base_source
    patch = prepare.read_patch()
    with pytest.raises(prepare.CorePatchError, match="unknown_source_file_hash"):
        prepare.transform(source + b"\n", patch)
    changed = copy.deepcopy(patch)
    changed["edits"][0]["new"] = changed["edits"][0]["new"].replace("False", "True")
    with pytest.raises(prepare.CorePatchError, match="result_hash_mismatch"):
        prepare.transform(source, changed)


def test_patch_digest_changes_fail_closed(tmp_path, monkeypatch):
    altered = tmp_path / "unreviewed.patch.json"
    altered.write_bytes(prepare.PATCH_FILE.read_bytes() + b" ")
    monkeypatch.setattr(prepare, "PATCH_FILE", altered)
    with pytest.raises(prepare.CorePatchError, match="digest_mismatch"):
        prepare.prepare_core()
    assert installed_sources()["verified"] is False


def test_installed_file_hash_changes_fail_closed_with_an_io_test_double(tmp_path, monkeypatch):
    unknown = tmp_path / "primitives.py"
    unknown.write_bytes(b"unexpected SDK contents")
    monkeypatch.setattr(prepare, "installed_target", lambda: unknown)
    with pytest.raises(prepare.CorePatchError, match="unknown_source_file_hash"):
        prepare.prepare_core()
    with pytest.raises(prepare.CorePatchError, match="installed_file_hash_mismatch"):
        prepare.attest_core_patch()
    assert unknown.read_bytes() == b"unexpected SDK contents"
    health = installed_sources()
    assert health["verified"] is False
    assert health["sources"]["openjiuwen"]["source_kind"] == "pinned_base_plus_reviewed_patch"


def test_preparation_is_idempotent_and_attests_modified_source():
    first = prepare.prepare_core()
    target = prepare.installed_target()
    before = target.stat()
    assert prepare.prepare_core() == first
    after = target.stat()
    assert (before.st_ino, before.st_mtime_ns) == (after.st_ino, after.st_mtime_ns)
    assert first["source_modified"] is True
    assert first["base_commit"] == prepare.CORE_SHA
    assert first["patch_sha256"] == prepare.PATCH_SHA256
    assert first["profile"] == prepare.PROFILE


async def test_base_regression_and_patched_sdk_semantics_in_separate_processes(tmp_path, base_source):
    script = Path(__file__).with_name("sdk_patch_probe.py")
    base_root = tmp_path / "pinned-core-base"
    package = prepare.installed_target().parents[3]
    shutil.copytree(package, base_root / "openjiuwen", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    (base_root / prepare.SDK_FILE).write_bytes(base_source)
    summaries = {}
    for profile in ("base", "patched"):
        env = {name: os.environ[name] for name in ("PATH", "LANG", "LC_ALL", "TMPDIR") if name in os.environ}
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        if profile == "base":
            env["PYTHONPATH"] = str(base_root)
        process = await asyncio.create_subprocess_exec(
            sys.executable, str(script), profile, str(tmp_path), str(base_root), env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            async with asyncio.timeout(60):
                output, error = await process.communicate()
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
        assert process.returncode == 0, (output.decode() + error.decode())[-10000:]
        summaries[profile] = json.loads(output.decode().strip().splitlines()[-1])
    assert summaries["base"]["failure_records"] == 0
    assert summaries["base"]["replay_calls"] == 8
    assert summaries["patched"]["failure_records"] == 2
    assert summaries["patched"]["replay_calls"] == 2
    assert summaries["patched"]["legacy_compatible"] is True
