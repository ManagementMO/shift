"""BackboardChat: OpenAI chat-completion requests onto Backboard's thread API, without the network."""

from __future__ import annotations

import json

import httpx
import pytest

from cityshift import providers
from cityshift.providers import BackboardChat, BackboardError


class FakeBackboard:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.responses: list[dict] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append((request.url.path, json.loads(request.content or b"{}")))
        return httpx.Response(200, json=self.responses.pop(0))


@pytest.fixture
def fake(monkeypatch):
    fb = FakeBackboard()
    transport = httpx.MockTransport(fb.handler)

    def post(url, **kw):
        with httpx.Client(transport=transport) as c:
            return c.post(url, **kw)

    monkeypatch.setattr(providers.httpx, "post", post)
    BackboardChat._threads.clear()
    return fb


def _client() -> BackboardChat:
    return BackboardChat(key="k", base="https://bb.test/api", llm_provider="openai", timeout=5)


def test_single_turn_maps_system_prompt_and_json_mode(fake):
    fake.responses = [{"status": "COMPLETED", "thread_id": "t1", "message_id": "m1", "content": '{"a": 1}',
                       "model_name": "gpt-4o", "model_provider": "openai", "input_tokens": 10, "output_tokens": 3, "total_tokens": 13}]
    out = _client().complete([{"role": "system", "content": "be terse"}, {"role": "user", "content": "hi"}], "gpt-4o", json_mode=True)
    path, body = fake.calls[0]
    assert path == "/api/threads/messages"
    assert body["system_prompt"] == "be terse" and body["content"] == "hi"
    assert body["json_output"] is True and body["memory"] == "off" and body["model_name"] == "gpt-4o"
    assert out["choices"][0]["message"]["content"] == '{"a": 1}'
    assert out["choices"][0]["finish_reason"] == "stop"
    assert out["usage"]["total_tokens"] == 13


def test_tool_round_trip_continues_the_same_thread(fake):
    tc = {"id": "call_1", "type": "function", "function": {"name": "evidence_claims", "arguments": "{}"}}
    fake.responses = [
        {"status": "REQUIRES_ACTION", "thread_id": "t2", "message_id": "m2", "content": None, "tool_calls": [tc]},
        {"status": "COMPLETED", "thread_id": "t2", "message_id": "m3", "content": "done"},
    ]
    tools = [{"type": "function", "function": {"name": "evidence_claims", "parameters": {"type": "object", "properties": {}}}}]
    c = _client()
    first = c.complete([{"role": "user", "content": "go"}], "gpt-4o", tools=tools)
    assert first["choices"][0]["finish_reason"] == "tool_calls"
    assert first["choices"][0]["message"]["tool_calls"] == [tc]
    assert fake.calls[0][1]["tools"] == tools

    second = c.complete([
        {"role": "user", "content": "go"},
        {"role": "assistant", "content": None, "tool_calls": [tc]},
        {"role": "tool", "tool_call_id": "call_1", "content": "[claim 1]"},
    ], "gpt-4o", tools=tools)
    path, body = fake.calls[1]
    assert path == "/api/threads/tool-outputs"
    assert body == {"thread_id": "t2", "tool_outputs": [{"tool_call_id": "call_1", "output": "[claim 1]"}]}
    assert second["choices"][0]["message"]["content"] == "done"


def test_unknown_tool_call_id_falls_back_to_flattened_transcript(fake):
    fake.responses = [{"status": "COMPLETED", "thread_id": "t3", "content": "ok"}]
    _client().complete([
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": None, "tool_calls": [{"id": "call_x", "type": "function", "function": {"name": "f", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "call_x", "content": "r"},
    ], "gpt-4o")
    path, body = fake.calls[0]
    assert path == "/api/threads/messages"
    assert "Tool result (call_x): r" in body["content"] and body["content"].endswith("Assistant:")


def test_failed_status_raises_with_provider_message(fake):
    fake.responses = [{"status": "FAILED", "thread_id": "t4", "content": "Add credits to continue"}]
    with pytest.raises(BackboardError, match="Add credits"):
        _client().complete([{"role": "user", "content": "hi"}], "gpt-4o")
