"""External provider adapters. Each reports honestly whether it is the sponsor service or a local fallback.

- LLM: OpenAI-compatible chat endpoint. Baseten when LLM_API_BASE points at Baseten and LLM_API_KEY is set;
  otherwise the local Ollama server. The adapter never claims one while using the other.
- Elasticsearch: ELASTIC_CLOUD_URL + ELASTIC_API_KEY (Elastic Cloud) or ELASTIC_URL (local), else unavailable.
- Sentry: enabled only when SENTRY_DSN is set.
- Map: Mapbox only when a token is present; otherwise MapLibre + OpenFreeMap tiles (decided in the frontend).
- Replay share: Cloudflare R2 only when credentials are present; otherwise local export.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field

import httpx

LLM_API_BASE = os.environ.get("LLM_API_BASE", "http://localhost:11434/v1")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_MODEL = os.environ.get("LLM_MODEL", "qwen2.5:7b")
ELASTIC_URL = os.environ.get("ELASTIC_CLOUD_URL") or os.environ.get("ELASTIC_URL", "http://localhost:9200")
ELASTIC_API_KEY = os.environ.get("ELASTIC_API_KEY", "")


def llm_provider_name() -> str:
    if "baseten" in LLM_API_BASE and LLM_API_KEY:
        return "baseten"
    if "localhost" in LLM_API_BASE or "127.0.0.1" in LLM_API_BASE:
        return "ollama-local"
    return "openai-compatible"


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

    def __init__(self, base: str = LLM_API_BASE, key: str = LLM_API_KEY, model: str = LLM_MODEL, timeout: float = 120):
        self.base = base.rstrip("/")
        self.key = key
        self.model = model
        self.timeout = timeout
        self.provider = llm_provider_name()

    def available(self) -> bool:
        try:
            r = httpx.get(f"{self.base}/models", headers=self._headers(), timeout=3)
            return r.status_code < 500
        except httpx.HTTPError:
            return False

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.key}"} if self.key else {}

    def chat(self, messages: list[dict], temperature: float = 0.1, json_mode: bool = False, max_tokens: int = 1200) -> ChatResult:
        body: dict = {"model": self.model, "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        t0 = time.time()
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
        "llm": {"provider": llm.provider, "model": llm.model, "base": llm.base, "available": llm.available(),
                "sponsor": llm.provider == "baseten"},
        "evidence": {"provider": elastic_provider_name(), "available": es is not None, "url": ELASTIC_URL,
                     "sponsor": elastic_provider_name() == "elastic-cloud"},
        "sentry": {"enabled": sentry_enabled()},
        "map": {"mapbox_token_present": bool(os.environ.get("MAPBOX_TOKEN") or os.environ.get("VITE_MAPBOX_TOKEN"))},
        "share": {"r2_configured": r2_configured(), "mode": "cloudflare-r2" if r2_configured() else "local-export"},
    }
