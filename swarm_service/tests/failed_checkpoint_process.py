import asyncio
import json
import os
import socket
import sys
from pathlib import Path

from checkpoint_process import assert_private_native_histories, boundary_for, request_for

from cityshift_swarm.contracts import CheckpointBoundary, RunRequest
from cityshift_swarm.control import RunConflict
from cityshift_swarm.native import NativeHost
from cityshift_swarm.settings import Settings

FAILURES = {("person-0", 0), ("person-0", 1), ("person-3", 1)}


async def run():
    root, phase, base = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    settings = Settings(root=root, gateway_url=f"{base}/v1", city_bridge_url=base,
                        control_token="test-controller-" + "a" * 32,
                        gateway_token=f"test-gateway-{phase}-" + "b" * 32)
    settings.isolate_environment()
    settings.write_native_config()
    os.chdir(root)
    port = int(base.rsplit(":", 1)[1])
    original_connect = socket.socket.connect

    def local_double_only(sock, address):
        assert address == ("127.0.0.1", port), "non-test connection attempted"
        return original_connect(sock, address)

    socket.socket.connect = local_double_only
    host = NativeHost(settings)
    await host.initialize()
    assert host.available, host.error
    request = request_for(settings)
    request.budget.max_iterations = 12
    try:
        if phase in {"baseline", "first"}:
            await host.start(request)
            responses = []
            for epoch in range(2):
                result = await host.decisions(request.run_id, boundary_for(epoch))
                for row in result.decisions:
                    assert (row.decision is None) == ((row.resident_id, epoch) in FAILURES), row.model_dump()
                    assert row.binding.worker_id and row.binding.session_id
                responses.append(result.model_dump())
            assert responses[-1]["native_tokens_spent"] == 920
            assert_private_native_histories(host.runs[request.run_id].control)
            boundary = CheckpointBoundary(epoch=1, t=30, world_version=1, world_state_hash="ef" * 32)
            if phase == "baseline":
                try:
                    await host.checkpoint(request.run_id, boundary)
                except RunConflict as exc:
                    assert str(exc) == "checkpoint_requires_complete_native_journal"
                else:
                    raise AssertionError("unpatched SDK unexpectedly checkpointed failed turns")
                (root / "baseline.json").write_text(json.dumps({"reproduced_409": True, "tokens": 920}))
                return
            checkpoint = await host.checkpoint(request.run_id, boundary)
            (root / "first.json").write_text(json.dumps({
                "checkpoint": checkpoint.model_dump(), "responses": responses, "pid": os.getpid(),
            }))
        else:
            previous = json.loads((root / "first.json").read_text())
            checkpoint = previous["checkpoint"]
            payload = request.model_dump() | {
                "resume_checkpoint": checkpoint["checkpoint_id"],
                "resume_boundary": {key: checkpoint[key] for key in (
                    "epoch", "t", "world_version", "world_state_hash", "checkpoint_hash",
                )},
            }
            started = await host.start(RunRequest.model_validate(payload))
            assert started["native_tokens_spent"] == 920
            control = host.runs[request.run_id].control
            assert control.workflow_budget.spent == 920
            for epoch in (2, 3):
                response = await host.decisions(request.run_id, boundary_for(epoch))
                assert all(row.decision is not None for row in response.decisions), response.model_dump()
                assert [row.binding.model_dump() for row in response.decisions] == [
                    row["binding"] for row in previous["responses"][-1]["decisions"]
                ]
            assert_private_native_histories(control)
            assert len(control.restored_workers) == 10
            assert response.native_tokens_spent == 1720
            assert control.workflow_budget.spent == 1720
            (root / "second.json").write_text(json.dumps({"pid": os.getpid(), "tokens": response.native_tokens_spent}))
    finally:
        await host.close()
        from openjiuwen.core.runner import Runner

        assert not await Runner.list_active_teams()
        assert all(run.cleaned and run.control.failure is None for run in host.runs.values())
        assert all(run.control.backend._sessions()._sessions == {} for run in host.runs.values())


if __name__ == "__main__":
    asyncio.run(run())
