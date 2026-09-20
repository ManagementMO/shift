import asyncio
import json
import os
import socket
import sys
from pathlib import Path

from cityshift_swarm.contracts import CheckpointBoundary, DecisionRequest, RunRequest
from cityshift_swarm.control import RunConflict
from cityshift_swarm.native import NativeHost
from cityshift_swarm.settings import Settings


def request_for(settings):
    return RunRequest.model_validate({
        "run_id": "checkpoint-proof",
        "residents": [{"resident_id": f"person-{index}", "instructions": f"Private persona {index}",
                       "model_id": "alpha" if index % 2 == 0 else "beta"} for index in range(10)],
        "models": [{"model_id": name, "api_base": settings.gateway_url,
                    "api_key_env": "CITYSHIFT_SWARM_GATEWAY_TOKEN"} for name in ("alpha", "beta")],
        "budget": {"max_concurrency": 3, "max_iterations": 4, "decision_timeout_s": 30, "max_tokens": 10000},
        "city_bridge_url": settings.city_bridge_url,
    })


def boundary_for(epoch):
    return DecisionRequest(epoch=epoch, t=epoch * 30, world_version=epoch, observations=[
        {"run_id": "checkpoint-proof", "resident_id": f"person-{index}", "epoch": epoch,
         "t": epoch * 30, "world_version": epoch, "memories": [f"private-marker-person-{index}"]}
        for index in range(10)
    ])


def assert_private_native_histories(control):
    from cityshift_swarm.checkpointing import canonical

    residents = set(control.bindings)
    assert set(control.native_sessions) == residents
    for resident, session in control.native_sessions.items():
        serialized = canonical(session.get_state("context")).decode()
        assert f"tool-only-canary-{resident}-epoch-0" in serialized
        for other in residents - {resident}:
            assert f"tool-only-canary-{other}-epoch-" not in serialized
            assert f"private-marker-{other}" not in serialized


async def rejected(operation):
    try:
        await operation
    except RunConflict:
        return
    raise AssertionError("invalid checkpoint operation was accepted")


async def run():
    root = Path(sys.argv[1])
    phase = sys.argv[2]
    base = sys.argv[3]
    settings = Settings(root=root, gateway_url=f"{base}/v1", city_bridge_url=base,
                        control_token="test-controller-" + "a" * 32,
                        gateway_token=f"test-gateway-{phase}-" + "b" * 32)
    settings.isolate_environment()
    settings.write_native_config()
    os.chdir(settings.root)
    original_connect = socket.socket.connect
    port = int(base.rsplit(":", 1)[1])

    def test_only_connection(sock, address):
        if address != ("127.0.0.1", port):
            raise AssertionError("checkpoint proof attempted a non-test network connection")
        return original_connect(sock, address)

    socket.socket.connect = test_only_connection
    host = NativeHost(settings)
    await host.initialize()
    if host.startup_error is not None:
        raise host.startup_error
    assert host.available
    request = request_for(settings)
    try:
        if phase == "first":
            await host.start(request)
            candidate = CheckpointBoundary(epoch=0, t=0, world_version=0, world_state_hash="ab" * 32)
            await rejected(host.checkpoint(request.run_id, candidate))
            response = await host.decisions(request.run_id, boundary_for(0))
            assert all(row.decision is not None for row in response.decisions)
            pending = asyncio.create_task(host.decisions(request.run_id, boundary_for(1)))
            await asyncio.sleep(0)
            assert host.runs[request.run_id].control.inflight
            await rejected(host.checkpoint(request.run_id, candidate))
            response = await pending
            assert all(row.decision is not None for row in response.decisions)
            await rejected(host.checkpoint(request.run_id, candidate))
            native = host.runs[request.run_id].control
            assert_private_native_histories(native)
            tokens = [settings.gateway_token, settings.control_token]
            tokens.extend(scope.capability for scope in native.scopes.values() if scope.capability)
            marker = await host.decisions(request.run_id, DecisionRequest(
                epoch=2, t=60, world_version=2, observations=[],
            ))
            assert marker.decisions == [] and marker.native_tokens_spent == response.native_tokens_spent
            checkpoint = await host.checkpoint(request.run_id, CheckpointBoundary(
                epoch=2, t=60, world_version=2, world_state_hash="ab" * 32,
            ))
            assert native.status == "checkpointed"
            from cityshift_swarm.prepare import attest_core_patch

            manifest = json.loads((root / "checkpoints" / checkpoint.checkpoint_id / "manifest.json").read_text())
            assert manifest["core_patch"] == attest_core_patch()
            assert host.health()["sources"]["openjiuwen"]["patch"] == attest_core_patch()
            assert await host.checkpoint(request.run_id, CheckpointBoundary(
                epoch=2, t=60, world_version=2, world_state_hash="ab" * 32,
            )) == checkpoint
            try:
                await host.decisions(request.run_id, boundary_for(3))
                raise AssertionError("sealed run accepted another boundary")
            except RunConflict:
                pass
            from openjiuwen.core.runner import Runner
            from openjiuwen.core.session.agent_team import Session

            assert not await Runner.list_active_teams()
            session = Session(session_id=native.team_session_id, source_metadata_enabled=False)
            await session.pre_run()
            assert session.get_state("teams")[native.team_id]["spec"]
            encoded = json.dumps(session.get_state(), default=str)
            assert all(token not in encoded for token in tokens)
            for actor_session in native.native_sessions.values():
                encoded = json.dumps(actor_session.get_state(), default=str)
                assert all(token not in encoded for token in tokens)
            report = {"checkpoint": checkpoint.model_dump(), "response": response.model_dump(),
                      "pid": os.getpid()}
            (root / "first.json").write_text(json.dumps(report))
        else:
            previous = json.loads((root / "first.json").read_text())
            checkpoint = previous["checkpoint"]
            payload = request.model_dump() | {
                "resume_checkpoint": checkpoint["checkpoint_id"],
                "resume_boundary": {key: checkpoint[key] for key in (
                    "epoch", "t", "world_version", "world_state_hash", "checkpoint_hash",
                )},
            }
            altered = json.loads(json.dumps(payload))
            altered["residents"][0]["instructions"] = "Changed persona"
            try:
                await host.start(RunRequest.model_validate(altered))
                raise AssertionError("changed persona was restored")
            except RunConflict:
                pass
            for change in ("boundary", "model", "budget", "missing"):
                altered = json.loads(json.dumps(payload))
                if change == "boundary":
                    altered["resume_boundary"]["world_version"] += 1
                elif change == "model":
                    altered["residents"][0]["model_id"] = "beta"
                elif change == "budget":
                    altered["budget"]["max_tokens"] += 1
                else:
                    altered["resume_checkpoint"] = "cp_" + "0" * 32
                await rejected(host.start(RunRequest.model_validate(altered)))
            folder = root / "checkpoints" / checkpoint["checkpoint_id"]
            artifact = folder / "journal.jsonl.wal"
            original = artifact.read_bytes()
            artifact.write_bytes(original + b"corruption")
            await rejected(host.start(RunRequest.model_validate(payload)))
            artifact.write_bytes(original)
            artifact = folder / "boundaries.json"
            original = artifact.read_bytes()
            changed = json.loads(original)
            changed[0]["request"]["observations"][0]["memories"] = ["changed observation"]
            artifact.write_text(json.dumps(changed))
            await rejected(host.start(RunRequest.model_validate(payload)))
            artifact.write_bytes(original)
            from cityshift_swarm.checkpointing import digest

            artifact = folder / "manifest.json"
            original = artifact.read_bytes()
            changed = json.loads(original)
            changed["source_shas"]["openjiuwen"] = "0" * 40
            artifact.write_text(json.dumps(changed))
            altered = json.loads(json.dumps(payload))
            altered["resume_boundary"]["checkpoint_hash"] = digest(changed)
            await rejected(host.start(RunRequest.model_validate(altered)))
            artifact.write_bytes(original)
            changed = json.loads(original)
            changed["core_patch"]["patch_sha256"] = "0" * 64
            artifact.write_text(json.dumps(changed))
            altered = json.loads(json.dumps(payload))
            altered["resume_boundary"]["checkpoint_hash"] = digest(changed)
            await rejected(host.start(RunRequest.model_validate(altered)))
            artifact.write_bytes(original)
            assert not (folder / "claimed").exists()
            start = await host.start(RunRequest.model_validate(payload))
            assert start["native_tokens_spent"] == checkpoint["native_tokens_spent"]
            assert start["generation"] == 1
            try:
                await host.decisions(request.run_id, boundary_for(1))
                raise AssertionError("restored run accepted a stale boundary")
            except RunConflict:
                pass
            response = await host.decisions(request.run_id, boundary_for(3))
            assert all(row.decision is not None for row in response.decisions), response.model_dump()
            assert [row.binding.model_dump() for row in response.decisions] == [
                row["binding"] for row in previous["response"]["decisions"]
            ]
            control = host.runs[request.run_id].control
            assert_private_native_histories(control)
            assert len(control.restored_workers) == 10
            assert response.native_tokens_spent == checkpoint["native_tokens_spent"] + 400
            assert control.workflow_budget.spent == response.native_tokens_spent
            (root / "second.json").write_text(json.dumps({"response": response.model_dump(), "pid": os.getpid()}))
    finally:
        await host.close()
        from openjiuwen.core.runner import Runner

        assert not await Runner.list_active_teams()
        for native_run in host.runs.values():
            assert native_run.cleaned
            assert native_run.control.failure is None
            assert native_run.control.backend._sessions()._sessions == {}
            assert all(scope.capability is None for scope in native_run.control.scopes.values())
        assert host.root_lock is None


if __name__ == "__main__":
    asyncio.run(run())
