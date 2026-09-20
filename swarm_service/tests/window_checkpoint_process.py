import asyncio
import json
import os
import socket
import sys
from pathlib import Path

from projection_packets import FAILED_EPOCHS, large_actor_packet

from cityshift_swarm.checkpointing import canonical
from cityshift_swarm.contracts import CheckpointBoundary, DecisionRequest, RunRequest
from cityshift_swarm.native import NativeHost
from cityshift_swarm.settings import MODEL_WINDOW_ROUNDS, Settings

RESIDENTS = [f"window-person-{index}" for index in range(3)]
TURN_COUNT = 24
SPLIT = TURN_COUNT // 2
MOCK_INPUT_TOKENS = 15990
MOCK_OUTPUT_TOKENS = 10
MOCK_TOKENS_PER_CALL = MOCK_INPUT_TOKENS + MOCK_OUTPUT_TOKENS


def packets_in(value):
    packets = []
    if isinstance(value, list):
        for item in value:
            packets.extend(packets_in(item))
    elif isinstance(value, dict):
        if value.get("role") == "user":
            text = value.get("content") or ""
            if isinstance(text, list):
                text = "".join(item.get("text", "") for item in text)
            start = text.find('{"instruction"')
            if start >= 0:
                packets.append(json.JSONDecoder().raw_decode(text[start:])[0]["observation"])
        for item in value.values():
            if isinstance(item, (list, dict)):
                packets.extend(packets_in(item))
    return packets


def assert_native_history(control, expected_epochs):
    assert set(control.native_sessions) == set(RESIDENTS)
    counts = {}
    for resident, session in control.native_sessions.items():
        context = json.loads(canonical(session.get_state("context")))
        packets = packets_in(context)
        assert {packet["epoch"] for packet in packets} == set(expected_epochs)
        assert all(packet["resident_id"] == resident for packet in packets)
        serialized = json.dumps(context)
        assert f"window-tool-only[{resident}]-epoch-0" in serialized
        for other in set(RESIDENTS) - {resident}:
            assert f"window-tool-only[{other}]" not in serialized
            assert f"window-private[{other}]" not in serialized
        counts[resident] = len(packets)
    return counts


async def run():
    root, phase, base = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    large = len(sys.argv) > 4 and sys.argv[4] == "large"
    settings = Settings(root=root, gateway_url=f"{base}/v1", city_bridge_url=base,
                        control_token="test-controller-" + "a" * 32,
                        gateway_token=f"test-gateway-window-{phase}-" + "b" * 32)
    settings.isolate_environment()
    settings.write_native_config()
    os.chdir(root)
    port = int(base.rsplit(":", 1)[1])
    original_connect = socket.socket.connect

    def local_double_only(sock, address):
        assert address == ("127.0.0.1", port), "non-test connection attempted"
        return original_connect(sock, address)

    socket.socket.connect = local_double_only
    request = RunRequest.model_validate({
        "run_id": "native-window-proof",
        "residents": [{"resident_id": resident, "model_id": "window-local-double",
                       "instructions": f"Synthetic isolated resident {resident}. No live inference in this test."}
                      for resident in RESIDENTS],
        "models": [{"model_id": "window-local-double", "api_base": settings.gateway_url,
                    "api_key_env": "CITYSHIFT_SWARM_GATEWAY_TOKEN"}],
        "budget": {"max_concurrency": 3, "max_iterations": 6, "decision_timeout_s": 30, "max_tokens": 20_000_000},
        "city_bridge_url": base,
    })
    host = NativeHost(settings)
    await host.initialize()
    assert host.available, host.error
    assert host.health()["resident_context"]["model_window_rounds"] == MODEL_WINDOW_ROUNDS == 2
    previous = None
    try:
        if phase == "second":
            previous = json.loads((root / "first.json").read_text())
            checkpoint = previous["checkpoint"]
            request = RunRequest.model_validate(request.model_dump() | {
                "resume_checkpoint": checkpoint["checkpoint_id"],
                "resume_boundary": {key: checkpoint[key] for key in (
                    "epoch", "t", "world_version", "world_state_hash", "checkpoint_hash",
                )},
            })
        start = await host.start(request)
        control = host.runs[request.run_id].control
        assert control.native_budget.total == control.workflow_budget.total == request.budget.max_tokens == 20_000_000
        if previous is not None:
            assert start["generation"] == 1
            assert start["native_tokens_spent"] == previous["checkpoint"]["native_tokens_spent"]
        identities = previous["bindings"] if previous else None
        first, last = (0, SPLIT) if phase == "first" else (SPLIT, TURN_COUNT)
        for epoch in range(first, last):
            packets = [{
                "run_id": request.run_id, "resident_id": resident, "epoch": epoch, "t": epoch * 30,
                "world_version": epoch, "memories": [f"window-private[{resident}]"],
                "state": {"synthetic_payload": "bounded-visible-window-fixture-" + "x" * 6000},
            } for resident in RESIDENTS]
            if large:
                packets = [large_actor_packet(resident, epoch) for resident in RESIDENTS]
                assert all(33000 < len(json.dumps(packet).encode()) <= 65536 for packet in packets)
            response = await host.decisions(request.run_id, DecisionRequest(
                epoch=epoch, t=epoch * 30, world_version=epoch, observations=packets,
            ))
            for row in response.decisions:
                expected_failure = large and row.resident_id == RESIDENTS[0] and epoch in FAILED_EPOCHS
                assert (row.decision is None) == expected_failure, response.model_dump()
            if large:
                saved_packets = control.history[-1]["request"]["observations"]
                assert saved_packets == packets
                assert all(len(packet["memories"]) == 64 and len(packet["messages"]) == 24
                           and len(packet["tasks"]) == 32 for packet in saved_packets)
            current = {row.resident_id: row.binding.model_dump() for row in response.decisions}
            identities = current if identities is None else identities
            assert current == identities
            assert_native_history(control, range(epoch + 1))
        counts = assert_native_history(control, range(last))
        manager = control.backend._sessions()
        for session in manager._sessions.values():
            native = session.harness.get_deep_agent()
            assert native._react_agent.config.model_config_obj.max_tokens is None
            config = native._react_agent.config.context_engine_config
            assert config.default_window_round_num == 2
            assert config.max_context_message_num is None
            assert config.default_window_message_num is None
            assert not config.enable_reload and not config.compression_recall_config.enabled
            assert "ContextProcessorRail" not in {type(rail).__name__ for rail in native.configured_rails()}
        checkpoint = await host.checkpoint(request.run_id, CheckpointBoundary(
            epoch=last - 1, t=(last - 1) * 30, world_version=last - 1, world_state_hash="ab" * 32,
        ))
        failed_turns = len(FAILED_EPOCHS & set(range(last))) if large else 0
        assert checkpoint.native_tokens_spent == (last * len(RESIDENTS) - failed_turns) * 3 * MOCK_TOKENS_PER_CALL
        assert 1_000_000 < checkpoint.native_tokens_spent < request.budget.max_tokens
        manifest = json.loads((root / "checkpoints" / checkpoint.checkpoint_id / "manifest.json").read_text())
        assert manifest["session_tokens_spent"] == manifest["workflow_tokens_spent"] == checkpoint.native_tokens_spent
        assert set(manifest["context_hashes"]) == set(RESIDENTS)
        assert manifest["core_patch"] == host.health()["sources"]["openjiuwen"]["patch"]
        durable_bytes = {resident: len(canonical(session.get_state("context")))
                         for resident, session in control.native_sessions.items()}
        assert all(size > 65536 for size in durable_bytes.values())
        (root / f"{phase}.json").write_text(json.dumps({
            "pid": os.getpid(), "checkpoint": checkpoint.model_dump(), "bindings": identities,
            "durable_rounds": counts, "label": "LOCAL model/bridge double; actual pinned native SDK",
            "live_model_evidence": False, "invoice_evidence": False, "durable_context_bytes": durable_bytes,
        }))
    finally:
        await host.close()
        from openjiuwen.core.runner import Runner

        assert not await Runner.list_active_teams()
        assert all(run.cleaned for run in host.runs.values())


if __name__ == "__main__":
    asyncio.run(run())
