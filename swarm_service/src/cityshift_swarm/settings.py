from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

import yaml

from cityshift_swarm.contracts import CITY_TOOLS, RunRequest

SWARM_SHA = "70aa6715992d9cb2c3ec81ee35991d13747e5ce0"
CORE_SHA = "ad0c9dfbbd577423cc60f73edffa0a4699cc53f9"
WORKFLOW_NAME = "cityshift_population_v1"
MODEL_WINDOW_ROUNDS = 2
GATEWAY_CREDENTIAL_REF = "runtime-env:CITYSHIFT_SWARM_GATEWAY_TOKEN"
DEFAULT_ROOT = Path(__file__).resolve().parents[2] / "var"


def local_url(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname not in {"127.0.0.1", "::1"}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.port is None
        or any(part in {".", ".."} for part in parsed.path.split("/"))
        or "%" in value
    ):
        raise ValueError("only explicit loopback HTTP(S) endpoints are supported")
    return value.rstrip("/")


@dataclass(frozen=True)
class Settings:
    root: Path
    gateway_url: str
    city_bridge_url: str
    control_token: str = field(repr=False)
    gateway_token: str = field(repr=False)
    port: int = 8766
    max_run_seconds: int = 3600
    max_epochs: int = 1000

    @classmethod
    def from_env(cls) -> Settings:
        root = Path(os.environ.get("CITYSHIFT_SWARM_ROOT", str(DEFAULT_ROOT))).resolve()
        if not root.is_relative_to(DEFAULT_ROOT.resolve()):
            raise ValueError("CITYSHIFT_SWARM_ROOT must be within swarm_service/var")
        control_token = os.environ.get("CITYSHIFT_POPULATION_CONTROL_TOKEN", "")
        gateway_token = os.environ.get("CITYSHIFT_SWARM_GATEWAY_TOKEN", "")
        if min(len(control_token), len(gateway_token)) < 32 or control_token == gateway_token:
            raise ValueError("distinct controller and gateway tokens of at least 32 characters are required")
        port = int(os.environ.get("CITYSHIFT_SWARM_PORT", "8766"))
        if not 1024 <= port <= 65535:
            raise ValueError("invalid adapter port")
        return cls(
            root=root,
            gateway_url=local_url(os.environ.get("CITYSHIFT_SWARM_GATEWAY_URL", "")),
            city_bridge_url=local_url(os.environ.get("CITYSHIFT_SWARM_CITY_BRIDGE_URL", "http://127.0.0.1:8000")),
            control_token=control_token,
            gateway_token=gateway_token,
            port=port,
        )

    def validate_request(self, request: RunRequest) -> None:
        if local_url(request.city_bridge_url) != self.city_bridge_url:
            raise ValueError("unapproved city bridge endpoint")
        if any(local_url(model.api_base) != self.gateway_url for model in request.models):
            raise ValueError("models must use the configured budget gateway")

    def isolate_environment(self) -> None:
        os.umask(0o077)
        for path in (self.root, self.root / "home", self.root / "native" / "config", self.root / "runs"):
            path.mkdir(mode=0o700, parents=True, exist_ok=True)
            if path.is_symlink() or path.stat().st_mode & 0o077:
                raise ValueError("swarm runtime directories must be private and not symlinks")
        kept = {name: os.environ[name] for name in ("PATH", "LANG", "LC_ALL", "TMPDIR") if name in os.environ}
        os.environ.clear()
        os.environ.update(kept)
        os.environ.update({
            "HOME": str(self.root / "home"),
            "XDG_CONFIG_HOME": str(self.root / "home" / ".config"),
            "XDG_CACHE_HOME": str(self.root / "home" / ".cache"),
            "JIUWENSWARM_DATA_DIR": str(self.root / "native"),
            "JIUWENSWARM_CONFIG_DIR": str(self.root / "native" / "config"),
            "OPENJIUWEN_HOME": str(self.root / "core"),
            "CITYSHIFT_POPULATION_CONTROL_TOKEN": self.control_token,
            "CITYSHIFT_SWARM_GATEWAY_TOKEN": self.gateway_token,
            "CITYSHIFT_SWARM_GATEWAY_URL": self.gateway_url,
            "SSL_VERIFY": "true",
            "LOG_LEVEL": "CRITICAL",
            "OTEL_SDK_DISABLED": "true",
            "OTEL_ENABLED": "false",
            "DO_NOT_TRACK": "1",
            "ANONYMIZED_TELEMETRY": "false",
            "FREE_SEARCH_DDG_ENABLED": "false",
            "FREE_SEARCH_BING_ENABLED": "false",
            "SYMPHONY_SKILL_RETRIEVAL_ENABLED": "false",
        })

    def write_native_config(self, request: RunRequest | None = None) -> None:
        ids = [model.model_id for model in request.models] if request else ["unconfigured"]
        timeout = request.budget.decision_timeout_s if request else 10
        iterations = request.budget.max_iterations if request else 1
        ceiling = request.budget.max_tokens if request else 1
        models = {}
        for index, model_id in enumerate(ids):
            models["default" if index == 0 else f"model_{index}"] = {
                "model_client_config": {
                    "client_provider": "OpenAI",
                    "model_name": model_id,
                    "api_base": self.gateway_url,
                    "api_key": GATEWAY_CREDENTIAL_REF,
                    "verify_ssl": True,
                    "max_retries": 0,
                    "timeout": timeout,
                    "stream_first_chunk_timeout": timeout,
                    "stream_idle_timeout": timeout,
                    "api_mode": "chat_completions",
                },
                "model_config_obj": {"temperature": 0.4},
            }
        agent = {
            "workspace": None,
            "auto_create_workspace": False,
            "enable_sys_operation": False,
            "enable_security_rail": True,
            "enable_task_loop": False,
            "enable_task_planning": False,
            "enable_async_subagent": False,
            "enable_subagent_runtime": False,
            "add_general_purpose_agent": False,
            "enable_read_image_multimodal": False,
            "enable_skill_discovery": False,
            "skills": [],
            "tools": [],
            "mcps": [],
            "subagents": [],
            "max_iterations": iterations,
            "completion_timeout": timeout,
            "prompt_mode": "none",
            "language": "en",
        }
        config = {
            "preferred_language": "en",
            "models": {"defaults": list(models.values())},
            "tools": sorted(CITY_TOOLS | {"structured_output"}),
            "progressive_tool_enabled": False,
            "auto_memory_enabled": False,
            "task_memory": {"enabled": False},
            "mcp": {"servers": []},
            "symphony": {"enabled": False, "skill_retrieval": {"enabled": False}},
            "team_observability": {"enabled": False},
            "agent_observability": {"enabled": False},
            "observability": {"enabled": False},
            "trajectory": {"enabled": False},
            "react": {
                "enable_task_planning": False,
                "context_engine_config": {"enabled": False},
                "evolution": {"skill_evolution": False},
                "subagent_runtime": {"enabled": False},
                "subagents": {
                    name: {"enabled": False} for name in
                    ("browser_agent", "code_agent", "research_agent", "explore_agent", "plan_agent")
                },
            },
            "channels": {
                name: {"enabled": False, "send_file_allowed": False, "phone_tools_enabled": False}
                for name in ("web", "feishu", "xiaoyi", "telegram", "discord", "slack")
            },
            "permissions": {
                "enabled": True,
                "schema": "tiered_policy",
                "permission_mode": "normal",
                "defaults": {"*": "deny"},
                "tools": dict.fromkeys(sorted(CITY_TOOLS | {"structured_output"}), "allow"),
                "rules": [],
            },
            "modes": {"team": {"jiuwen_team": {
                "team_name": "population",
                "lifecycle": "persistent",
                "spawn_mode": "inprocess",
                "team_mode": "predefined",
                "evolution_enabled": False,
                "enable_swarmflow": True,
                "swarmflow_budget": ceiling,
                "swarmflow_concurrency": {
                    "max_workflows": 1,
                    "agents_per_run": request.budget.max_concurrency if request else 1,
                    "max_agents_total": request.budget.max_concurrency if request else 1,
                },
                "enable_hitt": False,
                "enable_bridge": False,
                "enable_fork": False,
                "enable_task_verification": False,
                "external_cli_agents": [],
                "predefined_members": [],
                "workspace": {"enabled": False, "version_control": False},
                "worktree": {"enabled": False},
                "memory": {"enabled": False, "shared_memory": False, "auto_extract": False},
                "transport": {"type": "inprocess"},
                "external_transport": {"type": "inprocess"},
                "agents": {"leader": agent, "teammate": agent},
            }}},
        }
        path = self.root / "native" / "config" / "config.yaml"
        path.write_text(yaml.safe_dump(config, sort_keys=False))
        path.chmod(0o600)
