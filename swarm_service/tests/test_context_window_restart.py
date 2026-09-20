import asyncio
import json
import os
import sys
from collections import Counter
from pathlib import Path

import pytest
from aiohttp import web
from local_gateway_double import LocalGatewayAndBridgeTestDouble, assert_decision_tool_schemas
from projection_packets import FAILED_EPOCHS, large_actor_packet
from window_checkpoint_process import (
    MOCK_INPUT_TOKENS,
    MOCK_OUTPUT_TOKENS,
    MOCK_TOKENS_PER_CALL,
    RESIDENTS,
    SPLIT,
    TURN_COUNT,
    packets_in,
)


def test_pinned_spec_json_round_trip_requires_typed_context_config_at_runtime_boundary():
    from cityshift_swarm.prepare import prepare_core

    prepare_core()
    from openjiuwen.agent_teams.schema.deep_agent_spec import DeepAgentSpec
    from openjiuwen.core.context_engine.schema.config import ContextEngineConfig
    from openjiuwen.core.single_agent.agents.react_agent import ReActAgent, ReActAgentConfig

    spec = DeepAgentSpec(context_engine_config=ContextEngineConfig(default_window_round_num=2))
    restored = DeepAgentSpec.model_validate_json(spec.model_dump_json())
    assert isinstance(restored.context_engine_config, dict)
    config = ReActAgentConfig(model_name="local-window-test-double")
    config.context_engine_config = restored.context_engine_config
    with pytest.raises(AttributeError, match="model_copy"):
        ReActAgent._with_context_engine_model_name(config)
    config.context_engine_config = ContextEngineConfig.model_validate(restored.context_engine_config)
    assert ReActAgent._with_context_engine_model_name(config).context_engine_config.default_window_round_num == 2


def assert_tool_groups(messages):
    pending = set()
    seen = set()
    for message in messages:
        if message["role"] == "tool":
            call_id = message["tool_call_id"]
            assert call_id in pending, "native window has an orphan tool result"
            pending.remove(call_id)
            continue
        assert not pending, "native window split an assistant/tool group"
        for call in message.get("tool_calls", []):
            assert call["id"] not in seen
            seen.add(call["id"])
            pending.add(call["id"])
    assert not pending


class WindowGatewayAndBridgeDouble(LocalGatewayAndBridgeTestDouble):
    def __init__(self, large=False):
        super().__init__()
        self.large = large
        self.calls = []
        self.errors = []
        self.observations = {}
        self.request_sizes = []
        self.counts = Counter()
        self.raw_tokens = set()

    async def tool(self, request):
        token = request.headers["Authorization"].removeprefix("Bearer ")
        scope = self.capabilities[token]
        data = await request.json()
        assert scope["worker_id"] == data["worker_id"]
        assert self.observations[scope["resident_id"]]["epoch"] == data["epoch"]
        if data["name"] == "view_tasks":
            return web.json_response([])
        if data["name"] == "observe_local_state":
            packet = self.observations[scope["resident_id"]]
            if self.large:
                packet = {key: value for key, value in large_actor_packet(scope["resident_id"], data["epoch"]).items()
                          if key not in {"memories", "tasks", "trip_options"}}
            return web.json_response(packet | {
                "tool_private": f"window-tool-only[{scope['resident_id']}]-epoch-{data['epoch']}",
            })
        return await super().tool(request)

    async def completion(self, request):
        self.request_sizes.append(request.content_length)
        try:
            raw = await request.read()
            assert len(raw) <= 65536
            data = json.loads(raw)
            assert_decision_tool_schemas(data)
            assert "max_tokens" not in data and "max_completion_tokens" not in data
            token = request.headers["Authorization"]
            assert token.startswith("Bearer test-gateway-window-")
            self.raw_tokens.add(token)
            messages = data["messages"]
            assert_tool_groups(messages)
            packets = packets_in(messages)
            latest = packets[-1]
            resident, epoch = latest["resident_id"], latest["epoch"]
            if self.large:
                assert len(packets) <= 2, [packet["epoch"] for packet in packets]
                original = large_actor_packet(resident, epoch)
                assert latest["memories"] == original["memories"][-8:]
                assert latest["messages"] == original["messages"][-4:]
                assert len(latest["tasks"]) == 8
                assert [task["task_id"] for task in latest["tasks"][:3]] == [
                    original["tasks"][index]["task_id"] for index in (30, 31, 28)
                ]
                assert "most recent 8 memories and 4 messages" in json.dumps(messages)
            else:
                assert [packet["epoch"] for packet in packets] == list(range(max(0, epoch - 1), epoch + 1))
            assert all(packet["resident_id"] == resident for packet in packets)
            encoded = json.dumps(messages)
            assert f"window-private[{resident}]" in encoded
            for other in set(RESIDENTS) - {resident}:
                assert f"window-private[{other}]" not in encoded
                assert f"window-tool-only[{other}]" not in encoded
            previous = packets[-2]["epoch"] if len(packets) >= 2 else None
            if previous is not None and previous < epoch and not (
                self.large and resident == RESIDENTS[0] and previous in FAILED_EPOCHS
            ):
                assert f"window-tool-only[{resident}]-epoch-{previous}" in encoded
            if epoch >= 2:
                assert f"window-tool-only[{resident}]-epoch-0" not in encoded
            self.observations[resident] = latest
            if self.large and resident == RESIDENTS[0] and epoch in FAILED_EPOCHS:
                self.counts[(resident, epoch, "failure")] += 1
                self.calls.append({"resident": resident, "epoch": epoch, "stage": "failure", "bytes": len(raw),
                                   "visible_rounds": len(packets)})
                return web.json_response({"error": {"message": "Explicit local incomplete-turn fixture.",
                                                    "type": "server_error"}}, status=503)
            ids = {name: f"window-{resident}-{epoch}-{name}" for name in ("observe", "tasks", "propose", "result")}
            replies = {message["tool_call_id"] for message in messages if message["role"] == "tool"}
            choice = {
                "proposal": {"action": "wait", "idempotency_key": f"window-{resident}-{epoch}"},
                "summary": "LOCAL model double; window protocol evidence, not live cognition.",
                "plan": ["wait"], "beliefs": [],
            }
            if ids["observe"] not in replies:
                stage = "observe"
                requests = [(ids["observe"], "observe_local_state", {})]
                if not self.large:
                    requests.append((ids["tasks"], "view_tasks", {}))
            elif ids["propose"] not in replies:
                stage = "propose"
                requests = [(ids["propose"], "propose_action", choice["proposal"])]
            else:
                stage = "structured"
                requests = [(ids["result"], "structured_output", choice)]
            self.counts[(resident, epoch, stage)] += 1
            self.calls.append({"resident": resident, "epoch": epoch, "stage": stage, "bytes": len(raw),
                               "visible_rounds": len(packets)})
            calls = [{"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}
                     for call_id, name, args in requests]
            if data.get("stream"):
                response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
                await response.prepare(request)
                common = {"id": f"window-test-{resident}-{epoch}-{stage}", "created": 1,
                          "object": "chat.completion.chunk", "model": data["model"]}
                frames = [
                    common | {"choices": [{"index": 0, "delta": {
                        "role": "assistant",
                        "tool_calls": [call | {"index": index} for index, call in enumerate(calls)],
                    }, "finish_reason": None}]},
                    common | {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
                              "usage": {"prompt_tokens": MOCK_INPUT_TOKENS, "completion_tokens": MOCK_OUTPUT_TOKENS,
                                        "total_tokens": MOCK_TOKENS_PER_CALL}},
                ]
                for frame in frames:
                    await response.write(f"data: {json.dumps(frame)}\n\n".encode())
                await response.write(b"data: [DONE]\n\n")
                await response.write_eof()
                return response
            return web.json_response({
                "id": f"window-test-{resident}-{epoch}-{stage}", "object": "chat.completion", "created": 1,
                "model": data["model"], "choices": [{"index": 0, "message": {
                    "role": "assistant", "content": None, "tool_calls": calls,
                }, "finish_reason": "tool_calls"}],
                "usage": {"prompt_tokens": MOCK_INPUT_TOKENS, "completion_tokens": MOCK_OUTPUT_TOKENS,
                          "total_tokens": MOCK_TOKENS_PER_CALL},
            })
        except (AssertionError, KeyError, ValueError, web.HTTPRequestEntityTooLarge) as exc:
            self.errors.append(str(exc))
            raise


@pytest.mark.parametrize("large", [False, True], ids=["baseline", "large-packet-incomplete-failures"])
async def test_native_two_round_window_retains_private_durable_history_across_cold_restart(tmp_path, large):
    double = WindowGatewayAndBridgeDouble(large)
    app = web.Application(client_max_size=65536)
    app.router.add_post("/v1/chat/completions", double.completion)
    app.router.add_post("/api/population/bridge/{run_id}/bind", double.bind)
    app.router.add_post("/api/population/bridge/{run_id}/tool", double.tool)
    server = web.AppRunner(app)
    await server.setup()
    site = web.TCPSite(server, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    script = Path(__file__).with_name("window_checkpoint_process.py")
    root = tmp_path / "windowed-native-sessions"
    env = {name: os.environ[name] for name in ("PATH", "LANG", "LC_ALL", "TMPDIR") if name in os.environ}
    phase_calls = 0
    try:
        for phase in ("first", "second"):
            process = await asyncio.create_subprocess_exec(
                sys.executable, str(script), str(root), phase, f"http://127.0.0.1:{port}",
                "large" if large else "baseline", env=env,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            try:
                async with asyncio.timeout(90):
                    output, error = await process.communicate()
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
            assert process.returncode == 0, ((output.decode() + error.decode())[-14000:], double.errors)
            if phase == "first":
                phase_calls = len(double.calls)
                if not large:
                    assert phase_calls == SPLIT * len(RESIDENTS) * 3
                assert len(double.capabilities) == len(RESIDENTS)
        assert not double.errors
        assert len(double.calls) <= TURN_COUNT * len(RESIDENTS) * 3
        assert {(call["resident"], call["epoch"]) for call in double.calls} == {
            (resident, epoch) for resident in RESIDENTS for epoch in range(TURN_COUNT)
        }
        for (resident, epoch, stage), count in double.counts.items():
            if large and resident == RESIDENTS[0] and epoch in FAILED_EPOCHS:
                assert stage == "failure" and 1 <= count <= 3
            else:
                assert stage in {"observe", "propose", "structured"} and count == 1
        failures = len(FAILED_EPOCHS) if large else 0
        assert sum(call["stage"] != "failure" for call in double.calls) == (TURN_COUNT * len(RESIDENTS) - failures) * 3
        assert len(double.staged) == (TURN_COUNT * len(RESIDENTS) - failures) * 2
        assert len(double.capabilities) == len(RESIDENTS) * 2
        assert len(double.raw_tokens) == 2
        assert all(0 < size <= 65536 for size in double.request_sizes)
        assert all(call["epoch"] >= SPLIT for call in double.calls[phase_calls:])
        assert max(call["visible_rounds"] for call in double.calls) == 2
        for stage in ("observe", "propose", "structured"):
            sizes = [call["bytes"] for call in double.calls if call["stage"] == stage and call["epoch"] >= 2]
            if not large:
                assert max(sizes) - min(sizes) < 2048, "model-visible history grew beyond the native window"
        first = json.loads((root / "first.json").read_text())
        second = json.loads((root / "second.json").read_text())
        assert first["pid"] != second["pid"]
        assert first["bindings"] == second["bindings"]
        for resident in RESIDENTS:
            first_failures = len(FAILED_EPOCHS & set(range(SPLIT))) if large and resident == RESIDENTS[0] else 0
            all_failures = len(FAILED_EPOCHS) if large and resident == RESIDENTS[0] else 0
            first_attempts = sum(call["resident"] == resident and call["stage"] == "failure"
                                 for call in double.calls[:phase_calls])
            all_attempts = sum(call["resident"] == resident and call["stage"] == "failure" for call in double.calls)
            assert first["durable_rounds"][resident] == SPLIT - first_failures + first_attempts
            assert second["durable_rounds"][resident] == TURN_COUNT - all_failures + all_attempts
        assert not first["live_model_evidence"] and not second["invoice_evidence"]
        (tmp_path / "context-window-local-double-evidence.json").write_text(json.dumps({
            "label": "LOCAL model and bridge doubles; actual native private sessions and restart",
            "live_model_evidence": False, "invoice_evidence": False, "native_residents": len(RESIDENTS),
            "turns_per_resident": TURN_COUNT, "outbound_requests": len(double.calls),
            "maximum_request_bytes": max(double.request_sizes), "gateway_limit_bytes": 65536,
            "model_visible_rounds": 2, "persisted_private_rounds": second["durable_rounds"],
            "persisted_private_context_bytes": second["durable_context_bytes"],
            "native_pids": [first["pid"], second["pid"]], "unexpected_model_calls": 0,
            "admitted_native_token_budget": 20_000_000,
            "mock_tokens_before_restart": first["checkpoint"]["native_tokens_spent"],
            "mock_tokens_after_restart": second["checkpoint"]["native_tokens_spent"],
            "large_actor_packets": large, "consecutive_failed_turns": failures,
            "failed_http_requests": sum(call["stage"] == "failure" for call in double.calls),
            "native_output_ceiling": "delegated_to_registered_gateway_limit",
        }, indent=2))
    finally:
        await server.cleanup()
