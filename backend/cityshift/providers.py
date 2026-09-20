"""External provider adapters. Each reports honestly whether it is the sponsor service or a local fallback.

- LLM: OpenAI-compatible chat endpoint. Baseten when LLM_API_BASE points at Baseten and LLM_API_KEY is set;
  Backboard (thread/assistant API, translated to chat completions) when BACKBOARD_API_KEY is set;
  otherwise the local Ollama server. The adapter never claims one while using the other.
- Elasticsearch: ELASTIC_CLOUD_URL + ELASTIC_API_KEY (Elastic Cloud) or ELASTIC_URL (local), else unavailable.
- Sentry: enabled only when SENTRY_DSN is set.
- Map: Mapbox only when a token is present; otherwise MapLibre + OpenFreeMap tiles (decided in the frontend).
- Replay share: Cloudflare R2 only when credentials are present; otherwise local export.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from decimal import ROUND_CEILING, Context, Decimal, localcontext
from pathlib import Path
from types import MappingProxyType
from typing import Any, ClassVar

import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

BACKBOARD_API_KEY = os.environ.get("BACKBOARD_API_KEY", "")
BACKBOARD_API_BASE = os.environ.get("BACKBOARD_API_BASE", "https://app.backboard.io/api").rstrip("/")
BACKBOARD_LLM_PROVIDER = os.environ.get("BACKBOARD_LLM_PROVIDER", "openai")
LLM_PROVIDER = os.environ.get("LLM_PROVIDER") or ("backboard" if BACKBOARD_API_KEY else "openai-compatible")
LLM_API_BASE = os.environ.get("LLM_API_BASE", "http://localhost:11434/v1")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-4o" if LLM_PROVIDER == "backboard" else "qwen2.5:7b")
LLM_TIMEOUT_S = float(os.environ.get("LLM_TIMEOUT_S", "600"))  # local 7B models on a laptop GPU can take minutes per call
API_PORT = int(os.environ.get("CITYSHIFT_API_PORT", "8000"))
# OpenAI-compatible surface served by this backend (cityshift.api.llm_router); agent frameworks that only speak
# chat/completions are pointed here when the configured provider is not OpenAI-compatible itself.
LLM_SHIM_BASE = os.environ.get("LLM_SHIM_BASE", f"http://127.0.0.1:{API_PORT}/llm/v1")
ELASTIC_URL = os.environ.get("ELASTIC_CLOUD_URL") or os.environ.get("ELASTIC_URL", "http://localhost:9200")
ELASTIC_API_KEY = os.environ.get("ELASTIC_API_KEY", "")


def llm_provider_name() -> str:
    if LLM_PROVIDER == "backboard":
        return "backboard"
    if "baseten" in LLM_API_BASE and LLM_API_KEY:
        return "baseten"
    if "openrouter.ai" in LLM_API_BASE and LLM_API_KEY:
        return "openrouter"
    if "localhost" in LLM_API_BASE or "127.0.0.1" in LLM_API_BASE:
        return "ollama-local"
    return "openai-compatible"


def agent_model_config() -> tuple[str, str, str]:
    """(api_base, api_key, model) for frameworks that need an OpenAI-compatible endpoint."""
    if LLM_PROVIDER == "backboard":
        return LLM_SHIM_BASE, "shim", LLM_MODEL
    return LLM_API_BASE, LLM_API_KEY or "none", LLM_MODEL


class BackboardError(RuntimeError):
    pass


class BackboardChat:
    """Translates OpenAI chat-completion requests onto Backboard's thread API.

    A request whose trailing messages are tool results continues the Backboard thread that issued those tool calls
    (POST /threads/tool-outputs); any other request opens a fresh thread with the flattened transcript. Memory is
    off: every call is self-contained, exactly like a stateless chat completion.
    """

    _threads: ClassVar[OrderedDict[str, str]] = OrderedDict()
    _lock: ClassVar[threading.Lock] = threading.Lock()

    def __init__(self, key: str = BACKBOARD_API_KEY, base: str = BACKBOARD_API_BASE, llm_provider: str = BACKBOARD_LLM_PROVIDER, timeout: float = LLM_TIMEOUT_S):
        self.key = key
        self.base = base
        self.llm_provider = llm_provider
        self.timeout = timeout

    def _headers(self) -> dict:
        return {"X-API-Key": self.key, "Content-Type": "application/json"}

    def available(self) -> bool:
        if not self.key:
            return False
        try:
            r = httpx.get(f"{self.base}/assistants", headers=self._headers(), timeout=3)
            return r.status_code < 400
        except httpx.HTTPError:
            return False

    @classmethod
    def _remember(cls, tool_call_ids: list[str], thread_id: str) -> None:
        with cls._lock:
            for cid in tool_call_ids:
                cls._threads[cid] = thread_id
            while len(cls._threads) > 2000:
                cls._threads.popitem(last=False)

    @classmethod
    def _thread_for(cls, tool_call_id: str) -> str | None:
        with cls._lock:
            return cls._threads.get(tool_call_id)

    @staticmethod
    def _flatten(messages: list[dict]) -> tuple[str, str]:
        system = "\n\n".join(str(m.get("content") or "") for m in messages if m.get("role") == "system")
        rest = [m for m in messages if m.get("role") != "system"]
        if len(rest) == 1 and rest[0].get("role") == "user":
            return system, str(rest[0].get("content") or "")
        lines = []
        for m in rest:
            role = str(m.get("role", "user")).capitalize()
            content = m.get("content")
            if m.get("tool_calls"):
                content = f"{content or ''}\n[tool calls: {json.dumps(m['tool_calls'])}]"
            if m.get("role") == "tool":
                role = f"Tool result ({m.get('tool_call_id', '?')})"
            lines.append(f"{role}: {content or ''}")
        lines.append("Assistant:")
        return system, "\n".join(lines)

    def complete(self, messages: list[dict], model: str, tools: list[dict] | None = None, json_mode: bool = False) -> dict:
        """Returns an OpenAI chat.completion-shaped dict."""
        t0 = time.time()
        trailing_tools = []
        for m in reversed(messages):
            if m.get("role") != "tool":
                break
            trailing_tools.append(m)
        thread_id = self._thread_for(str(trailing_tools[0].get("tool_call_id"))) if trailing_tools else None
        if thread_id:
            body: dict = {"thread_id": thread_id, "tool_outputs": [{"tool_call_id": m.get("tool_call_id"), "output": str(m.get("content") or "")} for m in reversed(trailing_tools)]}
            r = httpx.post(f"{self.base}/threads/tool-outputs", json=body, headers=self._headers(), timeout=self.timeout)
        else:
            system, content = self._flatten(messages)
            body = {"content": content or "(empty)", "memory": "off", "model_name": model, "llm_provider": self.llm_provider}
            if system:
                body["system_prompt"] = system
            if tools:
                body["tools"] = tools
            if json_mode:
                body["json_output"] = True
            r = httpx.post(f"{self.base}/threads/messages", json=body, headers=self._headers(), timeout=self.timeout)
        r.raise_for_status()
        data = r.json()
        status = data.get("status")
        if status in ("FAILED", "CANCELLED"):
            raise BackboardError(f"backboard {status}: {data.get('content') or data.get('message')}")
        tool_calls = data.get("tool_calls") or []
        if tool_calls:
            self._remember([str(tc.get("id")) for tc in tool_calls], str(data.get("thread_id")))
        msg: dict = {"role": "assistant", "content": data.get("content")}
        if tool_calls:
            msg["tool_calls"] = tool_calls
        usage = {"prompt_tokens": data.get("input_tokens") or 0, "completion_tokens": data.get("output_tokens") or 0,
                 "total_tokens": data.get("total_tokens") or 0}
        return {
            "id": f"bb-{data.get('message_id') or data.get('thread_id')}",
            "object": "chat.completion",
            "created": int(t0),
            "model": data.get("model_name") or model,
            "choices": [{"index": 0, "message": msg, "finish_reason": "tool_calls" if tool_calls else "stop"}],
            "usage": usage,
            "backboard": {"thread_id": data.get("thread_id"), "status": status, "provider": data.get("model_provider")},
        }


@dataclass
class ChatResult:
    text: str
    model: str
    provider: str
    latency_ms: int
    usage: dict = field(default_factory=dict)
    raw_tool_calls: list[dict] = field(default_factory=list)


class LLMClient:
    """Minimal OpenAI-compatible chat client; JSON-mode helper for typed agent outputs."""

    def __init__(self, base: str = LLM_API_BASE, key: str = LLM_API_KEY, model: str = LLM_MODEL, timeout: float = LLM_TIMEOUT_S):
        self.base = base.rstrip("/")
        self.key = key
        self.model = model
        self.timeout = timeout
        self.provider = llm_provider_name()
        self.backboard = BackboardChat(timeout=timeout) if self.provider == "backboard" else None

    def available(self) -> bool:
        if self.backboard is not None:
            return self.backboard.available()
        try:
            r = httpx.get(f"{self.base}/models", headers=self._headers(), timeout=3)
            return r.status_code < 500
        except httpx.HTTPError:
            return False

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.key}"} if self.key else {}

    def chat(self, messages: list[dict], temperature: float = 0.1, json_mode: bool = False, max_tokens: int = 600) -> ChatResult:
        body: dict = {"model": self.model, "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        t0 = time.time()
        if self.backboard is not None:
            data = self.backboard.complete(messages, self.model, json_mode=json_mode)
        else:
            r = httpx.post(f"{self.base}/chat/completions", json=body, headers=self._headers(), timeout=self.timeout)
            r.raise_for_status()
            data = r.json()
        msg = data["choices"][0]["message"]
        return ChatResult(
            text=msg.get("content") or "",
            model=data.get("model", self.model),
            provider=self.provider,
            latency_ms=int((time.time() - t0) * 1000),
            usage=data.get("usage", {}),
            raw_tool_calls=msg.get("tool_calls") or [],
        )

    def chat_json(self, system: str, user: str, schema_hint: str, temperature: float = 0.1) -> tuple[dict, ChatResult]:
        prompt = f"{user}\n\nRespond with ONLY a JSON object matching this shape:\n{schema_hint}"
        res = self.chat([{"role": "system", "content": system}, {"role": "user", "content": prompt}], temperature, json_mode=True)
        txt = res.text.strip()
        if txt.startswith("```"):
            txt = txt.strip("`")
            txt = txt[txt.find("{"):]
        try:
            return json.loads(txt), res
        except json.JSONDecodeError:
            start, end = txt.find("{"), txt.rfind("}")
            if start >= 0 and end > start:
                return json.loads(txt[start : end + 1]), res
            raise


def elastic_client():
    """Returns an elasticsearch.Elasticsearch client or None if unavailable. Never fakes results."""
    try:
        from elasticsearch import Elasticsearch
    except ImportError:
        return None
    kwargs: dict = {"request_timeout": 5}
    if ELASTIC_API_KEY:
        kwargs["api_key"] = ELASTIC_API_KEY
    try:
        es = Elasticsearch(ELASTIC_URL, **kwargs)
        if not es.ping():
            return None
        return es
    except Exception:  # noqa: BLE001 - connection errors of any flavor mean "unavailable"
        return None


def elastic_provider_name() -> str:
    if os.environ.get("ELASTIC_CLOUD_URL") and ELASTIC_API_KEY:
        return "elastic-cloud"
    return "elasticsearch-local"


def sentry_enabled() -> bool:
    return bool(os.environ.get("SENTRY_DSN"))


def init_sentry() -> bool:
    if not sentry_enabled():
        return False
    import sentry_sdk

    sentry_sdk.init(dsn=os.environ["SENTRY_DSN"], traces_sample_rate=0.2, environment=os.environ.get("CITYSHIFT_ENV", "dev"))
    return True


def r2_configured() -> bool:
    return all(os.environ.get(k) for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"))


def provider_status() -> dict:
    llm = LLMClient()
    es = elastic_client()
    return {
        "llm": {"provider": llm.provider, "model": llm.model,
                "base": BACKBOARD_API_BASE if llm.backboard is not None else llm.base, "available": llm.available(),
                "sponsor": llm.provider in ("baseten", "backboard")},
        "evidence": {"provider": elastic_provider_name(), "available": es is not None, "url": ELASTIC_URL,
                     "sponsor": elastic_provider_name() == "elastic-cloud"},
        "sentry": {"enabled": sentry_enabled()},
        "map": {"mapbox_token_present": bool(os.environ.get("MAPBOX_TOKEN") or os.environ.get("VITE_MAPBOX_TOKEN"))},
        "share": {"r2_configured": r2_configured(), "mode": "cloudflare-r2" if r2_configured() else "local-export"},
    }


POPULATION_OPENROUTER_BASE = "https://openrouter.ai/api/v1"
POPULATION_KEY_URL = f"{POPULATION_OPENROUTER_BASE}/key"
POPULATION_KEY_DOCUMENTATION_URL = "https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key"
POPULATION_LIMITS_DOCUMENTATION_URL = "https://openrouter.ai/docs/api_reference/limits"
POPULATION_CATALOG_URL = f"{POPULATION_OPENROUTER_BASE}/models"
POPULATION_CATALOG_CHECKED_AT = "2026-09-19T22:41:28Z"
POPULATION_GATEWAY_BASE = f"http://127.0.0.1:{API_PORT}/api/population/model/v1"


@dataclass(frozen=True)
class PopulationProviderConfig:
    enabled: bool = False
    api_key: str = field(default="", repr=False)
    approved_40_key_policy: bool = False
    provider_budget: bool = False
    adopt_provider_key: bool = False


def population_provider_config() -> PopulationProviderConfig:
    return PopulationProviderConfig(
        enabled=os.environ.get("CITYSHIFT_POPULATION_LIVE") == "1",
        api_key=os.environ.get("OPENROUTER_API_KEY", ""),
        approved_40_key_policy=os.environ.get("CITYSHIFT_POPULATION_APPROVED_40_KEY") == "1",
        provider_budget=os.environ.get("CITYSHIFT_POPULATION_PROVIDER_BUDGET") == "1",
        adopt_provider_key=os.environ.get("CITYSHIFT_POPULATION_ADOPT_PROVIDER_KEY") == "1",
    )


@dataclass(frozen=True)
class PopulationModel:
    model_id: str
    canonical_slug: str
    family: str
    endpoint_tag: str
    endpoint_provider: str
    context_length: int
    max_completion_tokens: int
    pricing_json: str
    catalog_parameters: tuple[str, ...]
    endpoint_parameters: tuple[str, ...]
    implicit_caching: bool = False
    reasoning: bool = False
    ceiling_pricing_json: str = ""

    def catalog_entry(self) -> dict[str, Any]:
        return {
            "id": self.model_id,
            "canonical_slug": self.canonical_slug,
            "context_length": self.context_length,
            "pricing": json.loads(self.pricing_json),
            "top_provider": {
                "context_length": self.context_length,
                "max_completion_tokens": self.max_completion_tokens,
            },
            "supported_parameters": list(self.catalog_parameters),
        }

    def endpoint_entry(self) -> dict[str, Any]:
        return {
            "name": f"{self.endpoint_provider} | {self.canonical_slug}",
            "provider_name": self.endpoint_provider,
            "tag": self.endpoint_tag,
            "context_length": self.context_length,
            "max_prompt_tokens": None,
            "max_completion_tokens": self.max_completion_tokens,
            "pricing": json.loads(self.pricing_json) | {"discount": 0},
            "supported_parameters": list(self.endpoint_parameters),
            "status": 0,
            "supports_implicit_caching": self.implicit_caching,
        }

    def reservation_pricing(self) -> dict[str, Any]:
        return json.loads(self.ceiling_pricing_json or self.pricing_json)

    def _maximum_rate(self, *names: str) -> Decimal:
        prices = self.reservation_pricing()
        tiers = [prices, *prices.get("overrides", [])]
        return max(Decimal(str(tier.get(name, "0"))) for tier in tiers for name in names)

    def price_caps(self) -> dict[str, int]:
        with localcontext(Context(prec=64, rounding=ROUND_CEILING)):
            return {
                name: int((self._maximum_rate(name) * 1_000_000).to_integral_value(rounding=ROUND_CEILING))
                for name in ("prompt", "completion")
            } | {"request": 0}

    @property
    def input_rate(self) -> Decimal:
        with localcontext(Context(prec=64, rounding=ROUND_CEILING)):
            return (Decimal(self.price_caps()["prompt"]) / 1_000_000
                    + self._maximum_rate("input_cache_read")
                    + self._maximum_rate("input_cache_write", "input_cache_write_1h"))

    @property
    def output_rate(self) -> Decimal:
        with localcontext(Context(prec=64, rounding=ROUND_CEILING)):
            return (Decimal(self.price_caps()["completion"]) / 1_000_000
                    + self._maximum_rate("internal_reasoning"))

    def provenance(self) -> dict[str, Any]:
        frozen = {"catalog": self.catalog_entry(), "endpoint": self.endpoint_entry(),
                  "reservation_pricing": self.reservation_pricing(),
                  "reservation_endpoint_scope": "all_public_endpoints_including_region_priority_and_context_tiers"}
        digest = hashlib.sha256(json.dumps(frozen, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        return {
            "model_id": self.model_id,
            "canonical_slug": self.canonical_slug,
            "family": self.family,
            "api_provider": "openrouter",
            "catalog_url": POPULATION_CATALOG_URL,
            "endpoint_catalog_url": f"{POPULATION_CATALOG_URL}/{self.model_id}/endpoints",
            "checked_at": POPULATION_CATALOG_CHECKED_AT,
            "snapshot_sha256": digest,
            "selection_basis": "cost_and_capability_breadth_not_rankings",
            "reservation_basis": "full_catalog_context_plus_capped_output_with_tiers_and_cache_writes",
            "input_ceiling_dollars_per_token": str(self.input_rate),
            "output_ceiling_dollars_per_token": str(self.output_rate),
            **frozen,
        }


POPULATION_MODELS = MappingProxyType({
    "anthropic/claude-haiku-4.5": PopulationModel(
        model_id="anthropic/claude-haiku-4.5",
        canonical_slug="anthropic/claude-4.5-haiku-20251001",
        family="claude", endpoint_tag="anthropic", endpoint_provider="Anthropic",
        context_length=200_000, max_completion_tokens=64_000,
        pricing_json=json.dumps({
            "prompt": "0.000001", "completion": "0.000005", "web_search": "0.01",
            "input_cache_read": "0.0000001", "input_cache_write": "0.00000125",
            "input_cache_write_1h": "0.000002",
        }),
        catalog_parameters=("include_reasoning", "max_completion_tokens", "max_tokens", "reasoning",
                            "response_format", "stop", "structured_outputs", "temperature",
                            "tool_choice", "tools", "top_k", "top_p"),
        endpoint_parameters=("max_tokens", "top_p", "temperature", "stop", "reasoning",
                             "include_reasoning", "tools", "tool_choice", "top_k",
                             "structured_outputs", "response_format"),
        reasoning=True,
        ceiling_pricing_json=json.dumps({
            "prompt": "0.0000011", "completion": "0.0000055", "web_search": "0.01",
            "input_cache_read": "0.00000011", "input_cache_write": "0.000001375",
            "input_cache_write_1h": "0.0000022",
        }),
    ),
    "openai/gpt-4.1-mini": PopulationModel(
        model_id="openai/gpt-4.1-mini", canonical_slug="openai/gpt-4.1-mini-2025-04-14",
        family="openai", endpoint_tag="openai", endpoint_provider="OpenAI",
        context_length=1_047_576, max_completion_tokens=32_768,
        pricing_json=json.dumps({
            "prompt": "0.0000004", "completion": "0.0000016", "web_search": "0.01",
            "input_cache_read": "0.0000001",
        }),
        catalog_parameters=("max_completion_tokens", "max_tokens", "response_format", "seed",
                            "structured_outputs", "temperature", "tool_choice", "tools", "top_p"),
        endpoint_parameters=("seed", "max_tokens", "response_format", "structured_outputs", "tools",
                             "tool_choice", "temperature", "top_p"),
        ceiling_pricing_json=json.dumps({
            "prompt": "0.00000044", "completion": "0.00000176", "web_search": "0.01",
            "input_cache_read": "0.00000011",
        }),
    ),
    "google/gemini-3.1-flash-lite": PopulationModel(
        model_id="google/gemini-3.1-flash-lite",
        canonical_slug="google/gemini-3.1-flash-lite-20260507", family="gemini",
        endpoint_tag="google-ai-studio", endpoint_provider="Google AI Studio",
        context_length=1_048_576, max_completion_tokens=65_536,
        pricing_json=json.dumps({
            "prompt": "0.00000025", "completion": "0.0000015", "image": "0.00000025",
            "audio": "0.0000005", "input_audio_cache": "0.00000005", "web_search": "0.014",
            "internal_reasoning": "0.0000015", "input_cache_read": "0.000000025",
            "input_cache_write": "0.0000000833333333333333",
        }),
        catalog_parameters=("include_reasoning", "max_tokens", "reasoning", "reasoning_effort",
                            "response_format", "seed", "stop", "structured_outputs", "temperature",
                            "tool_choice", "tools", "top_p"),
        endpoint_parameters=("reasoning", "include_reasoning", "max_tokens", "temperature", "top_p",
                             "seed", "response_format", "structured_outputs", "tool_choice", "tools",
                             "reasoning_effort"),
        implicit_caching=True, reasoning=True,
        ceiling_pricing_json=json.dumps({
            "prompt": "0.00000045", "completion": "0.0000027", "image": "0.00000045",
            "audio": "0.0000009", "input_audio_cache": "0.00000009", "web_search": "0.014",
            "internal_reasoning": "0.0000027", "input_cache_read": "0.000000045",
            "input_cache_write": "0.00000015",
        }),
    ),
    "x-ai/grok-4.3": PopulationModel(
        model_id="x-ai/grok-4.3", canonical_slug="x-ai/grok-4.3-20260430", family="grok",
        endpoint_tag="xai", endpoint_provider="xAI", context_length=1_000_000,
        max_completion_tokens=900_000,
        pricing_json=json.dumps({
            "prompt": "0.00000125", "completion": "0.0000025", "web_search": "0.005",
            "input_cache_read": "0.0000002", "overrides": [{
                "min_prompt_tokens": 200_000, "prompt": "0.0000025", "completion": "0.000005",
                "input_cache_read": "0.0000004",
            }],
        }),
        catalog_parameters=("include_reasoning", "logprobs", "max_tokens", "reasoning", "reasoning_effort",
                            "response_format", "seed", "structured_outputs", "temperature", "tool_choice",
                            "tools", "top_logprobs", "top_p"),
        endpoint_parameters=("reasoning", "include_reasoning", "structured_outputs", "response_format",
                             "max_tokens", "temperature", "top_p", "seed", "logprobs", "top_logprobs",
                             "tools", "tool_choice", "reasoning_effort"),
        reasoning=True,
        ceiling_pricing_json=json.dumps({
            "prompt": "0.000005", "completion": "0.00001", "web_search": "0.005",
            "input_cache_read": "0.0000008",
        }),
    ),
})
