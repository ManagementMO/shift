from __future__ import annotations

import asyncio
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from decimal import Decimal, localcontext
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from cityshift.agents.population_gateway import (
    DEFAULT_LEDGER_PATH,
    SESSION_CAP_MICRODOLLARS,
    GatewayError,
    PopulationGateway,
    RunLimits,
    get_population_gateway,
)
from cityshift.api.population_gateway_router import router
from cityshift.providers import POPULATION_MODELS, PopulationProviderConfig, population_provider_config

MODEL = "openai/gpt-4.1-mini"
UPSTREAM_SECRET = "test-upstream-key-never-diagnostic"
LOCAL_SECRET = "test-local-token-never-diagnostic-0123456789"
PROMPT_SECRET = "private-resident-history-never-diagnostic"
KEY_LABEL_SECRET = "provider-key-label-never-diagnostic"
KEY_IDENTITY_SECRET = "provider-user-identity-never-diagnostic"


def key_metadata(**updates: Any) -> dict[str, Any]:
    return {"data": {
        "limit": 20, "limit_remaining": 20, "usage": 0, "limit_reset": None,
        "include_byok_in_limit": True, "byok_usage": 0,
        "is_management_key": False, "is_provisioning_key": False,
        "is_free_tier": False, "expires_at": None,
        "label": KEY_LABEL_SECRET, "creator_user_id": KEY_IDENTITY_SECRET,
        "organization_id": KEY_IDENTITY_SECRET, "workspace_id": KEY_IDENTITY_SECRET,
        **updates,
    }}


def request_body(**updates: Any) -> dict[str, Any]:
    return {"model": MODEL, "messages": [{"role": "user", "content": PROMPT_SECRET}], **updates}


def completion(**updates: Any) -> dict[str, Any]:
    return {
        "id": "gen-test",
        "object": "chat.completion",
        "created": 1,
        "model": MODEL,
        "provider": "OpenAI",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "wait"},
                     "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12,
                  "cost": "0.0000072"},
        **updates,
    }


class FakeOpenRouter:
    def __init__(self) -> None:
        self.posts: list[httpx.Request] = []
        self.gets: list[httpx.Request] = []
        self.key_gets: list[httpx.Request] = []
        self.expected_key = UPSTREAM_SECRET
        self.key_info = key_metadata()
        self.key_status = 200
        self.key_failure: str | None = None
        self.output = completion()
        self.status = 200
        self.failure: str | None = None
        self.delay = 0.0
        self.catalog = {key: model.catalog_entry() for key, model in POPULATION_MODELS.items()}
        self.endpoints = {key: model.endpoint_entry() for key, model in POPULATION_MODELS.items()}
        self.additional_endpoints: dict[str, list[dict[str, Any]]] = {}

    async def handle(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path == "/api/v1/key":
            self.key_gets.append(request)
            assert request.headers["authorization"] == f"Bearer {self.expected_key}"
            assert request.url.query == b"" and not request.content
            if self.key_failure == "slow":
                await asyncio.sleep(5)
            if self.key_failure == "timeout":
                raise httpx.ReadTimeout(KEY_LABEL_SECRET + UPSTREAM_SECRET, request=request)
            if self.key_failure == "invalid_json":
                return httpx.Response(200, content=(KEY_LABEL_SECRET + KEY_IDENTITY_SECRET).encode())
            if self.key_failure == "oversized":
                return httpx.Response(200, content=b"x" * 65537)
            return httpx.Response(self.key_status, json=self.key_info)
        if request.method == "GET":
            self.gets.append(request)
            assert "authorization" not in request.headers
            if request.url.path == "/api/v1/models":
                return httpx.Response(200, json={"data": list(self.catalog.values())})
            for key, endpoint in self.endpoints.items():
                if request.url.path == f"/api/v1/models/{key}/endpoints":
                    return httpx.Response(200, json={"data": {
                        "endpoints": [endpoint, *self.additional_endpoints.get(key, [])],
                    }})
            raise AssertionError("unexpected catalog request")
        assert request.method == "POST" and request.url.path == "/api/v1/chat/completions"
        assert request.headers["authorization"] == f"Bearer {self.expected_key}"
        self.posts.append(request)
        await asyncio.sleep(self.delay)
        if self.failure == "timeout":
            raise httpx.ReadTimeout(UPSTREAM_SECRET + PROMPT_SECRET, request=request)
        if self.failure == "network":
            raise httpx.ConnectError(UPSTREAM_SECRET + PROMPT_SECRET, request=request)
        if self.failure == "invalid_json":
            return httpx.Response(200, content=(UPSTREAM_SECRET + PROMPT_SECRET).encode())
        return httpx.Response(self.status, json=self.output)


def gateway_at(path: Path, fake: FakeOpenRouter, **kwargs: Any) -> PopulationGateway:
    return PopulationGateway(
        config=PopulationProviderConfig(enabled=True, api_key=UPSTREAM_SECRET),
        ledger_path=path,
        transport=httpx.MockTransport(fake.handle),
        **kwargs,
    )


@pytest.fixture
def setup_gateway(tmp_path: Path) -> tuple[PopulationGateway, FakeOpenRouter]:
    fake = FakeOpenRouter()
    gateway = gateway_at(tmp_path / "budget.sqlite3", fake)
    gateway.register_run("run-one", [MODEL], token=LOCAL_SECRET)
    return gateway, fake


async def test_explicit_40_key_approval_keeps_the_20_session_cap_and_truthful_byok_metadata(tmp_path):
    fake = FakeOpenRouter()
    fake.key_info = key_metadata(limit=40, limit_remaining=40, include_byok_in_limit=False)
    gateway = PopulationGateway(
        config=PopulationProviderConfig(enabled=True, api_key=UPSTREAM_SECRET, approved_40_key_policy=True),
        ledger_path=tmp_path / "approved-cap.sqlite3", transport=httpx.MockTransport(fake.handle),
    )
    readiness = await gateway.preflight()
    assert readiness["ready"]
    assert readiness["provider_limit_microdollars"] == 40_000_000
    assert readiness["available_microdollars"] == 20_000_000
    assert readiness["byok_included_in_limit"] is False
    assert gateway.usage()["session_limit_microdollars"] == 20_000_000
    assert not fake.posts
    fake.key_info = key_metadata(limit=40, limit_remaining=40, include_byok_in_limit=False, byok_usage=0.001)
    with pytest.raises(GatewayError) as failure:
        await gateway.preflight()
    assert failure.value.code == "provider_cap_unverified"


async def test_token_rate_window_uses_verified_usage_and_keeps_uncertain_reservations(tmp_path):
    fake = FakeOpenRouter()
    gateway = gateway_at(tmp_path / "rate.sqlite3", fake, clock=lambda: 100.0)
    model = POPULATION_MODELS[MODEL]
    ceiling = model.context_length + 512
    gateway.register_run("rate-run", [MODEL], token=LOCAL_SECRET,
                         limits=RunLimits(tokens_per_minute=ceiling + 12))
    await gateway.complete(LOCAL_SECRET, request_body())
    fake.failure = "timeout"
    with pytest.raises(GatewayError, match="deadline"):
        await gateway.complete(LOCAL_SECRET, request_body())
    assert len(fake.posts) == 2
    with pytest.raises(GatewayError) as blocked:
        await gateway.complete(LOCAL_SECRET, request_body())
    assert blocked.value.code == "rate_limit_exceeded"
    assert len(fake.posts) == 2


def test_run_usage_totals_include_records_beyond_the_diagnostic_limit(setup_gateway):
    gateway, _ = setup_gateway
    run_hash = hashlib.sha256(b"run-one").hexdigest()
    with gateway._ledger._connection() as connection:
        connection.executemany(
            """INSERT INTO requests(request_id, run_hash, created_at, assigned_model, status,
                reserved_microdollars, accounted_microdollars, reserved_input_tokens, reserved_output_tokens,
                accounted_tokens, reported_cost_microdollars, reported_input_tokens, reported_output_tokens,
                reported_total_tokens) VALUES(?, ?, ?, ?, 'succeeded', 8, 8, 10, 2, 12, 8, 10, 2, 12)""",
            [(f"fixture-{index}", run_hash, float(index), MODEL) for index in range(1001)],
        )
    usage = gateway.usage("run-one")
    assert len(usage["requests"]) == 1000
    assert usage["run_totals"] == {
        "calls": 1001, "reported_tokens": 12012, "reported_cost_microdollars": 8008,
        "accounted_microdollars": 8008, "uncertain_requests": 0,
    }
    assert gateway.usage("absent-run")["run_totals"]["calls"] == 0


def test_opt_in_configuration_does_not_change_legacy_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    from cityshift import providers

    original = hashlib.sha256(repr(providers.agent_model_config()).encode()).hexdigest()
    monkeypatch.setenv("OPENROUTER_API_KEY", UPSTREAM_SECRET)
    monkeypatch.delenv("CITYSHIFT_POPULATION_LIVE", raising=False)
    config = population_provider_config()
    assert not config.enabled
    assert UPSTREAM_SECRET not in repr(config)
    monkeypatch.setenv("CITYSHIFT_POPULATION_LIVE", "1")
    assert population_provider_config().enabled
    assert hashlib.sha256(repr(providers.agent_model_config()).encode()).hexdigest() == original
    assert DEFAULT_LEDGER_PATH.parts[-3:] == ("var", "population", "model-budget.sqlite3")
    assert SESSION_CAP_MICRODOLLARS == 20_000_000


def test_catalog_is_fixed_public_and_accounts_for_cache_and_tiers() -> None:
    assert set(POPULATION_MODELS) == {
        "anthropic/claude-haiku-4.5", MODEL, "google/gemini-3.1-flash-lite", "x-ai/grok-4.3",
    }
    for model in POPULATION_MODELS.values():
        assert "tools" in model.catalog_entry()["supported_parameters"]
        assert model.provenance()["catalog_url"] == "https://openrouter.ai/api/v1/models"
    haiku = POPULATION_MODELS["anthropic/claude-haiku-4.5"]
    grok = POPULATION_MODELS["x-ai/grok-4.3"]
    assert haiku.input_rate >= Decimal("0.000002")
    assert grok.input_rate >= Decimal("0.0000025")
    assert grok.output_rate >= Decimal("0.000005")


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled,key", [(False, UPSTREAM_SECRET), (True, "")])
async def test_unavailable_configuration_never_calls_network(tmp_path: Path, enabled: bool, key: str) -> None:
    fake = FakeOpenRouter()
    gateway = PopulationGateway(config=PopulationProviderConfig(enabled=enabled, api_key=key),
                                ledger_path=tmp_path / "budget.sqlite3",
                                transport=httpx.MockTransport(fake.handle))
    with pytest.raises(GatewayError) as error:
        gateway.register_run("run-one", [MODEL], token=LOCAL_SECRET)
    assert error.value.status_code == 503
    assert not fake.posts and not fake.gets


@pytest.mark.asyncio
async def test_unknown_model_and_unregistered_token_fail_before_network(setup_gateway: Any) -> None:
    gateway, fake = setup_gateway
    with pytest.raises(GatewayError):
        gateway.register_run("other", ["invented/model"])
    with pytest.raises(GatewayError):
        await gateway.complete(LOCAL_SECRET, request_body(model="invented/model"))
    with pytest.raises(GatewayError) as error:
        await gateway.complete("unknown", request_body())
    assert error.value.status_code == 401
    assert not fake.posts and not fake.gets


@pytest.mark.asyncio
async def test_parallel_reservations_never_exceed_session_limit(tmp_path: Path) -> None:
    fake = FakeOpenRouter()
    fake.status = 502
    fake.delay = 0.02
    path = tmp_path / "budget.sqlite3"
    first = gateway_at(path, fake)
    first.register_run("parallel", [MODEL], token=LOCAL_SECRET,
                       limits=RunLimits(max_calls=100, max_tokens=100_000_000,
                                        requests_per_minute=100, tokens_per_minute=100_000_000))
    second = gateway_at(path, fake)
    quote = first.quote(LOCAL_SECRET, request_body())
    results = await asyncio.gather(
        *(gateway.complete(LOCAL_SECRET, request_body()) for gateway in [first, second] * 24),
        return_exceptions=True,
    )
    assert all(isinstance(result, GatewayError) for result in results)
    assert any(result.code == "budget_exhausted" for result in results)
    usage = first.usage()
    assert usage["accounted_microdollars"] == len(fake.posts) * quote.ceiling_microdollars
    assert usage["accounted_microdollars"] <= SESSION_CAP_MICRODOLLARS
    assert usage["remaining_microdollars"] < quote.ceiling_microdollars


@pytest.mark.asyncio
async def test_cumulative_ledger_and_run_limits_survive_restart(tmp_path: Path) -> None:
    fake = FakeOpenRouter()
    path = tmp_path / "budget.sqlite3"
    first = gateway_at(path, fake)
    first.register_run("persistent", [MODEL], token=LOCAL_SECRET, limits=RunLimits(max_calls=1))
    await first.complete(LOCAL_SECRET, request_body())
    first.unregister_run("persistent")
    second = gateway_at(path, fake)
    registration = second.register_run("persistent", [MODEL], limits=RunLimits(max_calls=1))
    with pytest.raises(GatewayError) as error:
        await second.complete(registration.token, request_body())
    assert error.value.code == "run_limit_exceeded"
    other = second.register_run("different", [MODEL])
    await second.complete(other.token, request_body())
    usage = second.usage()
    assert usage["accounted_microdollars"] == 16
    assert len(usage["requests"]) == 2
    with pytest.raises(GatewayError):
        second.register_run("persistent", [MODEL], limits=RunLimits(max_calls=2))


@pytest.mark.asyncio
async def test_session_cap_cannot_reset_or_increase(tmp_path: Path) -> None:
    fake = FakeOpenRouter()
    fake.status = 500
    path = tmp_path / "budget.sqlite3"
    first = gateway_at(path, fake, session_limit_microdollars=2_000_000)
    first.register_run("first", [MODEL], token=LOCAL_SECRET)
    with pytest.raises(GatewayError):
        await first.complete(LOCAL_SECRET, request_body())
    second = gateway_at(path, fake, session_limit_microdollars=SESSION_CAP_MICRODOLLARS)
    registration = second.register_run("second", [MODEL])
    with pytest.raises(GatewayError) as error:
        await second.complete(registration.token, request_body())
    assert error.value.code == "budget_exhausted"
    assert second.usage()["session_limit_microdollars"] == 2_000_000
    assert len(fake.posts) == 1
    with pytest.raises(GatewayError):
        gateway_at(tmp_path / "too-large.sqlite3", fake, session_limit_microdollars=20_000_001)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["timeout", "network", "invalid_json", "http", "missing_usage"])
async def test_ambiguous_failures_retain_full_reservation(setup_gateway: Any, failure: str) -> None:
    gateway, fake = setup_gateway
    quote = gateway.quote(LOCAL_SECRET, request_body())
    if failure == "http":
        fake.status = 429
        fake.output = {"error": {"message": UPSTREAM_SECRET + PROMPT_SECRET}}
    elif failure == "missing_usage":
        fake.output.pop("usage")
    else:
        fake.failure = failure
    with pytest.raises(GatewayError) as error:
        await gateway.complete(LOCAL_SECRET, request_body())
    usage = gateway.usage()
    assert usage["accounted_microdollars"] == quote.ceiling_microdollars
    assert len(fake.posts) == 1
    diagnostic = json.dumps(usage) + str(error.value) + repr(gateway)
    assert all(secret not in diagnostic for secret in (UPSTREAM_SECRET, LOCAL_SECRET, PROMPT_SECRET))


@pytest.mark.asyncio
async def test_reported_cost_rounds_up_and_refunds_only_verified_usage(setup_gateway: Any) -> None:
    gateway, fake = setup_gateway
    result = await gateway.complete(LOCAL_SECRET, request_body())
    assert result["choices"][0]["message"]["content"] == "wait"
    usage = gateway.usage()
    assert usage["accounted_microdollars"] == 8
    entry = usage["requests"][0]
    assert entry["reported_input_tokens"] == 10 and entry["reported_output_tokens"] == 2
    assert entry["assigned_model"] == entry["resolved_model"] == MODEL
    assert entry["api_provider"] == "openrouter" and entry["endpoint_provider"] == "OpenAI"
    assert entry["status"] == "succeeded" and entry["request_id"] == result["id"]
    assert entry["snapshot_sha256"] in {model["snapshot_sha256"] for model in usage["catalog"]}
    sent = json.loads(fake.posts[0].content)
    assert sent["stream"] is False and sent["usage"] == {"include": True}
    assert sent["provider"]["allow_fallbacks"] is False
    assert sent["provider"]["only"] == ["openai"]
    assert sent["provider"]["max_price"]["prompt"] > 0
    assert LOCAL_SECRET not in fake.posts[0].content.decode()


@pytest.mark.asyncio
@pytest.mark.parametrize("violation", ["cost", "tokens", "wrong_model"])
async def test_inconsistent_provider_accounting_latches_dispatch_closed(setup_gateway: Any, violation: str) -> None:
    gateway, fake = setup_gateway
    quote = gateway.quote(LOCAL_SECRET, request_body())
    if violation == "cost":
        fake.output["usage"]["cost"] = str(Decimal(quote.ceiling_microdollars + 1) / 1_000_000)
    elif violation == "tokens":
        fake.output["usage"]["completion_tokens"] = quote.output_tokens + 1
        fake.output["usage"]["total_tokens"] = quote.output_tokens + 11
    else:
        fake.output["model"] = "x-ai/grok-4.3"
    with pytest.raises(GatewayError):
        await gateway.complete(LOCAL_SECRET, request_body())
    with pytest.raises(GatewayError):
        await gateway.complete(LOCAL_SECRET, request_body())
    assert len(fake.posts) == 1
    assert gateway.usage()["blocked"]


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", ["calls", "tokens", "requests_per_minute", "tokens_per_minute"])
async def test_per_run_and_rate_quotas(setup_gateway: Any, limit: str) -> None:
    gateway, fake = setup_gateway
    quote = gateway.quote(LOCAL_SECRET, request_body())
    token_ceiling = quote.input_tokens + quote.output_tokens
    settings = {
        "calls": RunLimits(max_calls=1),
        "tokens": RunLimits(max_tokens=token_ceiling),
        "requests_per_minute": RunLimits(requests_per_minute=1),
        "tokens_per_minute": RunLimits(tokens_per_minute=token_ceiling),
    }
    registration = gateway.register_run("limited", [MODEL], limits=settings[limit])
    await gateway.complete(registration.token, request_body())
    with pytest.raises(GatewayError) as error:
        await gateway.complete(registration.token, request_body())
    assert error.value.status_code == 429
    assert len(fake.posts) == 1


@pytest.mark.asyncio
async def test_rate_tokens_do_not_refund_early_and_expire_by_window(tmp_path: Path) -> None:
    fake = FakeOpenRouter()
    now = [1000.0]
    gateway = gateway_at(tmp_path / "budget.sqlite3", fake, clock=lambda: now[0])
    gateway.register_run("quote", [MODEL], token=LOCAL_SECRET)
    quote = gateway.quote(LOCAL_SECRET, request_body())
    registration = gateway.register_run("rate", [MODEL], limits=RunLimits(
        tokens_per_minute=quote.input_tokens + quote.output_tokens,
    ))
    await gateway.complete(registration.token, request_body())
    with pytest.raises(GatewayError):
        await gateway.complete(registration.token, request_body())
    now[0] += 61
    await gateway.complete(registration.token, request_body())
    assert len(fake.posts) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("extra", [
    {"max_tokens": 513}, {"max_tokens": 0}, {"max_tokens": True},
    {"max_tokens": 10, "max_completion_tokens": 11}, {"n": 2}, {"plugins": []},
    {"web_search_options": {}}, {"provider": {}}, {"models": [MODEL]},
    {"service_tier": "priority"}, {"reasoning": {"max_tokens": 100000}},
    {"messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "x"}}]}]},
    {"tools": [{"type": "web_search"}]},
    {"tools": [{"type": "function", "function": {"name": "shell", "parameters": {}}}]},
    {"messages": [{"role": "user", "content": "x" * 65537}]},
])
async def test_unsafe_or_unbounded_requests_rejected_without_network(setup_gateway: Any, extra: dict) -> None:
    gateway, fake = setup_gateway
    with pytest.raises(GatewayError):
        await gateway.complete(LOCAL_SECRET, request_body(**extra))
    assert not fake.posts and not fake.gets


@pytest.mark.asyncio
async def test_output_cap_default_and_tool_formatting_in_ceiling(setup_gateway: Any) -> None:
    gateway, fake = setup_gateway
    tools = [{"type": "function", "function": {"name": "view_tasks", "description": "task lookup",
              "parameters": {"type": "object", "properties": {}}}}]
    body = request_body(tools=tools)
    quote = gateway.quote(LOCAL_SECRET, body)
    assert quote.input_tokens >= len(json.dumps(body).encode()) + 4096
    await gateway.complete(LOCAL_SECRET, body)
    sent = json.loads(fake.posts[0].content)
    assert sent["max_tokens"] == 512 and sent["tools"] == tools


@pytest.mark.asyncio
@pytest.mark.parametrize("drift", ["model", "tools", "price", "unknown_price"])
async def test_catalog_drift_blocks_paid_dispatch(setup_gateway: Any, drift: str) -> None:
    gateway, fake = setup_gateway
    if drift == "model":
        del fake.catalog[MODEL]
    elif drift == "tools":
        fake.catalog[MODEL]["supported_parameters"] = ["max_tokens"]
    elif drift == "price":
        fake.endpoints[MODEL]["pricing"]["prompt"] = "99"
    else:
        fake.endpoints[MODEL]["pricing"]["unbounded_storage"] = "0.1"
    with pytest.raises(GatewayError) as error:
        await gateway.complete(LOCAL_SECRET, request_body())
    assert error.value.status_code == 503 and not fake.posts


@pytest.mark.asyncio
async def test_router_auth_size_errors_and_sse_tool_deltas(setup_gateway: Any) -> None:
    gateway, fake = setup_gateway
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_population_gateway] = lambda: gateway
    headers = {"Authorization": f"Bearer {LOCAL_SECRET}"}
    prefix = "/api/population/model/v1"
    fake.output["choices"] = [{"index": 0, "message": {"role": "assistant", "content": None,
        "tool_calls": [{"id": "call-one", "type": "function",
                        "function": {"name": "view_tasks", "arguments": "{}"}},
                       {"id": "call-two", "type": "function",
                        "function": {"name": "observe_local_state", "arguments": "{}"}}]},
        "finish_reason": "tool_calls"}]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://gateway") as client:
        assert (await client.get(prefix + "/models")).status_code == 401
        response = await client.get(prefix + "/models", headers=headers)
        assert [entry["id"] for entry in response.json()["data"]] == [MODEL]
        response = await client.post(prefix + "/chat/completions", headers=headers,
                                    content=b"x" * 65537)
        assert response.status_code == 413
        response = await client.post(prefix + "/chat/completions", headers=headers,
                                    content=b'{"messages":NaN}')
        assert response.status_code == 400
        response = await client.post(prefix + "/chat/completions", headers=headers,
                                    json=request_body(stream=True, stream_options={"include_usage": True}))
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        events = [line[6:] for line in response.text.splitlines() if line.startswith("data: ")]
        assert events[-1] == "[DONE]"
        chunks = [json.loads(event) for event in events[:-1]]
        calls = [tool for chunk in chunks for choice in chunk["choices"]
                 for tool in choice["delta"].get("tool_calls", [])]
        assert [call["index"] for call in calls] == [0, 1]
        assert [call["function"]["arguments"] for call in calls] == ["{}", "{}"]
        assert any(choice["finish_reason"] == "tool_calls" for chunk in chunks for choice in chunk["choices"])
        assert chunks[-1]["choices"] == [] and chunks[-1]["usage"]["total_tokens"] == 12
        gateway.unregister_run("run-one")
        assert (await client.get(prefix + "/models", headers=headers)).status_code == 401
    assert len(fake.posts) == 1


@pytest.mark.asyncio
async def test_cancellation_retains_reservation(tmp_path: Path) -> None:
    fake = FakeOpenRouter()
    fake.delay = 100
    gateway = gateway_at(tmp_path / "budget.sqlite3", fake)
    gateway.register_run("cancel", [MODEL], token=LOCAL_SECRET)
    quote = gateway.quote(LOCAL_SECRET, request_body())
    task = asyncio.create_task(gateway.complete(LOCAL_SECRET, request_body()))
    while not fake.posts:
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert gateway.usage()["accounted_microdollars"] == quote.ceiling_microdollars


def test_configuration_and_registration_repr_redacts_credentials(setup_gateway: Any) -> None:
    gateway, _ = setup_gateway
    registration = gateway.register_run("redact", [MODEL])
    assert registration.token not in repr(registration)
    assert UPSTREAM_SECRET not in repr(gateway)
    with pytest.raises(GatewayError):
        gateway.register_run("invalid", [MODEL], limits=replace(RunLimits(), max_output_tokens=90000))


@pytest.mark.asyncio
async def test_router_preserves_sampling_numbers_and_rejects_duplicate_fields(setup_gateway: Any) -> None:
    gateway, fake = setup_gateway
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_population_gateway] = lambda: gateway
    headers = {"Authorization": f"Bearer {LOCAL_SECRET}"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://gateway") as client:
        response = await client.post("/api/population/model/v1/chat/completions", headers=headers,
                                     json=request_body(temperature=0.2, top_p=0.9))
        assert response.status_code == 200
        sent = json.loads(fake.posts[0].content)
        assert sent["temperature"] == 0.2 and sent["top_p"] == 0.9
        duplicated = json.dumps(request_body())[:-1] + ', "model": "' + MODEL + '"}'
        response = await client.post("/api/population/model/v1/chat/completions", headers=headers,
                                     content=duplicated)
        assert response.status_code == 400
    assert len(fake.posts) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("extra", [
    {"tool_choice": {"type": "function", "function": {"name": []}}},
    {"messages": [{"role": "assistant", "content": None,
                   "tool_calls": [{"id": "call-one", "type": "function",
                                   "function": {"name": "send_email", "arguments": "{}"}}]}]},
    {"tools": [{"type": "function", "function": {"name": "view_tasks",
               "parameters": {"$ref": "https://outside.invalid/schema"}}}]},
])
async def test_malformed_nested_fields_are_redacted_preflight_errors(setup_gateway: Any, extra: dict) -> None:
    gateway, fake = setup_gateway
    with pytest.raises(GatewayError) as error:
        await gateway.complete(LOCAL_SECRET, request_body(**extra))
    assert error.value.status_code == 400
    assert not fake.posts and not fake.gets


@pytest.mark.asyncio
async def test_invalid_completion_records_failure_even_with_verified_charge(setup_gateway: Any) -> None:
    gateway, fake = setup_gateway
    fake.output["choices"] = []
    with pytest.raises(GatewayError):
        await gateway.complete(LOCAL_SECRET, request_body())
    usage = gateway.usage()
    assert usage["requests"][0]["status"] == "invalid_response"
    assert usage["accounted_microdollars"] == 8


@pytest.mark.asyncio
@pytest.mark.parametrize("model_id", list(POPULATION_MODELS))
async def test_each_frozen_model_uses_its_pinned_endpoint_and_honest_resolved_name(tmp_path: Path, model_id: str) -> None:
    fake = FakeOpenRouter()
    model = POPULATION_MODELS[model_id]
    fake.output = completion(model=model.canonical_slug, provider=model.endpoint_provider)
    gateway = gateway_at(tmp_path / "budget.sqlite3", fake)
    registration = gateway.register_run("families", [model_id])
    result = await gateway.complete(registration.token, request_body(model=model_id))
    assert result["model"] == model.canonical_slug
    sent = json.loads(fake.posts[0].content)
    assert sent["provider"]["only"] == [model.endpoint_tag]
    assert sent["provider"]["data_collection"] == "deny"
    if model.reasoning:
        assert sent["reasoning"] == {"enabled": False}
    record = gateway.usage()["requests"][0]
    assert record["assigned_model"] == model_id
    assert record["resolved_model"] == model.canonical_slug


@pytest.mark.asyncio
async def test_raw_secret_and_prompt_text_never_enter_ledger_logs_or_error_payloads(
    tmp_path: Path, caplog: pytest.LogCaptureFixture,
) -> None:
    fake = FakeOpenRouter()
    fake.failure = "timeout"
    path = tmp_path / "budget.sqlite3"
    gateway = gateway_at(path, fake)
    gateway.register_run("redaction", [MODEL], token=LOCAL_SECRET)
    with pytest.raises(GatewayError) as error:
        await gateway.complete(LOCAL_SECRET, request_body())
    diagnostic = json.dumps(error.value.public_error()) + json.dumps(gateway.usage()) + caplog.text
    on_disk = b"".join(file.read_bytes() for file in tmp_path.iterdir() if file.is_file())
    for secret in (LOCAL_SECRET, UPSTREAM_SECRET, PROMPT_SECRET):
        assert secret not in diagnostic
        assert secret.encode() not in on_disk
    assert path.stat().st_mode & 0o777 == 0o600


@pytest.mark.asyncio
async def test_tls_verification_redirect_and_environment_controls_are_explicit(
    setup_gateway: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway, _ = setup_gateway
    original = httpx.AsyncClient
    settings = []

    def client(**kwargs: Any) -> httpx.AsyncClient:
        settings.append(kwargs)
        return original(**kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client)
    await gateway.complete(LOCAL_SECRET, request_body())
    assert settings[0]["verify"] is True
    assert settings[0]["trust_env"] is False
    assert settings[0]["follow_redirects"] is False


@pytest.mark.asyncio
async def test_real_deadline_cancels_slow_upstream_and_keeps_reservation(tmp_path: Path) -> None:
    fake = FakeOpenRouter()
    fake.delay = 5
    gateway = gateway_at(tmp_path / "budget.sqlite3", fake)
    gateway.register_run("deadline", [MODEL], token=LOCAL_SECRET, limits=RunLimits(request_timeout_seconds=1))
    quote = gateway.quote(LOCAL_SECRET, request_body())
    with pytest.raises(GatewayError) as error:
        await gateway.complete(LOCAL_SECRET, request_body())
    assert error.value.code == "upstream_timeout"
    assert gateway.usage()["accounted_microdollars"] == quote.ceiling_microdollars
    assert len(fake.posts) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("cost", [0.0000010000000001, "0.0000010000000000000000000000000000000000000001"])
async def test_numeric_reported_cost_is_not_rounded_down(setup_gateway: Any, cost: Any) -> None:
    gateway, fake = setup_gateway
    fake.output["usage"]["cost"] = cost
    await gateway.complete(LOCAL_SECRET, request_body())
    assert gateway.usage()["accounted_microdollars"] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("extra_usage", [
    {"is_byok": True}, {"server_tool_use": {"web_search_requests": 1}},
    {"completion_tokens_details": {"reasoning_tokens": 513}},
    {"prompt_tokens_details": {"image_tokens": 1}},
])
async def test_unreported_byok_and_server_side_tool_costs_do_not_refund(setup_gateway: Any, extra_usage: dict) -> None:
    gateway, fake = setup_gateway
    fake.output["usage"].update(extra_usage)
    quote = gateway.quote(LOCAL_SECRET, request_body())
    with pytest.raises(GatewayError):
        await gateway.complete(LOCAL_SECRET, request_body())
    assert gateway.usage()["accounted_microdollars"] >= quote.ceiling_microdollars
    assert gateway.usage()["blocked"]


def test_real_upstream_cannot_switch_ledger_paths(tmp_path: Path) -> None:
    with pytest.raises(GatewayError):
        PopulationGateway(config=PopulationProviderConfig(enabled=True, api_key=UPSTREAM_SECRET),
                          ledger_path=tmp_path / "fresh-budget.sqlite3")


@pytest.mark.asyncio
async def test_additional_endpoint_prices_cannot_exceed_frozen_envelope(setup_gateway: Any) -> None:
    gateway, fake = setup_gateway
    added = POPULATION_MODELS[MODEL].endpoint_entry()
    added["tag"] = "openai/priority"
    added["pricing"]["prompt"] = "0.1"
    fake.additional_endpoints[MODEL] = [added]
    with pytest.raises(GatewayError) as error:
        await gateway.complete(LOCAL_SECRET, request_body())
    assert error.value.code == "unsupported_pricing" and not fake.posts


def test_threaded_independent_gateway_instances_share_atomic_reservations(tmp_path: Path) -> None:
    fake = FakeOpenRouter()
    fake.status = 500
    path = tmp_path / "budget.sqlite3"
    gateway = gateway_at(path, fake)
    gateway.register_run("threads", [MODEL], token=LOCAL_SECRET)
    quote = gateway.quote(LOCAL_SECRET, request_body())

    def complete_in_thread(index: int) -> str:
        independent = gateway_at(path, fake)
        try:
            asyncio.run(independent.complete(LOCAL_SECRET, request_body()))
        except GatewayError as error:
            return error.code
        return "unexpected_success"

    with ThreadPoolExecutor(max_workers=8) as executor:
        outcomes = list(executor.map(complete_in_thread, range(32)))
    assert "unexpected_success" not in outcomes and "budget_exhausted" in outcomes
    assert len(fake.posts) * quote.ceiling_microdollars <= SESSION_CAP_MICRODOLLARS
    assert gateway.usage()["accounted_microdollars"] == len(fake.posts) * quote.ceiling_microdollars


@pytest.mark.asyncio
async def test_openai_sdk_consumes_real_sse_tool_call_shape(setup_gateway: Any) -> None:
    from openai import AsyncOpenAI

    gateway, fake = setup_gateway
    fake.output["choices"] = [{"index": 0, "message": {"role": "assistant", "content": None,
        "tool_calls": [{"id": "call-native", "type": "function",
                        "function": {"name": "view_tasks", "arguments": "{}"}}]},
        "finish_reason": "tool_calls"}]
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_population_gateway] = lambda: gateway
    http_client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app))
    async with AsyncOpenAI(api_key=LOCAL_SECRET, base_url="http://gateway/api/population/model/v1",
                           max_retries=0, http_client=http_client) as client:
        stream = await client.chat.completions.create(
            model=MODEL, messages=[{"role": "user", "content": "choose"}],
            tools=[{"type": "function", "function": {"name": "view_tasks",
                    "parameters": {"type": "object", "properties": {}}}}],
            max_tokens=512, stream=True, stream_options={"include_usage": True},
        )
        chunks = [chunk async for chunk in stream]
    calls = [call for chunk in chunks for choice in chunk.choices for call in choice.delta.tool_calls or []]
    assert len(calls) == 1 and calls[0].index == 0
    assert calls[0].function is not None and calls[0].function.name == "view_tasks"
    assert calls[0].function.arguments == "{}"
    assert chunks[-1].usage is not None and chunks[-1].usage.total_tokens == 12
    assert any(choice.finish_reason == "tool_calls" for chunk in chunks for choice in chunk.choices)


@pytest.mark.asyncio
async def test_unregistered_during_catalog_check_cannot_dispatch(setup_gateway: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    gateway, fake = setup_gateway
    started, released = asyncio.Event(), asyncio.Event()
    original = gateway._verify_catalog

    async def paused(client: httpx.AsyncClient, model: Any) -> None:
        started.set()
        await released.wait()
        await original(client, model)

    monkeypatch.setattr(gateway, "_verify_catalog", paused)
    task = asyncio.create_task(gateway.complete(LOCAL_SECRET, request_body()))
    await started.wait()
    gateway.unregister_run("run-one")
    released.set()
    with pytest.raises(GatewayError) as error:
        await task
    assert error.value.code == "unauthorized" and not fake.posts


@pytest.mark.asyncio
async def test_oversized_upstream_response_retains_reservation(setup_gateway: Any) -> None:
    gateway, fake = setup_gateway
    fake.output["choices"][0]["message"]["content"] = "x" * 1_048_576
    quote = gateway.quote(LOCAL_SECRET, request_body())
    with pytest.raises(GatewayError):
        await gateway.complete(LOCAL_SECRET, request_body())
    assert gateway.usage()["accounted_microdollars"] == quote.ceiling_microdollars


def test_corrupt_ledger_is_unavailable_without_reset_or_network(tmp_path: Path) -> None:
    fake = FakeOpenRouter()
    path = tmp_path / "budget.sqlite3"
    path.write_bytes(b"invalid-ledger")
    with pytest.raises(GatewayError) as error:
        gateway_at(path, fake)
    assert error.value.code == "ledger_unavailable"
    assert path.read_bytes() == b"invalid-ledger"
    assert not fake.posts and not fake.gets


def test_money_ceiling_does_not_depend_on_callers_decimal_precision(setup_gateway: Any) -> None:
    gateway, _ = setup_gateway
    expected = gateway.quote(LOCAL_SECRET, request_body())
    with localcontext() as context:
        context.prec = 6
        assert gateway.quote(LOCAL_SECRET, request_body()) == expected


@pytest.mark.asyncio
async def test_provider_cap_preflight_is_explicit_read_only_and_redacted(setup_gateway: Any) -> None:
    gateway, fake = setup_gateway
    assert gateway.readiness()["ready"] is False
    assert not fake.key_gets
    result = await gateway.preflight()
    assert result["ready"] is True and result["code"] is None
    assert result["provider_limit_microdollars"] == SESSION_CAP_MICRODOLLARS
    assert result["provider_remaining_microdollars"] == SESSION_CAP_MICRODOLLARS
    assert result["available_microdollars"] == SESSION_CAP_MICRODOLLARS
    assert result["verification_url"] == "https://openrouter.ai/api/v1/key"
    assert result["non_renewing"] is True and result["byok_included_in_limit"] is True
    assert result["dedicated_key_required"] is True
    assert gateway.readiness()["ready"] is True
    assert len(fake.key_gets) == 1 and not fake.posts and not fake.gets
    assert gateway.usage()["request_count"] == 0
    diagnostic = json.dumps(result) + json.dumps(gateway.usage())
    assert all(value not in diagnostic for value in (
        UPSTREAM_SECRET, LOCAL_SECRET, KEY_LABEL_SECRET, KEY_IDENTITY_SECRET,
    ))


@pytest.mark.asyncio
@pytest.mark.parametrize("updates", [
    {"limit": None}, {"limit": 0}, {"limit": -1}, {"limit": 20.0000000001}, {"limit": "20"},
    {"limit": True}, {"limit_reset": "daily"}, {"limit_reset": "monthly"}, {"limit_reset": "never"},
    {"limit_reset": False}, {"limit_remaining": None}, {"limit_remaining": -1},
    {"limit_remaining": 20.1}, {"usage": 2, "limit_remaining": 20}, {"usage": -1},
    {"usage": "0"}, {"usage": False}, {"include_byok_in_limit": False},
    {"include_byok_in_limit": 1}, {"byok_usage": 0.000000001},
    {"is_management_key": True}, {"is_provisioning_key": True},
    {"expires_at": "2000-01-01T00:00:00Z"}, {"expires_at": "not-a-timestamp"},
])
async def test_provider_cap_invalid_metadata_prevents_dispatch(setup_gateway: Any, updates: dict) -> None:
    gateway, fake = setup_gateway
    fake.key_info = key_metadata(**updates)
    with pytest.raises(GatewayError) as error:
        await gateway.preflight()
    assert error.value.code == "provider_cap_unverified"
    with pytest.raises(GatewayError):
        await gateway.complete(LOCAL_SECRET, request_body())
    assert not fake.posts and gateway.usage()["request_count"] == 0
    assert gateway.readiness()["ready"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("field", [
    "limit", "limit_reset", "limit_remaining", "usage", "byok_usage",
    "include_byok_in_limit", "is_management_key", "is_provisioning_key",
])
async def test_provider_cap_missing_required_evidence_fails_closed(setup_gateway: Any, field: str) -> None:
    gateway, fake = setup_gateway
    del fake.key_info["data"][field]
    with pytest.raises(GatewayError):
        await gateway.preflight()
    assert not fake.posts and not gateway.readiness()["ready"]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["timeout", "invalid_json", "oversized", "unauthorized", "redirect", "server"])
async def test_provider_cap_unverifiable_response_is_not_cached_as_ready(setup_gateway: Any, failure: str) -> None:
    gateway, fake = setup_gateway
    await gateway.preflight()
    if failure in {"unauthorized", "redirect", "server"}:
        fake.key_status = {"unauthorized": 401, "redirect": 302, "server": 500}[failure]
        fake.key_info = {"error": {"message": KEY_LABEL_SECRET + KEY_IDENTITY_SECRET + UPSTREAM_SECRET}}
    else:
        fake.key_failure = failure
    with pytest.raises(GatewayError) as error:
        await gateway.complete(LOCAL_SECRET, request_body())
    assert error.value.code == "provider_cap_unverified"
    assert not gateway.readiness()["ready"]
    assert not fake.posts and len(fake.key_gets) == 2
    assert gateway.usage()["accounted_microdollars"] == 0


@pytest.mark.asyncio
async def test_provider_cap_must_cover_whole_remaining_session(setup_gateway: Any) -> None:
    gateway, fake = setup_gateway
    fake.key_info = key_metadata(limit=10, limit_remaining=10)
    with pytest.raises(GatewayError) as error:
        await gateway.preflight()
    assert error.value.code == "provider_cap_insufficient"
    with pytest.raises(GatewayError) as error:
        await gateway.complete(LOCAL_SECRET, request_body())
    assert error.value.code == "provider_cap_insufficient"
    assert not fake.posts
    assert gateway.usage()["session_limit_microdollars"] == SESSION_CAP_MICRODOLLARS


@pytest.mark.asyncio
async def test_provider_cap_can_be_below_twenty_when_session_is_explicitly_smaller(tmp_path: Path) -> None:
    fake = FakeOpenRouter()
    fake.key_info = key_metadata(limit=2, limit_remaining=2)
    gateway = gateway_at(tmp_path / "budget.sqlite3", fake, session_limit_microdollars=2_000_000)
    result = await gateway.preflight()
    assert result["ready"] and result["available_microdollars"] == 2_000_000


@pytest.mark.asyncio
async def test_provider_usage_cannot_replenish_budget_across_runs_or_restarts(tmp_path: Path) -> None:
    fake = FakeOpenRouter()
    fake.key_info = key_metadata(usage=3, limit_remaining=17)
    path = tmp_path / "budget.sqlite3"
    first = gateway_at(path, fake)
    result = await first.preflight()
    assert result["ready"] and result["available_microdollars"] == 17_000_000
    assert first.usage()["provider_usage_hold_microdollars"] == 3_000_000
    second = gateway_at(path, fake)
    second.register_run("new-run", [MODEL])
    fake.key_info = key_metadata(usage=2, limit_remaining=18)
    with pytest.raises(GatewayError) as error:
        await second.preflight()
    assert error.value.code == "provider_cap_changed"
    assert second.usage()["remaining_microdollars"] == 17_000_000
    assert second.usage()["provider_usage_hold_microdollars"] == 3_000_000
    assert not fake.posts


@pytest.mark.asyncio
async def test_provider_aggregate_usage_never_refunds_or_erases_local_spending(setup_gateway: Any) -> None:
    gateway, fake = setup_gateway
    await gateway.complete(LOCAL_SECRET, request_body())
    fake.key_info = key_metadata(usage=0.0000072, limit_remaining=19.9999928)
    result = await gateway.preflight()
    usage = gateway.usage()
    assert result["ready"] and result["provider_usage_overlap_assumed"] is False
    assert usage["request_accounted_microdollars"] == 8
    assert usage["provider_usage_hold_microdollars"] == 8
    assert usage["accounted_microdollars"] == 16
    assert result["available_microdollars"] == SESSION_CAP_MICRODOLLARS - 16
    assert len(fake.posts) == 1


@pytest.mark.asyncio
async def test_provider_cap_stale_readiness_and_key_rotation_fail_closed(tmp_path: Path) -> None:
    fake = FakeOpenRouter()
    path = tmp_path / "budget.sqlite3"
    now = [1000.0]
    first = gateway_at(path, fake, clock=lambda: now[0])
    await first.preflight()
    now[0] += 31
    assert first.readiness()["ready"] is False
    assert len(fake.key_gets) == 1
    fake.expected_key = "different-test-provider-key"
    second = PopulationGateway(config=PopulationProviderConfig(enabled=True, api_key=fake.expected_key),
                               ledger_path=path, transport=httpx.MockTransport(fake.handle), clock=lambda: now[0])
    with pytest.raises(GatewayError) as error:
        await second.preflight()
    assert error.value.code == "provider_cap_changed"
    assert not fake.posts


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled,key", [(False, UPSTREAM_SECRET), (True, "")])
async def test_provider_cap_no_key_or_no_enable_makes_no_network_request(tmp_path: Path, enabled: bool, key: str) -> None:
    fake = FakeOpenRouter()
    gateway = PopulationGateway(config=PopulationProviderConfig(enabled=enabled, api_key=key),
                                ledger_path=tmp_path / "budget.sqlite3", transport=httpx.MockTransport(fake.handle))
    assert not gateway.readiness()["ready"]
    with pytest.raises(GatewayError) as error:
        await gateway.preflight()
    assert error.value.code == "unavailable"
    assert not fake.key_gets and not fake.gets and not fake.posts


@pytest.mark.asyncio
async def test_provider_metadata_never_persists_labels_credentials_or_user_identity(
    tmp_path: Path, caplog: pytest.LogCaptureFixture,
) -> None:
    fake = FakeOpenRouter()
    gateway = gateway_at(tmp_path / "budget.sqlite3", fake)
    await gateway.preflight()
    diagnostic = json.dumps(gateway.readiness()) + json.dumps(gateway.usage()) + caplog.text
    on_disk = b"".join(file.read_bytes() for file in tmp_path.iterdir() if file.is_file())
    for value in (UPSTREAM_SECRET, KEY_LABEL_SECRET, KEY_IDENTITY_SECRET):
        assert value not in diagnostic
        assert value.encode() not in on_disk
    binding = hashlib.sha256(("population-provider-cap:" + UPSTREAM_SECRET).encode()).hexdigest()
    assert binding not in diagnostic


@pytest.mark.asyncio
async def test_provider_usage_and_concurrent_reservations_share_the_total_cap(tmp_path: Path) -> None:
    fake = FakeOpenRouter()
    fake.key_info = key_metadata(usage=5, limit_remaining=15)
    fake.status = 500
    fake.delay = 0.01
    path = tmp_path / "budget.sqlite3"
    first = gateway_at(path, fake)
    second = gateway_at(path, fake)
    first.register_run("provider-parallel", [MODEL], token=LOCAL_SECRET,
                       limits=RunLimits(max_tokens=100_000_000, tokens_per_minute=100_000_000))
    quote = first.quote(LOCAL_SECRET, request_body())
    results = await asyncio.gather(
        *(instance.complete(LOCAL_SECRET, request_body()) for instance in [first, second] * 20),
        return_exceptions=True,
    )
    assert all(isinstance(result, GatewayError) for result in results)
    usage = first.usage()
    assert usage["accounted_microdollars"] == 5_000_000 + len(fake.posts) * quote.ceiling_microdollars
    assert usage["accounted_microdollars"] <= SESSION_CAP_MICRODOLLARS
    assert usage["remaining_microdollars"] < quote.ceiling_microdollars


@pytest.mark.asyncio
async def test_provider_cap_client_failure_invalidates_cached_readiness(
    setup_gateway: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    gateway, fake = setup_gateway
    await gateway.preflight()

    def broken_client(timeout: int) -> Any:
        raise RuntimeError(UPSTREAM_SECRET + KEY_LABEL_SECRET)

    monkeypatch.setattr(gateway, "_http_client", broken_client)
    with pytest.raises(GatewayError) as error:
        await gateway.preflight()
    assert error.value.code == "provider_cap_unverified"
    assert UPSTREAM_SECRET not in str(error.value) and KEY_LABEL_SECRET not in str(error.value)
    assert gateway.readiness()["ready"] is False and not fake.posts


@pytest.mark.asyncio
async def test_provider_preflight_has_deadline_and_no_retry(setup_gateway: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from cityshift.agents import population_gateway

    gateway, fake = setup_gateway
    fake.key_failure = "slow"
    monkeypatch.setattr(population_gateway, "KEY_PREFLIGHT_TIMEOUT_SECONDS", 1)
    with pytest.raises(GatewayError) as error:
        await gateway.preflight()
    assert error.value.code == "provider_cap_unverified"
    assert len(fake.key_gets) == 1 and not fake.posts and not fake.gets


@pytest.mark.asyncio
async def test_provider_preflight_metadata_cannot_release_ambiguous_reservation(setup_gateway: Any) -> None:
    gateway, fake = setup_gateway
    quote = gateway.quote(LOCAL_SECRET, request_body())
    fake.failure = "timeout"
    with pytest.raises(GatewayError):
        await gateway.complete(LOCAL_SECRET, request_body())
    result = await gateway.preflight()
    assert result["ready"]
    assert gateway.usage()["accounted_microdollars"] == quote.ceiling_microdollars
    assert gateway.usage()["requests"][0]["reported_cost_microdollars"] is None


@pytest.mark.asyncio
async def test_module_preflight_and_cached_readiness_facades(setup_gateway: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from cityshift.agents import population_gateway

    gateway, fake = setup_gateway
    monkeypatch.setattr(population_gateway, "_default_gateway", gateway)
    assert not population_gateway.population_gateway_readiness()["ready"]
    result = await population_gateway.preflight_population_gateway()
    assert result["ready"]
    assert population_gateway.population_gateway_readiness()["ready"]
    assert len(fake.key_gets) == 1 and not fake.posts


@pytest.mark.asyncio
async def test_router_rechecks_changed_cap_before_any_model_dispatch(setup_gateway: Any) -> None:
    gateway, fake = setup_gateway
    await gateway.preflight()
    fake.key_info = key_metadata(limit_reset="monthly")
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_population_gateway] = lambda: gateway
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://gateway") as client:
        response = await client.post("/api/population/model/v1/chat/completions",
                                    headers={"Authorization": f"Bearer {LOCAL_SECRET}"},
                                    json=request_body(stream=True))
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "provider_cap_unverified"
    assert all(value not in response.text for value in (UPSTREAM_SECRET, KEY_LABEL_SECRET, KEY_IDENTITY_SECRET))
    assert not fake.posts and len(fake.key_gets) == 2
