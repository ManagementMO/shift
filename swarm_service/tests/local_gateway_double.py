import asyncio
import json
from dataclasses import replace

from aiohttp import web

from cityshift_swarm.contracts import ActionProposal, DecisionRequest, ResidentDecision, RunRequest
from cityshift_swarm.native import NativeHost


def assert_decision_tool_schemas(data):
    schemas = {tool["function"]["name"]: tool["function"]["parameters"] for tool in data["tools"]}
    for name, expected in (("structured_output", ResidentDecision.model_json_schema()),
                           ("propose_action", ActionProposal.model_json_schema())):
        actual = schemas[name]
        assert set(actual["properties"]) == set(expected["properties"]) | {"call_goal"}
        assert actual["properties"]["call_goal"]["type"] == "string"
        assert "call_goal" not in actual.get("required", [])
        without_display_goal = actual | {"properties": {
            key: value for key, value in actual["properties"].items() if key != "call_goal"
        }}
        assert without_display_goal == expected
    assert schemas["structured_output"]["properties"]["proposal"]["$ref"] == "#/$defs/ActionProposal"
    assert schemas["structured_output"]["$defs"]["ActionProposal"]["type"] == "object"
    assert schemas["structured_output"]["$defs"]["ActionProposal"]["additionalProperties"] is False


class LocalGatewayAndBridgeTestDouble:
    def __init__(self):
        self.capabilities = {}
        self.observations = {}
        self.calls = []
        self.staged = []
        self.active = 0
        self.peak = 0
        self.delay = 0.02
        self.auto_epochs = False
        self.require_tool_history = False
        self.authorizations = []
        self.failed_turns = set()
        self.malformed_proposal_turns = set()
        self.observed_turns = set()

    async def bind(self, request):
        data = await request.json()
        assert request.headers["Authorization"].startswith("Bearer test-controller-")
        capability = f"test-capability-{len(self.capabilities)}-{data['worker_id']}"
        self.capabilities[capability] = data
        return web.json_response({"capability": capability})

    async def tool(self, request):
        token = request.headers["Authorization"].removeprefix("Bearer ")
        scope = self.capabilities[token]
        data = await request.json()
        assert data["worker_id"] == scope["worker_id"]
        packet = self.observations[scope["resident_id"]]
        assert data["epoch"] == packet["epoch"]
        if data["name"] == "observe_local_state":
            self.observed_turns.add((scope["resident_id"], data["epoch"]))
            if self.require_tool_history:
                return web.json_response(packet | {
                    "tool_private": f"tool-only-canary-{scope['resident_id']}-epoch-{packet['epoch']}",
                })
            return web.json_response(packet)
        assert data["name"] == "propose_action"
        self.staged.append((scope["resident_id"], data["epoch"], data["arguments"]))
        return web.json_response({"status": "proposed"})

    async def completion(self, request):
        data = await request.json()
        assert request.headers["Authorization"].startswith("Bearer test-gateway-")
        self.authorizations.append(request.headers["Authorization"])
        messages = data["messages"]
        packets = []
        for message in messages:
            if message["role"] != "user":
                continue
            text = message["content"]
            if isinstance(text, list):
                text = "".join(part.get("text", "") for part in text)
            start = text.find('{"instruction"')
            if start >= 0:
                packets.append(json.JSONDecoder().raw_decode(text[start:])[0]["observation"])
        assert packets
        latest = packets[-1]
        resident = latest["resident_id"]
        if self.auto_epochs:
            self.observations[resident] = latest
        assert all(packet["resident_id"] == resident for packet in packets)
        raw_messages = json.dumps(messages)
        for candidate in self.observations:
            if candidate != resident:
                assert f"private-marker-{candidate}" not in raw_messages
                assert f"tool-only-canary-{candidate}" not in raw_messages
        if self.require_tool_history and len(packets) >= 2:
            previous = packets[-2]["epoch"]
            if previous < latest["epoch"] and (resident, previous) not in self.failed_turns:
                assert f"tool-only-canary-{resident}-epoch-{previous}" in raw_messages
        self.calls.append((resident, latest["epoch"], len(packets), data["model"]))
        allowed = {
            "observe_local_state", "recall_experience", "view_tasks", "estimate_trip", "propose_action",
            "propose_message", "structured_output",
        }
        assert {tool["function"]["name"] for tool in data["tools"]} == allowed
        assert_decision_tool_schemas(data)
        name = "observe_local_state"
        arguments = {}
        if messages[-1]["role"] == "tool":
            name = "structured_output"
            arguments = {
                "proposal": {"action": "wait", "idempotency_key": f"{resident}-{latest['epoch']}"},
                "summary": "Deterministic local test-double output, not model cognition.",
                "plan": ["wait"], "beliefs": [],
            }
        tool_call = {
            "id": f"call-{resident}-{latest['epoch']}-{name}", "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments)},
        }
        turn = (resident, latest["epoch"])
        failure = turn in self.failed_turns and turn in self.observed_turns
        message = {"role": "assistant", "content": None, "tool_calls": [tool_call]}
        delta = {"role": "assistant", "tool_calls": [tool_call | {"index": 0}]}
        finish = "tool_calls"
        if failure and turn in self.malformed_proposal_turns:
            tool_call = {
                "id": f"invalid-proposal-{resident}-{latest['epoch']}-{len(self.calls)}", "type": "function",
                "function": {"name": "structured_output", "arguments": json.dumps({
                    "proposal": "travel(action='travel', target_id='fixture-anchor', travel_class='bicycle')",
                    "summary": "Deliberately malformed local-test action object.", "plan": [], "beliefs": [],
                })},
            }
            message = {"role": "assistant", "content": None, "tool_calls": [tool_call]}
            delta = {"role": "assistant", "tool_calls": [tool_call | {"index": 0}]}
        elif failure:
            message = {"role": "assistant", "content": "Deliberately missing structured output in a local test double."}
            delta = dict(message)
            finish = "stop"
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            await asyncio.sleep(self.delay)
            if data.get("stream"):
                response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
                await response.prepare(request)
                common = {"id": "test-completion", "object": "chat.completion.chunk", "created": 1,
                          "model": data["model"]}
                frames = [
                    common | {"choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                    common | {"choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                              "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}},
                ]
                for frame in frames:
                    await response.write(f"data: {json.dumps(frame)}\n\n".encode())
                await response.write(b"data: [DONE]\n\n")
                await response.write_eof()
                return response
            return web.json_response({
                "id": "test-completion", "object": "chat.completion", "created": 1, "model": data["model"],
                "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20},
            })
        finally:
            self.active -= 1


async def exercise_local_gateway_test_double(settings, monkeypatch, original_connect):
    double = LocalGatewayAndBridgeTestDouble()
    app = web.Application()
    app.router.add_post("/v1/chat/completions", double.completion)
    app.router.add_post("/api/population/bridge/{run_id}/bind", double.bind)
    app.router.add_post("/api/population/bridge/{run_id}/tool", double.tool)
    server = web.AppRunner(app)
    await server.setup()
    site = web.TCPSite(server, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]

    def only_test_server(sock, address):
        assert address == ("127.0.0.1", port), "Test attempted to contact something other than the local double"
        return original_connect(sock, address)

    import socket

    monkeypatch.setattr(socket.socket, "connect", only_test_server)
    settings = replace(settings, gateway_url=f"http://127.0.0.1:{port}/v1", city_bridge_url=f"http://127.0.0.1:{port}")
    host = NativeHost(settings)
    await host.initialize()
    residents = [{"resident_id": f"person-{index}", "instructions": f"Private persona {index}",
                  "model_id": "alpha" if index % 2 == 0 else "beta"} for index in range(10)]
    request = RunRequest.model_validate({
        "run_id": "test-double-turns", "residents": residents,
        "models": [{"model_id": name, "api_base": settings.gateway_url,
                    "api_key_env": "CITYSHIFT_SWARM_GATEWAY_TOKEN"} for name in ("alpha", "beta")],
        "budget": {"max_concurrency": 3, "max_iterations": 4, "decision_timeout_s": 30, "max_tokens": 10000},
        "city_bridge_url": settings.city_bridge_url,
    })
    identities = None
    try:
        await host.start(request)
        for epoch in range(3):
            observations = [{"run_id": request.run_id, "resident_id": resident["resident_id"],
                             "epoch": epoch, "t": epoch * 30, "world_version": epoch,
                             "memories": [f"private-marker-{resident['resident_id']}"]} for resident in residents]
            double.observations = {packet["resident_id"]: packet for packet in observations}
            boundary = DecisionRequest(epoch=epoch, t=epoch * 30, world_version=epoch, observations=observations)
            response = await host.decisions(request.run_id, boundary)
            assert len(response.decisions) == 10
            assert all(row.decision is not None for row in response.decisions), response.model_dump()
            current = [(row.binding.worker_id, row.binding.session_id) for row in response.decisions]
            assert all(worker and session for worker, session in current)
            if identities is None:
                identities = current
            else:
                assert current == identities
            assert all(row.binding.requested_model_id == row.binding.resolved_model_id for row in response.decisions)
            assert all(row.usage.total_tokens > 0 for row in response.decisions)
        assert len(double.calls) == 60
        assert len(double.staged) == 30
        assert double.peak == 3
        assert len({resident for resident, _, _, _ in double.calls}) == 10
        assert all(history_count == min(epoch + 1, 2) for _, epoch, history_count, _ in double.calls)
        from cityshift_swarm.checkpointing import canonical

        for resident, session in host.runs[request.run_id].control.native_sessions.items():
            context = canonical(session.get_state("context")).decode()
            assert all(f'"epoch": {epoch}' in context or f'\\"epoch\\": {epoch}' in context for epoch in range(3))
            assert f"private-marker-{resident}" in context
        await host.stop(request.run_id)
        for mode, limits in (
            ("tokens", {"max_tokens": 25}),
            ("iterations", {"max_iterations": 1}),
            ("timeout", {"decision_timeout_s": 1}),
        ):
            payload = request.model_dump()
            payload["run_id"] = f"test-double-{mode}"
            payload["residents"] = payload["residents"][:2]
            payload["budget"].update(limits)
            limited = RunRequest.model_validate(payload)
            await host.start(limited)
            observations = [{"run_id": limited.run_id, "resident_id": resident.resident_id,
                             "epoch": 0, "t": 0, "world_version": 0} for resident in limited.residents]
            double.observations = {packet["resident_id"]: packet for packet in observations}
            double.delay = 1.5 if mode == "timeout" else 0.02
            before = len(double.calls)
            boundary = DecisionRequest(epoch=0, t=0, world_version=0, observations=observations)
            response = await host.decisions(limited.run_id, boundary)
            assert len(response.decisions) == 2
            assert all(row.decision is None and row.fallback_reason for row in response.decisions)
            assert len(double.calls) - before <= 2
            if mode == "tokens":
                assert response.native_tokens_spent >= limited.budget.max_tokens
            if mode == "iterations":
                assert all(row.usage.model_calls <= 1 for row in response.decisions)
                assert sum(row.usage.total_tokens for row in response.decisions) > 0
            if mode == "timeout":
                assert host.runs[limited.run_id].cleaned
                assert all(row.fallback_reason == "decision_timeout" for row in response.decisions)
            await host.stop(limited.run_id)
            assert host.runs[limited.run_id].control.backend._sessions()._sessions == {}
    finally:
        await host.close()
        await server.cleanup()
