from __future__ import annotations

import json
import os
import socket
import subprocess
import time
from pathlib import Path
from typing import Any, BinaryIO

import httpx

from cityshift.contracts import PopulationDefinition, ResidentDecision, SwarmBinding

SWARM_ROOT = Path(__file__).resolve().parents[3] / "swarm_service"


class SwarmUnavailable(RuntimeError):
    pass


class NativePopulationClient:
    def __init__(self, run_id: str, population: PopulationDefinition, control_token: str,
                 gateway_token: str, gateway_url: str, city_bridge_url: str):
        self.run_id = run_id
        self.population = population
        self._control_token = control_token
        self._gateway_token = gateway_token
        self.gateway_url = gateway_url
        self.city_bridge_url = city_bridge_url
        self._process: subprocess.Popen | None = None
        self._log: BinaryIO | None = None
        self._http: httpx.Client | None = None
        self.base = ""
        self.health: dict[str, Any] = {}
        self.active = False
        self.generation = 0

    @staticmethod
    def installed() -> bool:
        return (SWARM_ROOT / ".venv" / "bin" / "python").is_file()

    def start(self, resume: dict[str, Any] | None = None) -> None:
        python = SWARM_ROOT / ".venv" / "bin" / "python"
        if not python.is_file():
            raise SwarmUnavailable("isolated JiuwenSwarm environment is not installed")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        self.base = f"http://127.0.0.1:{port}"
        runtime_root = SWARM_ROOT / "var" / self.run_id
        if resume is not None and not runtime_root.is_dir():
            raise SwarmUnavailable("native checkpoint runtime root is missing")
        runtime_root.mkdir(parents=True, mode=0o700, exist_ok=resume is not None)
        env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}
        env.update({
            "HOME": str(runtime_root / "home"), "PYTHONUNBUFFERED": "1",
            "CITYSHIFT_SWARM_ROOT": str(runtime_root), "CITYSHIFT_SWARM_PORT": str(port),
            "CITYSHIFT_POPULATION_CONTROL_TOKEN": self._control_token,
            "CITYSHIFT_SWARM_GATEWAY_TOKEN": self._gateway_token,
            "CITYSHIFT_SWARM_GATEWAY_URL": self.gateway_url,
            "CITYSHIFT_SWARM_CITY_BRIDGE_URL": self.city_bridge_url,
        })
        self._log = (runtime_root / "adapter.log").open("ab")
        self._http = httpx.Client(base_url=self.base, verify=True, trust_env=False,
                                  headers={"Authorization": f"Bearer {self._control_token}"}, timeout=90)
        try:
            self._process = subprocess.Popen([str(python), "-m", "cityshift_swarm.app"], cwd=SWARM_ROOT,
                                             env=env, stdout=self._log, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                if self._process.poll() is not None:
                    raise SwarmUnavailable("isolated JiuwenSwarm service exited during startup")
                try:
                    response = self._http.get("/health", timeout=2)
                    if response.status_code == 200:
                        self.health = response.json()
                        break
                except httpx.TransportError:
                    pass
                time.sleep(0.1)
            else:
                raise SwarmUnavailable("isolated JiuwenSwarm service startup timed out")
            if not self.health.get("verified") or not self.health.get("native_available"):
                raise SwarmUnavailable("native JiuwenSwarm pins, capabilities, or configuration are unavailable")
            if self.population.spec.count > self.health.get("max_residents", 0):
                raise SwarmUnavailable("population exceeds the verified native integration scale gate")
            models = sorted({brain.model_id for brain in self.population.assignments.values()})
            budget = self.population.spec.budget
            payload: dict[str, Any] = {
                "run_id": self.run_id,
                "residents": [{
                    "resident_id": profile.resident_id,
                    "model_id": self.population.assignments[profile.resident_id].model_id,
                    "instructions": resident_instructions(profile.model_dump(mode="json")),
                } for profile in self.population.profiles],
                "models": [{"model_id": model, "api_base": self.gateway_url,
                            "api_key_env": "CITYSHIFT_SWARM_GATEWAY_TOKEN"} for model in models],
                "budget": {"max_concurrency": budget.max_concurrency, "max_iterations": budget.max_iterations,
                           "decision_timeout_s": min(120, budget.decision_timeout_s),
                           "max_tokens": budget.max_tokens},
                "city_bridge_url": self.city_bridge_url,
            }
            if resume is not None:
                payload["resume_checkpoint"] = resume["checkpoint_id"]
                payload["resume_boundary"] = {key: resume[key] for key in (
                    "epoch", "t", "world_version", "world_state_hash", "checkpoint_hash",
                )}
            response = self._http.post("/runs", json=payload)
            if response.status_code != 201:
                raise SwarmUnavailable("native population team failed startup or checkpoint validation")
            receipt = response.json()
            if receipt.get("run_id") != self.run_id:
                raise SwarmUnavailable("native startup returned another run identity")
            self.generation = int(receipt.get("generation", 0))
            self.active = True
        except BaseException:
            self.close()
            raise

    def decide(self, packets: list[dict[str, Any]]) -> tuple[
        dict[str, ResidentDecision | None], dict[str, SwarmBinding], dict[str, str], dict[str, dict],
    ]:
        if not self.active or self._http is None:
            raise SwarmUnavailable("native population team is not active")
        first = packets[0]
        response = self._http.post(f"/runs/{self.run_id}/decisions", json={
            "epoch": first["epoch"], "t": first["t"], "world_version": first["world_version"], "observations": packets,
        }, timeout=self.population.spec.budget.decision_timeout_s + 30)
        if response.status_code != 200:
            raise SwarmUnavailable(f"native decision boundary failed (HTTP {response.status_code})")
        data = response.json()
        due = {packet["resident_id"] for packet in packets}
        rows = data.get("decisions", [])
        if (data.get("run_id") != self.run_id or data.get("epoch") != first["epoch"]
                or len(rows) != len(due) or {row.get("resident_id") for row in rows} != due):
            raise SwarmUnavailable("native response has wrong scope or missing/duplicated residents")
        results, bindings, failures, usage = {}, {}, {}, {}
        for row in rows:
            rid = row["resident_id"]
            result = row.get("decision")
            results[rid] = ResidentDecision.model_validate(result) if result is not None else None
            binding = row.get("binding") or {}
            if all(binding.get(key) for key in ("team_id", "workflow_id", "session_id", "worker_id", "resolved_model_id")):
                bindings[rid] = SwarmBinding(resident_id=rid, run_id=self.run_id, bound_s=first["t"],
                                             generation=self.generation, restored=self.generation > 0, **binding)
            if row.get("fallback_reason"):
                failures[rid] = str(row["fallback_reason"])[:200]
            usage[rid] = {key: value for key, value in (row.get("usage") or {}).items()
                          if isinstance(value, (int, float, str)) and not isinstance(value, bool)}
        return results, bindings, failures, usage

    def align_boundary(self, epoch: int, t: int, world_version: int) -> None:
        if not self.active or self._http is None:
            raise SwarmUnavailable("native team unavailable for checkpoint alignment")
        response = self._http.post(f"/runs/{self.run_id}/decisions", json={
            "epoch": epoch, "t": t, "world_version": world_version, "observations": [],
        })
        if response.status_code != 200:
            raise SwarmUnavailable("native checkpoint alignment failed")
        body = response.json()
        if body.get("run_id") != self.run_id or body.get("epoch") != epoch or body.get("decisions") != []:
            raise SwarmUnavailable("native checkpoint alignment scope mismatch")

    def checkpoint(self, boundary: dict[str, Any]) -> dict[str, Any]:
        if not self.active or self._http is None:
            raise SwarmUnavailable("native team unavailable for checkpoint")
        response = self._http.post(f"/runs/{self.run_id}/checkpoint", json=boundary, timeout=90)
        if response.status_code != 200:
            raise SwarmUnavailable("native checkpoint was not sealed; no coordinated resume is claimed")
        body = response.json()
        if body.get("run_id") != self.run_id or any(body.get(key) != value for key, value in boundary.items()):
            raise SwarmUnavailable("native checkpoint boundary mismatch")
        self.active = False
        return body

    def close(self) -> None:
        if self._http is not None:
            if self.active:
                try:
                    self._http.post(f"/runs/{self.run_id}/stop", timeout=15)
                except httpx.TransportError:
                    pass
            self._http.close()
            self._http = None
        self.active = False
        if self._process is not None:
            if self._process.poll() is None:
                self._process.terminate()
                try:
                    self._process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    self._process.kill()
                    self._process.wait()
            self._process = None
        if self._log is not None:
            self._log.close()
            self._log = None


def resident_instructions(profile: dict[str, Any]) -> str:
    return (
        "You are one persistent synthetic resident in CITYSHIFT, not a coding assistant or a city planner. "
        "Your private persona is " + profile["persona"] + "\n"
        "Your profile: " + json.dumps(profile, separators=(",", ":")) + "\n"
        "Use only your city tools and your current immutable observation. Other people's private histories are unavailable. "
        "The supplied observation already contains your scoped state, tasks, memories, contacts, and trip options. "
        "Do not call observe_local_state or view_tasks solely to reread facts already supplied. "
        "Use city retrieval tools or estimate_trip when you actually need additional scoped information. "
        "Choose your own legitimate next action based on needs, preferences, obligations, known contacts, and accessible places. "
        "Call propose_action with a JSON action object to stage one proposal, then call structured_output with the SAME "
        "proposal as a nested JSON object, a concise summary, a short plan, and explicitly labeled beliefs. "
        "Do not finish with plain prose, quoted JSON in proposal, Python repr, or text such as travel(action='travel', ...). "
        'Format-only structured_output example: {"proposal":{"action":"wait","duration_s":30,'
        '"idempotency_key":"fresh-epoch-key"},"summary":"A brief decision summary.","plan":[],"beliefs":[]}. '
        "This illustrates shape, not an action recommendation; choose your own action and a fresh key, not the example key. "
        "A proposal is not an outcome; only city records establish arrival, pickup, service, or delivery. "
        "At most one action is committed per decision epoch. Use a fresh idempotency key for each epoch. "
        "For an eligible shop/service worker, accept authorizes travel to work and a duration/capacity-gated service routine. "
        "For a courier/driver, accept on a ready delivery authorizes a measured pickup/delivery routine. "
        "For a requester, visit on an accepted service request authorizes travel to the service anchor. "
        "For travel, target_id is a declared accessible anchor_id; for request_service it is a compatible service anchor_id. "
        "For accept, decline, prepare, pickup, deliver, visit, serve, report_delay, or revise_commitment, "
        "target_id is an actual visible task_id, never an anchor_id. For message it is a known contact's resident_id. "
        "Omit target_id for wait or rest. Choose valid IDs from your observation; never invent a task or anchor. "
        "Need values measure UNSATISFIED urgency: 0 means no need and 1 means high need. "
        "Only completing a delivery lowers the delivery need; only completing an accepted in-person visit lowers the visit need. "
        "Rest lowers ONLY the rest need. Merely traveling to a shop, service, or rest anchor does not fulfill delivery or visit needs. "
        "To obtain delivery or a visit when you have no active request of that kind, request_service creates a task: "
        "set request_kind to delivery or visit, and target_id to the matching shop or service anchor. "
        "A terminal expired, declined, failed, or completed task is not an active request. "
        "No provider is automatically assigned: an eligible worker must choose accept on a requested task. "
        "For an accepted visit, its requester must choose visit with that task_id; the provider and requester must be present "
        "and committed together for the required service duration. Waiting nearby alone is not a visit commitment. "
        "You remain free to decline, wait, negotiate, or prioritize another need; these are action semantics, not instructions to cooperate. "
        "Delivery requires the requester at their home anchor. Only requesters may accept revised deadlines. "
        "Transport vehicles must be owned and available at your current anchor. Waiting or continuing a valid routine is allowed. "
        "No host files, shell, network browsing, arbitrary Python, real payments, or world-rule changes are permitted. "
        "Do not reveal or claim hidden internal model reasoning; provide only a brief simulated decision summary."
    )
