from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
import secrets
import sqlite3
import threading
import time
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime
from decimal import ROUND_CEILING, ROUND_FLOOR, Context, Decimal, InvalidOperation, localcontext
from pathlib import Path
from typing import Any

import httpx

from cityshift.providers import (
    POPULATION_CATALOG_URL,
    POPULATION_GATEWAY_BASE,
    POPULATION_KEY_DOCUMENTATION_URL,
    POPULATION_KEY_URL,
    POPULATION_LIMITS_DOCUMENTATION_URL,
    POPULATION_MODELS,
    POPULATION_OPENROUTER_BASE,
    PopulationModel,
    PopulationProviderConfig,
    population_provider_config,
)

SESSION_CAP_MICRODOLLARS = 20_000_000
DEFAULT_LEDGER_PATH = Path(__file__).resolve().parents[2] / "var" / "population" / "model-budget.sqlite3"
MAX_REQUEST_BYTES = 65_536
MAX_RESPONSE_BYTES = 1_048_576
MAX_CATALOG_BYTES = 8_388_608
MAX_KEY_METADATA_BYTES = 32_768
KEY_PREFLIGHT_TIMEOUT_SECONDS = 10
KEY_READINESS_MAX_AGE_SECONDS = 30
MAX_OUTPUT_TOKENS = 2_048
MAX_SESSION_REQUESTS_PER_MINUTE = 120
MAX_SESSION_TOKENS_PER_MINUTE = 100_000_000
DEFAULT_TOOL_NAMES = frozenset({
    "observe_local_state", "recall_experience", "view_tasks", "estimate_trip", "propose_message", "propose_action",
})
FORBIDDEN_TOOL_NAMES = frozenset({
    "web_search", "web_search_preview", "browser", "browse", "shell", "bash", "exec", "execute",
    "execute_code", "run_command", "python", "http_request", "fetch_url", "read_file", "write_file",
    "send_email", "send_payment", "payment",
})
NAME_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_-]{0,63}\Z")
ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,160}\Z")
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{32,256}\Z")
ERRORS = {
    "unauthorized": (401, "A registered population gateway bearer token is required."),
    "unavailable": (503, "Live population inference is not explicitly enabled or configured."),
    "invalid_request": (400, "The population model request contains unsupported or invalid fields."),
    "payload_too_large": (413, "The population model request exceeds the bounded payload size."),
    "unsupported_model": (400, "The model is not registered for this population run."),
    "unsupported_pricing": (503, "The reviewed public model, endpoint, or pricing catalog cannot be verified."),
    "provider_cap_unverified": (503, "The non-renewing OpenRouter key cap does not match the explicitly approved provider policy."),
    "provider_cap_insufficient": (402, "The verified provider cap cannot cover the remaining session exposure."),
    "provider_cap_changed": (503, "Provider cap or credential continuity changed; no budget was restored."),
    "run_conflict": (409, "Population run registration or immutable limits conflict."),
    "budget_exhausted": (402, "The persistent implementation-session model budget is exhausted."),
    "run_limit_exceeded": (429, "The population run call, token, or cost ceiling is exhausted."),
    "rate_limit_exceeded": (429, "The population model request or token rate quota is exhausted."),
    "ledger_unavailable": (503, "The persistent population budget ledger is unavailable."),
    "accounting_violation": (503, "Provider accounting or provenance violated the reserved boundary; dispatch is blocked."),
    "upstream_failure": (502, "The model provider failed; its reservation has been retained."),
    "upstream_timeout": (504, "The model deadline expired; any dispatched reservation has been retained."),
    "usage_unavailable": (502, "Complete provider usage is unavailable; the reservation has been retained."),
    "invalid_response": (502, "The model provider returned an unsupported completion."),
}


class GatewayError(RuntimeError):
    def __init__(self, code: str):
        self.code = code if code in ERRORS else "unavailable"
        self.status_code, message = ERRORS[self.code]
        super().__init__(message)

    def public_error(self) -> dict[str, Any]:
        return {"error": {"message": str(self), "type": "population_gateway_error", "code": self.code}}


def _integer(value: Any, minimum: int = 0, maximum: int = 2**53) -> bool:
    return type(value) is int and minimum <= value <= maximum


def _microdollars(value: Decimal) -> int:
    with localcontext(Context(prec=64, rounding=ROUND_CEILING)):
        return int(value.quantize(Decimal("0.000001"), rounding=ROUND_CEILING) * 1_000_000)


def _floor_microdollars(value: Decimal) -> int:
    with localcontext(Context(prec=64, rounding=ROUND_FLOOR)):
        return int(value.quantize(Decimal("0.000001"), rounding=ROUND_FLOOR) * 1_000_000)


def _provider_dollars(value: Any) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
        raise GatewayError("provider_cap_unverified")
    amount = Decimal(value)
    if not amount.is_finite() or not 0 <= amount <= 1_000_000_000:
        raise GatewayError("provider_cap_unverified")
    return amount


def _json(data: Any) -> str:
    try:
        return json.dumps(data, ensure_ascii=True, allow_nan=False, sort_keys=True, separators=(",", ":"))
    except (ValueError, TypeError, RecursionError, OverflowError):
        raise GatewayError("invalid_request") from None


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _invalid_constant(value: str) -> Any:
    raise ValueError("invalid JSON constant")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON field")
        value[key] = item
    return value


def parse_json(raw: bytes, *, exact_numbers: bool = False) -> dict[str, Any]:
    try:
        value = json.loads(raw, parse_float=Decimal if exact_numbers else float,
                           parse_constant=_invalid_constant, object_pairs_hook=_unique_object)
    except (ValueError, UnicodeError, RecursionError, InvalidOperation):
        raise GatewayError("invalid_request") from None
    if not isinstance(value, dict):
        raise GatewayError("invalid_request")
    return value


@dataclass(frozen=True)
class RunLimits:
    max_calls: int = 256
    max_tokens: int = 20_000_000
    max_cost_microdollars: int = SESSION_CAP_MICRODOLLARS
    requests_per_minute: int = 60
    tokens_per_minute: int = 20_000_000
    max_output_tokens: int = 512
    max_request_bytes: int = MAX_REQUEST_BYTES
    request_timeout_seconds: int = 45

    def validate(self) -> None:
        bounds = {
            "max_calls": 1_000_000, "max_tokens": 1_000_000_000,
            "max_cost_microdollars": SESSION_CAP_MICRODOLLARS,
            "requests_per_minute": 1_000_000, "tokens_per_minute": 1_000_000_000,
            "max_output_tokens": MAX_OUTPUT_TOKENS, "max_request_bytes": MAX_REQUEST_BYTES,
            "request_timeout_seconds": 120,
        }
        if any(not _integer(getattr(self, name), 1, upper) for name, upper in bounds.items()):
            raise GatewayError("invalid_request")


@dataclass(frozen=True)
class RunRegistration:
    run_id: str
    token: str = field(repr=False)
    model_ids: tuple[str, ...]
    limits: RunLimits
    api_base: str = POPULATION_GATEWAY_BASE

    def model_config(self, model_id: str) -> tuple[str, str, str]:
        if model_id not in self.model_ids:
            raise GatewayError("unsupported_model")
        return self.api_base, self.token, model_id


@dataclass(frozen=True)
class RunScope:
    run_hash: str
    token_hash: str = field(repr=False)
    model_ids: tuple[str, ...]
    allowed_tools: frozenset[str]
    limits: RunLimits


@dataclass(frozen=True)
class RequestQuote:
    model_id: str
    input_tokens: int
    output_tokens: int
    ceiling_microdollars: int
    payload_token_estimate: int


@dataclass(frozen=True)
class ProviderCapSnapshot:
    limit_microdollars: int
    remaining_microdollars: int
    usage_microdollars: int
    expires_at: float | None
    byok_included_in_limit: bool = True

    @classmethod
    def from_response(cls, response: dict[str, Any], now: float, *, approved_40_key_policy: bool = False) -> ProviderCapSnapshot:
        data = response.get("data")
        if (not isinstance(data, dict) or "limit_reset" not in data or data["limit_reset"] is not None
                or type(data.get("include_byok_in_limit")) is not bool
                or (not approved_40_key_policy and not data["include_byok_in_limit"])
                or data.get("is_management_key") is not False or data.get("is_provisioning_key") is not False):
            raise GatewayError("provider_cap_unverified")
        limit = _provider_dollars(data.get("limit"))
        remaining = _provider_dollars(data.get("limit_remaining"))
        usage = _provider_dollars(data.get("usage"))
        if not 0 < limit <= (40 if approved_40_key_policy else 20) or _provider_dollars(data.get("byok_usage")) != 0:
            raise GatewayError("provider_cap_unverified")
        limit_microdollars = _floor_microdollars(limit)
        remaining_microdollars = _floor_microdollars(remaining)
        usage_microdollars = _microdollars(usage)
        if (limit_microdollars == 0 or remaining > limit
                or remaining_microdollars > max(0, limit_microdollars - usage_microdollars)):
            raise GatewayError("provider_cap_unverified")
        expiry = data.get("expires_at")
        expires_at = None
        if expiry is not None:
            if not isinstance(expiry, str) or len(expiry) > 40:
                raise GatewayError("provider_cap_unverified")
            try:
                stamp = datetime.fromisoformat(expiry)
                if stamp.tzinfo is None:
                    raise ValueError("timezone required")
                expires_at = stamp.timestamp()
                if not math.isfinite(expires_at) or expires_at <= now:
                    raise ValueError("expired")
            except (ValueError, OverflowError, OSError):
                raise GatewayError("provider_cap_unverified") from None
        return cls(limit_microdollars, remaining_microdollars, usage_microdollars, expires_at, data["include_byok_in_limit"])


class BudgetLedger:
    def __init__(self, path: Path, limit_microdollars: int = SESSION_CAP_MICRODOLLARS):
        if not _integer(limit_microdollars, 1, SESSION_CAP_MICRODOLLARS):
            raise GatewayError("invalid_request")
        self.path = path
        try:
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with self._connection() as connection:
                connection.execute("PRAGMA journal_mode=WAL")
                connection.execute("BEGIN IMMEDIATE")
                connection.execute("""CREATE TABLE IF NOT EXISTS session (
                    id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL,
                    limit_microdollars INTEGER NOT NULL, blocked INTEGER NOT NULL DEFAULT 0,
                    last_time REAL NOT NULL DEFAULT 0
                )""")
                connection.execute("""CREATE TABLE IF NOT EXISTS runs (
                    run_hash TEXT PRIMARY KEY, token_hash TEXT UNIQUE,
                    models_json TEXT NOT NULL, tools_json TEXT NOT NULL, limits_json TEXT NOT NULL
                )""")
                connection.execute("""CREATE TABLE IF NOT EXISTS requests (
                    request_id TEXT PRIMARY KEY, run_hash TEXT NOT NULL, created_at REAL NOT NULL,
                    assigned_model TEXT NOT NULL, resolved_model TEXT, snapshot_sha256 TEXT,
                    api_provider TEXT NOT NULL DEFAULT 'openrouter', endpoint_provider TEXT,
                    status TEXT NOT NULL, reserved_microdollars INTEGER NOT NULL,
                    accounted_microdollars INTEGER NOT NULL, reserved_input_tokens INTEGER NOT NULL,
                    reserved_output_tokens INTEGER NOT NULL, accounted_tokens INTEGER NOT NULL,
                    reported_cost_microdollars INTEGER, reported_input_tokens INTEGER,
                    reported_output_tokens INTEGER, reported_total_tokens INTEGER,
                    latency_ms INTEGER NOT NULL DEFAULT 0
                )""")
                columns = {column["name"] for column in connection.execute("PRAGMA table_info(requests)")}
                if "snapshot_sha256" not in columns:
                    connection.execute("ALTER TABLE requests ADD COLUMN snapshot_sha256 TEXT")
                connection.execute("CREATE INDEX IF NOT EXISTS requests_run ON requests(run_hash, created_at)")
                connection.execute("CREATE INDEX IF NOT EXISTS requests_time ON requests(created_at)")
                connection.execute("""CREATE TABLE IF NOT EXISTS catalog (
                    snapshot_sha256 TEXT PRIMARY KEY, provenance_json TEXT NOT NULL
                )""")
                connection.execute("""CREATE TABLE IF NOT EXISTS provider_cap (
                    id INTEGER PRIMARY KEY CHECK (id = 1), credential_binding TEXT,
                    status TEXT NOT NULL, limit_microdollars INTEGER, remaining_microdollars INTEGER,
                    usage_microdollars INTEGER, usage_hold_microdollars INTEGER NOT NULL DEFAULT 0,
                    verified_at REAL, expires_at REAL
                )""")
                columns = {column["name"] for column in connection.execute("PRAGMA table_info(provider_cap)")}
                if "byok_included_in_limit" not in columns:
                    connection.execute("ALTER TABLE provider_cap ADD COLUMN byok_included_in_limit INTEGER")
                connection.execute("INSERT OR IGNORE INTO provider_cap(id, status) VALUES(1, 'provider_cap_unverified')")
                connection.execute(
                    "INSERT OR IGNORE INTO session(id, version, limit_microdollars) VALUES(1, 1, ?)",
                    (limit_microdollars,),
                )
                session = connection.execute("SELECT * FROM session WHERE id=1").fetchone()
                if session is None or session["version"] != 1:
                    raise GatewayError("ledger_unavailable")
                connection.execute(
                    "UPDATE session SET limit_microdollars=MIN(limit_microdollars, ?) WHERE id=1",
                    (limit_microdollars,),
                )
                for model in POPULATION_MODELS.values():
                    provenance = model.provenance()
                    connection.execute("INSERT OR IGNORE INTO catalog VALUES(?, ?)",
                                       (provenance["snapshot_sha256"], _json(provenance)))
            os.chmod(path, 0o600)
        except OSError:
            raise GatewayError("ledger_unavailable") from None

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection: sqlite3.Connection | None = None
        try:
            connection = sqlite3.connect(self.path, timeout=5, isolation_level=None)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA synchronous=FULL")
            yield connection
            if connection.in_transaction:
                connection.commit()
        except (sqlite3.Error, OSError):
            if connection is not None and connection.in_transaction:
                connection.rollback()
            raise GatewayError("ledger_unavailable") from None
        finally:
            if connection is not None:
                connection.close()

    @staticmethod
    def _provider_readiness(connection: sqlite3.Connection, binding: str | None, now: float) -> dict[str, Any]:
        cap = connection.execute("SELECT * FROM provider_cap WHERE id=1").fetchone()
        session = connection.execute("SELECT * FROM session WHERE id=1").fetchone()
        if cap is None or session is None:
            raise GatewayError("ledger_unavailable")
        accounted = connection.execute("SELECT COALESCE(SUM(accounted_microdollars), 0) FROM requests").fetchone()[0]
        session_remaining = max(0, session["limit_microdollars"] - accounted - cap["usage_hold_microdollars"])
        provider_available = max(0, (cap["remaining_microdollars"] or 0) - accounted)
        verified_at = cap["verified_at"]
        fresh = (math.isfinite(now) and verified_at is not None
                 and -1 <= now - verified_at <= KEY_READINESS_MAX_AGE_SECONDS)
        expires_at = cap["expires_at"]
        current = (cap["status"] == "verified" and fresh and cap["byok_included_in_limit"] in (0, 1)
                   and binding is not None and cap["credential_binding"] == binding
                   and (expires_at is None or expires_at > now))
        code = None
        if session["blocked"]:
            code = "accounting_violation"
        elif cap["status"] != "verified":
            code = cap["status"]
        elif binding is not None and cap["credential_binding"] != binding:
            code = "provider_cap_changed"
        elif not current:
            code = "provider_cap_unverified"
        elif session_remaining == 0:
            code = "budget_exhausted"
        elif provider_available < session_remaining:
            code = "provider_cap_insufficient"
        return {
            "ready": code is None, "code": code,
            "verification_url": POPULATION_KEY_URL,
            "documentation_url": POPULATION_KEY_DOCUMENTATION_URL,
            "limits_documentation_url": POPULATION_LIMITS_DOCUMENTATION_URL,
            "verified_at": verified_at, "expires_at": expires_at,
            "provider_limit_microdollars": cap["limit_microdollars"],
            "provider_remaining_microdollars": cap["remaining_microdollars"],
            "provider_usage_microdollars": cap["usage_microdollars"],
            "provider_usage_hold_microdollars": cap["usage_hold_microdollars"],
            "request_accounted_microdollars": accounted,
            "required_microdollars": session_remaining,
            "available_microdollars": min(session_remaining, provider_available),
            "non_renewing": True if current else None,
            "byok_included_in_limit": bool(cap["byok_included_in_limit"]) if current else None,
            "provider_usage_overlap_assumed": False,
            "dedicated_key_required": True,
            "inference_verified": False,
        }

    def provider_readiness(self, binding: str | None, now: float) -> dict[str, Any]:
        with self._connection() as connection:
            connection.execute("BEGIN")
            return self._provider_readiness(connection, binding, now)

    def record_provider_cap(self, snapshot: ProviderCapSnapshot, binding: str, now: float) -> None:
        if not math.isfinite(now):
            raise GatewayError("provider_cap_unverified")
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            previous = connection.execute("SELECT * FROM provider_cap WHERE id=1").fetchone()
            if previous is None:
                raise GatewayError("ledger_unavailable")
            if previous["credential_binding"] is not None and (
                    previous["credential_binding"] != binding
                    or snapshot.limit_microdollars > previous["limit_microdollars"]
                    or snapshot.remaining_microdollars > previous["remaining_microdollars"]
                    or snapshot.usage_microdollars < previous["usage_microdollars"]
                    or previous["byok_included_in_limit"] == 1 and not snapshot.byok_included_in_limit):
                raise GatewayError("provider_cap_changed")
            connection.execute("""UPDATE provider_cap SET credential_binding=?, status='verified',
                limit_microdollars=?, remaining_microdollars=?, usage_microdollars=?,
                usage_hold_microdollars=MAX(usage_hold_microdollars, ?),
                verified_at=MAX(COALESCE(verified_at, ?), ?), expires_at=?, byok_included_in_limit=? WHERE id=1""",
                (binding, snapshot.limit_microdollars, snapshot.remaining_microdollars,
                 snapshot.usage_microdollars, snapshot.usage_microdollars, now, now, snapshot.expires_at,
                 int(snapshot.byok_included_in_limit)))

    def provider_failure(self, code: str) -> None:
        if code not in {"provider_cap_unverified", "provider_cap_changed", "unavailable"}:
            code = "provider_cap_unverified"
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("UPDATE provider_cap SET status=? WHERE id=1", (code,))

    def register(self, scope: RunScope) -> None:
        models, tools, limits = _json(scope.model_ids), _json(sorted(scope.allowed_tools)), _json(asdict(scope.limits))
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute("SELECT * FROM runs WHERE run_hash=?", (scope.run_hash,)).fetchone()
            if existing is not None:
                if (existing["models_json"], existing["tools_json"], existing["limits_json"]) != (models, tools, limits):
                    raise GatewayError("run_conflict")
                if existing["token_hash"] not in (None, scope.token_hash):
                    raise GatewayError("run_conflict")
                connection.execute("UPDATE runs SET token_hash=? WHERE run_hash=?", (scope.token_hash, scope.run_hash))
            else:
                connection.execute("INSERT INTO runs VALUES(?, ?, ?, ?, ?)",
                                   (scope.run_hash, scope.token_hash, models, tools, limits))

    def unregister(self, run_id: str) -> None:
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("UPDATE runs SET token_hash=NULL WHERE run_hash=?", (_digest(run_id),))

    def authenticate(self, token: str) -> RunScope:
        if not isinstance(token, str) or TOKEN_PATTERN.fullmatch(token) is None:
            raise GatewayError("unauthorized")
        token_hash = _digest(token)
        with self._connection() as connection:
            row = connection.execute("SELECT * FROM runs WHERE token_hash=?", (token_hash,)).fetchone()
        if row is None:
            raise GatewayError("unauthorized")
        return RunScope(row["run_hash"], token_hash, tuple(json.loads(row["models_json"])),
                        frozenset(json.loads(row["tools_json"])), RunLimits(**json.loads(row["limits_json"])))

    def reserve(self, scope: RunScope, quote: RequestQuote, now: float, provider_binding: str) -> str:
        if not math.isfinite(now):
            raise GatewayError("ledger_unavailable")
        request_id = f"population-{secrets.token_hex(16)}"
        tokens = quote.input_tokens + quote.output_tokens
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT token_hash FROM runs WHERE run_hash=?", (scope.run_hash,)).fetchone()
            if row is None or row["token_hash"] != scope.token_hash:
                raise GatewayError("unauthorized")
            session = connection.execute("SELECT * FROM session WHERE id=1").fetchone()
            if session is None:
                raise GatewayError("ledger_unavailable")
            if session["blocked"]:
                raise GatewayError("accounting_violation")
            readiness = self._provider_readiness(connection, provider_binding, now)
            if not readiness["ready"]:
                raise GatewayError(readiness["code"])
            cost = readiness["request_accounted_microdollars"] + readiness["provider_usage_hold_microdollars"]
            if (cost + quote.ceiling_microdollars > session["limit_microdollars"]
                    or quote.ceiling_microdollars > readiness["available_microdollars"]):
                raise GatewayError("budget_exhausted")
            run = connection.execute("""SELECT COUNT(*), COALESCE(SUM(accounted_tokens), 0),
                COALESCE(SUM(accounted_microdollars), 0) FROM requests WHERE run_hash=?""", (scope.run_hash,)).fetchone()
            if (run[0] >= scope.limits.max_calls or run[1] + tokens > scope.limits.max_tokens
                    or run[2] + quote.ceiling_microdollars > scope.limits.max_cost_microdollars):
                raise GatewayError("run_limit_exceeded")
            now = max(now, session["last_time"])
            window = connection.execute("""SELECT COUNT(*),
                COALESCE(SUM(accounted_tokens), 0)
                FROM requests WHERE run_hash=? AND created_at>?""", (scope.run_hash, now - 60)).fetchone()
            global_window = connection.execute("""SELECT COUNT(*),
                COALESCE(SUM(accounted_tokens), 0)
                FROM requests WHERE created_at>?""", (now - 60,)).fetchone()
            if (window[0] >= scope.limits.requests_per_minute
                    or window[1] + tokens > scope.limits.tokens_per_minute
                    or global_window[0] >= MAX_SESSION_REQUESTS_PER_MINUTE
                    or global_window[1] + tokens > MAX_SESSION_TOKENS_PER_MINUTE):
                raise GatewayError("rate_limit_exceeded")
            connection.execute("UPDATE session SET last_time=? WHERE id=1", (now,))
            connection.execute("""INSERT INTO requests(
                request_id, run_hash, created_at, assigned_model, status, reserved_microdollars,
                accounted_microdollars, reserved_input_tokens, reserved_output_tokens, accounted_tokens, snapshot_sha256
                ) VALUES(?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?)""",
                (request_id, scope.run_hash, now, quote.model_id, quote.ceiling_microdollars,
                 quote.ceiling_microdollars, quote.input_tokens, quote.output_tokens, tokens,
                 POPULATION_MODELS[quote.model_id].provenance()["snapshot_sha256"]))
        return request_id

    def fail(self, request_id: str, status: str, latency_ms: int) -> None:
        if status not in {*ERRORS, "cancelled"}:
            status = "upstream_failure"
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("UPDATE requests SET status=?, latency_ms=? WHERE request_id=? AND status='reserved'",
                               (status, latency_ms, request_id))

    def settle(self, request_id: str, quote: RequestQuote, data: dict[str, Any], latency_ms: int,
               valid_completion: bool) -> dict[str, Any]:
        model = POPULATION_MODELS[quote.model_id]
        known_models = {name for item in POPULATION_MODELS.values() for name in (item.model_id, item.canonical_slug)}
        candidate = data.get("model")
        resolved = candidate if isinstance(candidate, str) and candidate in known_models else None
        provider = data.get("provider") if data.get("provider") == model.endpoint_provider else None
        identity_valid = resolved in (model.model_id, model.canonical_slug) and provider is not None
        raw_usage = data.get("usage")
        raw_usage = raw_usage if isinstance(raw_usage, dict) else {}
        prompt, output, total = (raw_usage.get(name) for name in ("prompt_tokens", "completion_tokens", "total_tokens"))
        prompt = prompt if _integer(prompt) else None
        output = output if _integer(output) else None
        total = total if _integer(total) else None
        cost: Decimal | None = None
        raw_cost = raw_usage.get("cost")
        if isinstance(raw_cost, (str, int, Decimal)) and not isinstance(raw_cost, bool):
            try:
                parsed_cost = Decimal(raw_cost)
                if parsed_cost.is_finite() and 0 <= parsed_cost <= 1_000_000_000:
                    cost = parsed_cost
            except (InvalidOperation, ValueError):
                pass
        reported = _microdollars(cost) if cost is not None else None
        complete = all(value is not None for value in (prompt, output, total, reported))
        token_violation = ((prompt is not None and prompt > quote.input_tokens)
                           or (output is not None and output > quote.output_tokens)
                           or (prompt is not None and output is not None and total is not None and total != prompt + output))
        billing_violation = raw_usage.get("is_byok") not in (None, False)
        server_tools = raw_usage.get("server_tool_use")
        if server_tools is not None:
            billing_violation |= not isinstance(server_tools, dict) or any(server_tools.values())
        for name, ceiling in (("prompt_tokens_details", quote.input_tokens),
                              ("completion_tokens_details", quote.output_tokens)):
            details = raw_usage.get(name)
            if details is None:
                continue
            if not isinstance(details, dict):
                billing_violation = True
                continue
            for kind, count in details.items():
                if count is None:
                    continue
                if not _integer(count, 0, ceiling):
                    token_violation = True
                if kind not in {"cached_tokens", "cache_write_tokens", "reasoning_tokens",
                                "accepted_prediction_tokens", "rejected_prediction_tokens"} and count != 0:
                    billing_violation = True
        violation = (not identity_valid or token_violation or billing_violation
                     or (reported is not None and reported > quote.ceiling_microdollars))
        status = "succeeded" if valid_completion else "invalid_response"
        if not complete:
            status = "usage_unavailable"
        if violation:
            status = "accounting_violation"
        accounted = (reported if complete and not violation else max(quote.ceiling_microdollars, reported or 0))
        accounted_tokens = total if complete and not violation else max(quote.input_tokens + quote.output_tokens, total or 0)
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("""UPDATE requests SET resolved_model=?, endpoint_provider=?, status=?,
                accounted_microdollars=?, accounted_tokens=?, reported_cost_microdollars=?,
                reported_input_tokens=?, reported_output_tokens=?, reported_total_tokens=?, latency_ms=?
                WHERE request_id=? AND status='reserved'""",
                (resolved, provider, status, accounted, accounted_tokens, reported, prompt, output, total,
                 latency_ms, request_id))
            if violation:
                connection.execute("UPDATE session SET blocked=1 WHERE id=1")
        if status != "succeeded":
            raise GatewayError(status)
        return {"prompt_tokens": prompt, "completion_tokens": output, "total_tokens": total, "cost": str(cost)}

    def usage(self, run_id: str | None = None) -> dict[str, Any]:
        with self._connection() as connection:
            connection.execute("BEGIN")
            session = connection.execute("SELECT * FROM session WHERE id=1").fetchone()
            totals = connection.execute("SELECT COUNT(*), COALESCE(SUM(accounted_microdollars), 0) FROM requests").fetchone()
            provider = connection.execute("SELECT usage_hold_microdollars FROM provider_cap WHERE id=1").fetchone()
            if session is None or provider is None:
                raise GatewayError("ledger_unavailable")
            accounted = totals[1] + provider[0]
            where = "" if run_id is None else " WHERE run_hash=?"
            parameters = () if run_id is None else (_digest(run_id),)
            run_totals = connection.execute(
                "SELECT COUNT(*), COALESCE(SUM(reported_total_tokens), 0), "
                "COALESCE(SUM(reported_cost_microdollars), 0), COALESCE(SUM(accounted_microdollars), 0), "
                "COALESCE(SUM(CASE WHEN status != 'succeeded' THEN 1 ELSE 0 END), 0) FROM requests" + where,
                parameters,
            ).fetchone()
            if run_id is None:
                rows = connection.execute("SELECT * FROM requests ORDER BY created_at, request_id LIMIT 1000").fetchall()
            else:
                rows = connection.execute("SELECT * FROM requests WHERE run_hash=? ORDER BY created_at, request_id LIMIT 1000",
                                          (_digest(run_id),)).fetchall()
            return {
                "session_limit_microdollars": session["limit_microdollars"],
                "accounted_microdollars": accounted,
                "request_accounted_microdollars": totals[1],
                "provider_usage_hold_microdollars": provider[0],
                "remaining_microdollars": max(0, session["limit_microdollars"] - accounted),
                "request_count": totals[0], "blocked": bool(session["blocked"]),
                "run_totals": dict(zip(("calls", "reported_tokens", "reported_cost_microdollars",
                                        "accounted_microdollars", "uncertain_requests"), run_totals, strict=True)),
                "requests": [dict(row) for row in rows],
                "catalog": [json.loads(row[0]) for row in connection.execute(
                    "SELECT provenance_json FROM catalog ORDER BY snapshot_sha256")],
            }


def _walk_schema(value: Any, depth: int = 0) -> int:
    if depth > 24:
        raise GatewayError("invalid_request")
    if isinstance(value, dict):
        reference = value.get("$ref")
        if reference is not None and (not isinstance(reference, str) or not reference.startswith("#/")):
            raise GatewayError("invalid_request")
        return 1 + sum(_walk_schema(item, depth + 1) for item in value.values())
    if isinstance(value, list):
        return 1 + sum(_walk_schema(item, depth + 1) for item in value)
    return 1


def _function_call(call: Any, tools: frozenset[str], *, response: bool = False) -> dict[str, Any]:
    error = "invalid_response" if response else "invalid_request"
    if not isinstance(call, dict) or set(call) - {"id", "type", "function", "index"}:
        raise GatewayError(error)
    function = call.get("function")
    if (call.get("type") != "function" or not isinstance(call.get("id"), str)
            or ID_PATTERN.fullmatch(call["id"]) is None or not isinstance(function, dict)
            or set(function) != {"name", "arguments"} or not isinstance(function.get("name"), str)
            or function["name"] not in tools or not isinstance(function.get("arguments"), str)):
        raise GatewayError(error)
    return {"id": call["id"], "type": "function", "function": dict(function)}


def _validate_messages(messages: Any, allowed_tools: frozenset[str]) -> None:
    if not isinstance(messages, list) or not 1 <= len(messages) <= 128:
        raise GatewayError("invalid_request")
    for message in messages:
        if not isinstance(message, dict) or set(message) - {"role", "content", "name", "tool_calls", "tool_call_id"}:
            raise GatewayError("invalid_request")
        role, content = message.get("role"), message.get("content")
        if role not in ("system", "developer", "user", "assistant", "tool"):
            raise GatewayError("invalid_request")
        if isinstance(content, list):
            if any(not isinstance(part, dict) or set(part) != {"type", "text"}
                   or part["type"] != "text" or not isinstance(part["text"], str) for part in content):
                raise GatewayError("invalid_request")
        elif not isinstance(content, str) and not (content is None and role == "assistant" and message.get("tool_calls")):
            raise GatewayError("invalid_request")
        if "name" in message and (not isinstance(message["name"], str) or NAME_PATTERN.fullmatch(message["name"]) is None):
            raise GatewayError("invalid_request")
        if "tool_calls" in message:
            calls = message["tool_calls"]
            if role != "assistant" or not isinstance(calls, list) or not 1 <= len(calls) <= 64:
                raise GatewayError("invalid_request")
            for call in calls:
                _function_call(call, allowed_tools)
        if role == "tool":
            if not isinstance(message.get("tool_call_id"), str) or ID_PATTERN.fullmatch(message["tool_call_id"]) is None:
                raise GatewayError("invalid_request")
        elif "tool_call_id" in message:
            raise GatewayError("invalid_request")


def _normalize_request(scope: RunScope, body: dict[str, Any]) -> tuple[dict[str, Any], RequestQuote]:
    encoded = _json(body).encode()
    if len(encoded) > scope.limits.max_request_bytes:
        raise GatewayError("payload_too_large")
    model_id = body.get("model")
    if not isinstance(model_id, str) or model_id not in scope.model_ids or model_id not in POPULATION_MODELS:
        raise GatewayError("unsupported_model")
    allowed = {"model", "messages", "tools", "tool_choice", "temperature", "top_p", "seed", "stop",
               "max_tokens", "max_completion_tokens", "stream", "stream_options", "response_format", "n",
               "parallel_tool_calls"}
    if set(body) - allowed or ("n" in body and not _integer(body["n"], 1, 1)):
        raise GatewayError("invalid_request")
    if "stream" in body and type(body["stream"]) is not bool:
        raise GatewayError("invalid_request")
    options = body.get("stream_options")
    if options is not None and (not isinstance(options, dict) or set(options) - {"include_usage"}
                                or type(options.get("include_usage", False)) is not bool):
        raise GatewayError("invalid_request")
    _validate_messages(body.get("messages"), scope.allowed_tools)
    if _walk_schema(body) > 4096:
        raise GatewayError("invalid_request")
    model = POPULATION_MODELS[model_id]
    tools = body.get("tools")
    declared_tools: set[str] = set()
    if tools is not None:
        if not isinstance(tools, list) or len(tools) > 64:
            raise GatewayError("invalid_request")
        for tool in tools:
            if not isinstance(tool, dict) or set(tool) != {"type", "function"} or tool["type"] != "function":
                raise GatewayError("invalid_request")
            function = tool["function"]
            if (not isinstance(function, dict) or set(function) - {"name", "description", "parameters", "strict"}
                    or not isinstance(function.get("name"), str) or function["name"] not in scope.allowed_tools
                    or not isinstance(function.get("parameters"), dict)
                    or ("description" in function and not isinstance(function["description"], str))
                    or ("strict" in function and type(function["strict"]) is not bool)):
                raise GatewayError("invalid_request")
            if function["name"] in declared_tools:
                raise GatewayError("invalid_request")
            declared_tools.add(function["name"])
    choice = body.get("tool_choice")
    if isinstance(choice, dict):
        if (set(choice) != {"type", "function"} or choice["type"] != "function"
                or not isinstance(choice["function"], dict) or set(choice["function"]) != {"name"}
                or not isinstance(choice["function"].get("name"), str)
                or choice["function"]["name"] not in declared_tools):
            raise GatewayError("invalid_request")
    elif choice is not None and (choice not in ("auto", "none", "required") or not declared_tools):
        raise GatewayError("invalid_request")
    for name, upper in (("temperature", 2), ("top_p", 1)):
        if name in body and body[name] is not None:
            value = body[name]
            if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)) or not 0 <= value <= upper:
                raise GatewayError("invalid_request")
    if "seed" in body and not _integer(body["seed"], 0, 2**31 - 1):
        raise GatewayError("invalid_request")
    if "parallel_tool_calls" in body and type(body["parallel_tool_calls"]) is not bool:
        raise GatewayError("invalid_request")
    if body.get("stop") is not None:
        stop = body["stop"]
        if not (isinstance(stop, str) or isinstance(stop, list)
                and len(stop) <= 4 and all(isinstance(item, str) for item in stop)):
            raise GatewayError("invalid_request")
    if body.get("response_format") is not None:
        response_format = body["response_format"]
        if not isinstance(response_format, dict):
            raise GatewayError("invalid_request")
        if response_format.get("type") in ("text", "json_object"):
            if set(response_format) != {"type"}:
                raise GatewayError("invalid_request")
        elif response_format.get("type") == "json_schema" and set(response_format) == {"type", "json_schema"}:
            schema = response_format["json_schema"]
            if (not isinstance(schema, dict) or set(schema) - {"name", "description", "schema", "strict"}
                    or not isinstance(schema.get("schema"), dict) or not isinstance(schema.get("name"), str)
                    or NAME_PATTERN.fullmatch(schema["name"]) is None
                    or ("strict" in schema and type(schema["strict"]) is not bool)
                    or ("description" in schema and not isinstance(schema["description"], str))):
                raise GatewayError("invalid_request")
        else:
            raise GatewayError("invalid_request")
    outputs = [body[name] for name in ("max_tokens", "max_completion_tokens") if body.get(name) is not None]
    output = outputs[0] if outputs else scope.limits.max_output_tokens
    if (not _integer(output, 1, min(scope.limits.max_output_tokens, model.max_completion_tokens))
            or any(item != output or type(item) is not int for item in outputs)):
        raise GatewayError("invalid_request")
    payload_estimate = 4 * len(encoded) + 4096 + 256 * len(body["messages"]) + 1024 * len(declared_tools)
    if payload_estimate + output > model.context_length:
        raise GatewayError("payload_too_large")
    input_tokens = max(model.context_length, payload_estimate)
    with localcontext(Context(prec=64, rounding=ROUND_CEILING)):
        ceiling = _microdollars(input_tokens * model.input_rate + output * model.output_rate)
    sent = {name: value for name, value in body.items()
            if value is not None and name not in {"stream", "stream_options", "max_completion_tokens", "n"}}
    for parameter in ("temperature", "top_p", "seed", "stop", "response_format", "tools", "tool_choice"):
        if parameter in sent and parameter not in model.endpoint_parameters:
            raise GatewayError("invalid_request")
    sent.update({
        "max_tokens": output, "stream": False, "usage": {"include": True},
        "provider": {"only": [model.endpoint_tag], "allow_fallbacks": False, "require_parameters": True,
                     "data_collection": "deny", "max_price": model.price_caps()},
    })
    if model.reasoning:
        sent["reasoning"] = {"enabled": False}
    return sent, RequestQuote(model_id, input_tokens, output, ceiling, payload_estimate)


def _prices_equal(actual: Any, expected: dict[str, Any]) -> bool:
    if not isinstance(actual, dict) or set(actual) != set(expected):
        return False
    for name, value in expected.items():
        observed = actual[name]
        if name == "overrides":
            if (not isinstance(observed, list) or len(observed) != len(value)
                    or any(not _prices_equal(a, b) for a, b in zip(observed, value, strict=True))):
                return False
        else:
            try:
                if isinstance(observed, bool) or Decimal(str(observed)) != Decimal(str(value)):
                    return False
            except (InvalidOperation, ValueError):
                return False
    return True


def _prices_within_ceiling(pricing: Any, ceiling: dict[str, Any], *, tier: bool = False) -> bool:
    if not isinstance(pricing, dict):
        return False
    allowed = set(ceiling) | {"discount", "overrides"}
    if tier:
        allowed.add("min_prompt_tokens")
    if set(pricing) - allowed or (not tier and not {"prompt", "completion"}.issubset(pricing)):
        return False
    for name, value in pricing.items():
        if name == "overrides":
            if (tier or not isinstance(value, list) or len(value) > 16
                    or any(not _prices_within_ceiling(item, ceiling, tier=True) for item in value)):
                return False
        elif name == "min_prompt_tokens":
            if not _integer(value):
                return False
        else:
            try:
                rate = Decimal(str(value))
                maximum = Decimal(str(ceiling.get(name, 0)))
                if isinstance(value, bool) or not rate.is_finite() or not 0 <= rate <= maximum:
                    return False
            except (InvalidOperation, ValueError):
                return False
    return True


class PopulationGateway:
    def __init__(self, *, config: PopulationProviderConfig | None = None,
                 ledger_path: Path = DEFAULT_LEDGER_PATH,
                 session_limit_microdollars: int = SESSION_CAP_MICRODOLLARS,
                 transport: httpx.AsyncBaseTransport | None = None,
                 clock: Callable[[], float] = time.time):
        self._config = config if config is not None else population_provider_config()
        if transport is None and ledger_path.resolve() != DEFAULT_LEDGER_PATH.resolve():
            raise GatewayError("ledger_unavailable")
        self._ledger = BudgetLedger(ledger_path, session_limit_microdollars)
        self._transport = transport
        self._clock = clock

    def _require_enabled(self) -> None:
        key = self._config.api_key
        if (self._config.enabled is not True or not isinstance(key, str) or not 1 <= len(key) <= 1024
                or not key.isascii() or any(not 33 <= ord(character) < 127 for character in key)):
            raise GatewayError("unavailable")

    def register_run(self, run_id: str, model_ids: Iterable[str], *, limits: RunLimits | None = None,
                     allowed_tools: Iterable[str] = DEFAULT_TOOL_NAMES, token: str | None = None) -> RunRegistration:
        self._require_enabled()
        if not isinstance(run_id, str) or ID_PATTERN.fullmatch(run_id) is None:
            raise GatewayError("invalid_request")
        if isinstance(model_ids, (str, bytes)) or isinstance(allowed_tools, (str, bytes)):
            raise GatewayError("invalid_request")
        candidates = tuple(model_ids)
        if not candidates or any(not isinstance(model, str) or model not in POPULATION_MODELS for model in candidates):
            raise GatewayError("unsupported_model")
        models = tuple(sorted(set(candidates)))
        tool_names = tuple(allowed_tools)
        if len(tool_names) > 64 or any(not isinstance(name, str) or NAME_PATTERN.fullmatch(name) is None
                                      or name.lower() in FORBIDDEN_TOOL_NAMES for name in tool_names):
            raise GatewayError("invalid_request")
        tools = frozenset(tool_names)
        limits = limits if limits is not None else RunLimits()
        limits.validate()
        token = token if token is not None else secrets.token_urlsafe(32)
        if (not isinstance(token, str) or TOKEN_PATTERN.fullmatch(token) is None
                or secrets.compare_digest(token, self._config.api_key)):
            raise GatewayError("invalid_request")
        self._ledger.register(RunScope(_digest(run_id), _digest(token), models, tools, limits))
        return RunRegistration(run_id, token, models, limits)

    def unregister_run(self, run_id: str) -> None:
        self._ledger.unregister(run_id)

    def authenticate(self, token: str) -> RunScope:
        scope = self._ledger.authenticate(token)
        self._require_enabled()
        return scope

    def models(self, token: str) -> dict[str, Any]:
        scope = self.authenticate(token)
        return {"object": "list", "data": [
            {"id": model_id, "object": "model", "owned_by": "openrouter", "created": 0,
             "population_provenance": POPULATION_MODELS[model_id].provenance()}
            for model_id in scope.model_ids
        ]}

    def quote(self, token: str, body: dict[str, Any]) -> RequestQuote:
        _, quote = _normalize_request(self.authenticate(token), body)
        return quote

    def usage(self, run_id: str | None = None) -> dict[str, Any]:
        return self._ledger.usage(run_id) | {"provider_cap": self.readiness()}

    def _provider_binding(self) -> str:
        return _digest(f"population-provider-cap:{int(self._config.approved_40_key_policy)}:" + self._config.api_key)

    def readiness(self) -> dict[str, Any]:
        try:
            self._require_enabled()
        except GatewayError as error:
            result = self._ledger.provider_readiness(None, self._clock())
            return result | {"ready": False, "code": error.code}
        return self._ledger.provider_readiness(self._provider_binding(), self._clock())

    def _http_client(self, timeout: int) -> httpx.AsyncClient:
        transport = self._transport or httpx.AsyncHTTPTransport(retries=0, verify=True, trust_env=False)
        return httpx.AsyncClient(transport=transport, verify=True, trust_env=False,
                                 timeout=httpx.Timeout(timeout, connect=5), follow_redirects=False,
                                 headers={"Accept": "application/json", "Accept-Encoding": "identity"})

    async def preflight(self) -> dict[str, Any]:
        try:
            self._require_enabled()
            async with self._http_client(KEY_PREFLIGHT_TIMEOUT_SECONDS) as client:
                await self._refresh_provider_cap(client)
            result = self.readiness()
            if not result["ready"]:
                raise GatewayError(result["code"])
            return result
        except asyncio.CancelledError:
            self._ledger.provider_failure("provider_cap_unverified")
            raise
        except GatewayError as error:
            if error.code in {"provider_cap_unverified", "provider_cap_changed", "unavailable"}:
                self._ledger.provider_failure(error.code)
            raise GatewayError(error.code) from None
        except (httpx.HTTPError, OSError, ValueError, TypeError, KeyError, RuntimeError, InvalidOperation):
            self._ledger.provider_failure("provider_cap_unverified")
            raise GatewayError("provider_cap_unverified") from None

    async def _refresh_provider_cap(self, client: httpx.AsyncClient) -> None:
        try:
            async with asyncio.timeout(KEY_PREFLIGHT_TIMEOUT_SECONDS):
                async with client.stream("GET", POPULATION_KEY_URL, headers={
                    "Authorization": f"Bearer {self._config.api_key}",
                    "Cache-Control": "no-store, no-cache", "Pragma": "no-cache",
                }) as response:
                    data = await self._read_response(response, MAX_KEY_METADATA_BYTES)
            now = self._clock()
            snapshot = ProviderCapSnapshot.from_response(data, now, approved_40_key_policy=self._config.approved_40_key_policy)
            self._ledger.record_provider_cap(snapshot, self._provider_binding(), now)
            return
        except asyncio.CancelledError:
            self._ledger.provider_failure("provider_cap_unverified")
            raise
        except GatewayError as error:
            code = error.code if error.code in {"provider_cap_changed", "ledger_unavailable"} else "provider_cap_unverified"
        except (httpx.HTTPError, OSError, ValueError, TypeError, KeyError, RuntimeError, InvalidOperation):
            code = "provider_cap_unverified"
        self._ledger.provider_failure(code)
        raise GatewayError(code) from None

    async def _read_response(self, response: httpx.Response, limit: int) -> dict[str, Any]:
        if response.status_code != 200:
            raise GatewayError("upstream_failure")
        parts = bytearray()
        async for chunk in response.aiter_bytes():
            parts.extend(chunk)
            if len(parts) > limit:
                raise GatewayError("invalid_response")
        try:
            return parse_json(bytes(parts), exact_numbers=True)
        except GatewayError:
            raise GatewayError("invalid_response") from None

    async def _verify_catalog(self, client: httpx.AsyncClient, model: PopulationModel) -> None:
        try:
            async with client.stream("GET", POPULATION_CATALOG_URL) as response:
                catalog = await self._read_response(response, MAX_CATALOG_BYTES)
            entries = catalog.get("data")
            if not isinstance(entries, list):
                raise GatewayError("unsupported_pricing")
            matches = [item for item in entries if isinstance(item, dict) and item.get("id") == model.model_id]
            if len(matches) != 1:
                raise GatewayError("unsupported_pricing")
            entry = matches[0]
            expected = model.catalog_entry()
            parameters = entry.get("supported_parameters")
            if (entry.get("canonical_slug") != model.canonical_slug or entry.get("alias_target")
                    or entry.get("context_length") != model.context_length
                    or not isinstance(parameters, list) or not {"tools", "max_tokens"}.issubset(parameters)
                    or not _prices_equal(entry.get("pricing"), expected["pricing"])):
                raise GatewayError("unsupported_pricing")
            async with client.stream("GET", f"{POPULATION_CATALOG_URL}/{model.model_id}/endpoints") as response:
                endpoints = await self._read_response(response, MAX_CATALOG_BYTES)
            data = endpoints.get("data")
            listed = data.get("endpoints") if isinstance(data, dict) else None
            if not isinstance(listed, list):
                raise GatewayError("unsupported_pricing")
            if any(not isinstance(item, dict)
                   or not _prices_within_ceiling(item.get("pricing"), model.reservation_pricing()) for item in listed):
                raise GatewayError("unsupported_pricing")
            matches = [item for item in listed if isinstance(item, dict) and item.get("tag") == model.endpoint_tag]
            if len(matches) != 1:
                raise GatewayError("unsupported_pricing")
            endpoint = matches[0]
            frozen = model.endpoint_entry()
            parameters = endpoint.get("supported_parameters")
            if (any(endpoint.get(name) != frozen[name] for name in (
                    "provider_name", "context_length", "max_prompt_tokens", "max_completion_tokens",
                    "status", "supports_implicit_caching"))
                    or not isinstance(parameters, list) or not set(model.endpoint_parameters).issubset(parameters)
                    or not _prices_equal(endpoint.get("pricing"), frozen["pricing"])):
                raise GatewayError("unsupported_pricing")
        except (GatewayError, httpx.HTTPError, ValueError, TypeError, KeyError):
            raise GatewayError("unsupported_pricing") from None

    async def complete(self, token: str, body: dict[str, Any]) -> dict[str, Any]:
        scope = self.authenticate(token)
        sent, quote = _normalize_request(scope, body)
        started = time.monotonic()
        request_id: str | None = None
        try:
            async with asyncio.timeout(scope.limits.request_timeout_seconds):
                async with self._http_client(scope.limits.request_timeout_seconds) as client:
                    await self._verify_catalog(client, POPULATION_MODELS[quote.model_id])
                    await self._refresh_provider_cap(client)
                    request_id = self._ledger.reserve(scope, quote, self._clock(), self._provider_binding())
                    async with client.stream("POST", f"{POPULATION_OPENROUTER_BASE}/chat/completions",
                                             headers={"Authorization": f"Bearer {self._config.api_key}"},
                                             json=sent) as response:
                        data = await self._read_response(response, MAX_RESPONSE_BYTES)
                    try:
                        completed = self._completion(data, {}, scope, request_id)
                    except GatewayError:
                        completed = None
                    usage = self._ledger.settle(request_id, quote, data,
                                                int((time.monotonic() - started) * 1000), completed is not None)
                    if completed is None:
                        raise GatewayError("invalid_response")
                    completed["usage"] = usage
                    return completed
        except asyncio.CancelledError:
            if request_id is not None:
                self._ledger.fail(request_id, "cancelled", int((time.monotonic() - started) * 1000))
            raise
        except (TimeoutError, httpx.TimeoutException):
            code = "upstream_timeout"
        except GatewayError as error:
            code = error.code
        except (httpx.HTTPError, OSError, ValueError, TypeError, KeyError, RuntimeError, InvalidOperation):
            code = "upstream_failure"
        if request_id is not None:
            self._ledger.fail(request_id, code, int((time.monotonic() - started) * 1000))
        raise GatewayError(code) from None

    @staticmethod
    def _completion(data: dict[str, Any], usage: dict[str, Any], scope: RunScope, request_id: str) -> dict[str, Any]:
        choices = data.get("choices")
        if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
            raise GatewayError("invalid_response")
        choice = choices[0]
        message = choice.get("message")
        if (not isinstance(message, dict) or message.get("role") != "assistant"
                or choice.get("finish_reason") not in ("stop", "length", "tool_calls", "content_filter")):
            raise GatewayError("invalid_response")
        content = message.get("content")
        if content is not None and not isinstance(content, str):
            raise GatewayError("invalid_response")
        clean_message: dict[str, Any] = {"role": "assistant", "content": content}
        if message.get("tool_calls"):
            calls = message["tool_calls"]
            if not isinstance(calls, list) or len(calls) > 64:
                raise GatewayError("invalid_response")
            clean_message["tool_calls"] = [_function_call(call, scope.allowed_tools, response=True) for call in calls]
        if content is None and not clean_message.get("tool_calls"):
            raise GatewayError("invalid_response")
        return {"id": request_id, "object": "chat.completion", "created": int(time.time()),
                "model": data["model"], "choices": [{"index": 0, "message": clean_message,
                                                       "finish_reason": choice["finish_reason"]}], "usage": usage}


def completion_sse(completion: dict[str, Any], include_usage: bool = False) -> Iterator[str]:
    base = {name: completion[name] for name in ("id", "created", "model")}
    base["object"] = "chat.completion.chunk"

    def event(delta: dict[str, Any], finish_reason: str | None = None) -> str:
        chunk = base | {"choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}]}
        if include_usage:
            chunk["usage"] = None
        return "data: " + _json(chunk) + "\n\n"

    choice = completion["choices"][0]
    message = choice["message"]
    yield event({"role": "assistant", "content": ""})
    if message.get("content"):
        yield event({"content": message["content"]})
    for index, call in enumerate(message.get("tool_calls", [])):
        yield event({"tool_calls": [{"index": index, **call}]})
    yield event({}, choice["finish_reason"])
    if include_usage:
        yield "data: " + _json(base | {"choices": [], "usage": completion["usage"]}) + "\n\n"
    yield "data: [DONE]\n\n"


_default_gateway: PopulationGateway | None = None
_default_gateway_lock = threading.Lock()


def get_population_gateway() -> PopulationGateway:
    global _default_gateway
    with _default_gateway_lock:
        if _default_gateway is None:
            _default_gateway = PopulationGateway()
        return _default_gateway


def register_population_run(run_id: str, model_ids: Iterable[str], *, limits: RunLimits | None = None,
                            allowed_tools: Iterable[str] = DEFAULT_TOOL_NAMES,
                            token: str | None = None) -> RunRegistration:
    return get_population_gateway().register_run(run_id, model_ids, limits=limits, allowed_tools=allowed_tools, token=token)


def unregister_population_run(run_id: str) -> None:
    get_population_gateway().unregister_run(run_id)


def population_usage(run_id: str | None = None) -> dict[str, Any]:
    return get_population_gateway().usage(run_id)


async def preflight_population_gateway() -> dict[str, Any]:
    return await get_population_gateway().preflight()


def population_gateway_readiness() -> dict[str, Any]:
    return get_population_gateway().readiness()
