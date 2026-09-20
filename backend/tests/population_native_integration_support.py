from __future__ import annotations

import contextlib
import hashlib
import json
import socket
import threading
import time
from collections import Counter
from pathlib import Path
from typing import Any

import httpx
import sumolib
import uvicorn
from fastapi import FastAPI
from test_population_gateway import FakeOpenRouter

from cityshift.agents.population_baseline import baseline_decision
from cityshift.contracts import (
    ActivityAnchor,
    AnchorAccess,
    BrainAssignment,
    CityPack,
    MemoryEntry,
    PopulationBudget,
    PopulationSpec,
)
from cityshift.domain.population import generate_population
from cityshift.providers import POPULATION_MODELS
from cityshift.transport.tiny_fixture import build_tiny_network

MODEL = "openai/gpt-4.1-mini"
EVIDENCE_LABEL = "LOCAL MODEL DOUBLE; actual native SDK and SUMO; not live cognition or invoice evidence"


def tiny_native_population(directory: Path):
    network_file = build_tiny_network(directory / "network", geo=True)
    net = sumolib.net.readNet(str(network_file))
    brain = BrainAssignment(
        model_id=MODEL, model_family="local-model-double", api_provider="local-mock-transport",
        config_ref="nonpaid-native-integration-double", control_mode="jiuwenswarm",
    )
    spec = PopulationSpec(
        pack_id="fixture", count=6, horizon_s=600, seed=7, brains=[brain], recurring_need_s=7200,
        decision_interval_s=5, service_duration_s=10,
        budget=PopulationBudget(max_concurrency=3, max_iterations=6, decision_timeout_s=45,
                                max_calls=120, requests_per_minute=120, tokens_per_minute=20_000_000),
    )
    anchors = []
    for name, purpose, position in (
        ("shop", "shop", 100), ("service", "service", 120),
        ("home-a", "home", 30), ("home-b", "home", 40),
        ("home-c", "home", 150), ("home-d", "home", 60), ("rest", "rest", 180),
    ):
        edge = net.getEdge("e_BC")
        access = {}
        for kind in spec.enabled_classes:
            lane = next(lane for lane in edge.getLanes() if lane.allows(kind))
            access[kind] = AnchorAccess(edge_id=edge.getID(), position_m=position, lane_index=lane.getIndex())
        lane = edge.getLanes()[access["pedestrian"].lane_index]
        x, y = sumolib.geomhelper.positionAtShapeOffset(lane.getShape(), position)
        lon, lat = net.convertXY2LonLat(x, y)
        anchors.append(ActivityAnchor(anchor_id=name, name=name, purpose=purpose, lon=lon, lat=lat,
                                      access=access, capacity=2, service_duration_s=10))
    pack = CityPack(
        pack_id="fixture", name="Explicitly synthetic native integration fixture", version="1",
        net_file=str(network_file), network_fingerprint=hashlib.sha256(network_file.read_bytes()).hexdigest()[:16],
        bbox=(-79.40, 43.63, -79.37, 43.65), center=(-79.385, 43.64), venue_edge_id="e_BC",
        venue_lonlat=(anchors[0].lon, anchors[0].lat), stops=[], zones=[], real_data=False,
    )
    population = generate_population(spec, anchors, pack.network_fingerprint)
    homes = ["home-a", "home-b", "home-a", "home-b", "home-c", "home-d"]
    for profile, state, home in zip(population.profiles, population.initial_states, homes, strict=True):
        profile.home_anchor_id = home
        profile.preferences.update({"patience_s": 30.0, "work_priority": 1.0})
        for routine in profile.routine:
            if routine.activity == "home":
                routine.anchor_id = home
        state.anchor_id = profile.work_anchor_id or home
        state.vehicle_locations = {kind: state.anchor_id for kind in profile.available_classes
                                   if kind != "pedestrian"}
        state.next_need_s = 7200
        state.memories = [MemoryEntry(
            event_id=f"fixture-private-{profile.resident_id}", t=0, kind="observation",
            text=f"world-private[{profile.resident_id}] belongs only to this synthetic resident.",
        )]
    profiles = {profile.resident_id: profile for profile in population.profiles}
    for task in population.initial_tasks:
        task.destination_anchor_id = profiles[task.requester_id].home_anchor_id
    population.assumptions.append(EVIDENCE_LABEL)
    return pack, population


class DeterministicPopulationModelDouble(FakeOpenRouter):
    def __init__(self):
        super().__init__()
        self.generation = 0
        self.calls: list[dict[str, Any]] = []
        self.observations: dict[tuple[int, str, int], dict[str, Any]] = {}
        self.choices: dict[tuple[str, int], dict[str, Any]] = {}
        self.resumed_private_histories: set[str] = set()
        self.errors: list[str] = []
        self.stage_counts = Counter()
        self._lock = threading.Lock()

    async def handle(self, request: httpx.Request) -> httpx.Response:
        if request.method != "POST":
            return await super().handle(request)
        assert request.url.path == "/api/v1/chat/completions"
        assert request.headers["authorization"] == f"Bearer {self.expected_key}"
        self.posts.append(request)
        try:
            payload = json.loads(request.content)
            messages = payload["messages"]
            snapshots = []
            for index, message in enumerate(messages):
                if message["role"] != "user":
                    continue
                text = message.get("content") or ""
                if isinstance(text, list):
                    text = "".join(part.get("text", "") for part in text)
                start = text.find('{"instruction"')
                if start >= 0:
                    snapshots.append((index, json.JSONDecoder().raw_decode(text[start:])[0]["observation"]))
            assert snapshots, "native worker did not send an actor-specific observation"
            user_index, packet = snapshots[-1]
            resident_id, epoch = packet["resident_id"], packet["epoch"]
            assert all(item["resident_id"] == resident_id for _, item in snapshots)
            encoded_messages = json.dumps(messages)
            for other in range(1, 7):
                other_id = f"resident-{other:04d}"
                if other_id != resident_id:
                    assert f"world-private[{other_id}]" not in encoded_messages
                    assert f"native-private[{other_id}]" not in encoded_messages
            assert len(packet["memories"]) <= 8 and len(packet["messages"]) <= 4
            if packet["t"] == 0:
                assert f"world-private[{resident_id}]" in encoded_messages
            if self.generation:
                assert f"native-private[{resident_id}]" not in json.dumps(packet)
                assert f"native-private[{resident_id}]" in encoded_messages
                self.resumed_private_histories.add(resident_id)
            turn = (resident_id, epoch)
            choice = self.choices.get(turn)
            if choice is None:
                choice = baseline_decision(packet).model_dump(mode="json")
                choice["summary"] = (
                    f"LOCAL MODEL DOUBLE native-private[{resident_id}] epoch={epoch}; "
                    + choice["summary"]
                )[:600]
                self.choices[turn] = choice
            ids = {name: f"test-{resident_id}-{epoch}-{name}" for name in ("observe", "tasks", "propose", "result")}
            replies = {message.get("tool_call_id"): message for message in messages[user_index + 1:]
                       if message["role"] == "tool"}
            if ids["observe"] not in replies or ids["tasks"] not in replies:
                stage = "observe"
                requested = [(ids["observe"], "observe_local_state", {}), (ids["tasks"], "view_tasks", {})]
            elif ids["propose"] not in replies:
                stage = "propose"
                requested = [(ids["propose"], "propose_action", choice["proposal"])]
            else:
                assert "proposed" in str(replies[ids["propose"]]["content"])
                stage = "structured"
                requested = [(ids["result"], "structured_output", choice)]
            with self._lock:
                self.calls.append({"generation": self.generation, "resident_id": resident_id, "epoch": epoch,
                                   "t": packet["t"], "stage": stage, "model_id": payload["model"]})
                self.stage_counts[(resident_id, epoch, stage)] += 1
                self.observations[(self.generation, resident_id, epoch)] = packet
            tool_calls = [{"id": call_id, "type": "function", "function": {
                "name": name, "arguments": json.dumps(arguments),
            }} for call_id, name, arguments in requested]
            return httpx.Response(200, json={
                "id": f"local-test-{resident_id}-{epoch}-{stage}", "object": "chat.completion", "created": 1,
                "model": payload["model"], "provider": POPULATION_MODELS[payload["model"]].endpoint_provider,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": None,
                                                     "tool_calls": tool_calls}, "finish_reason": "tool_calls"}],
                "usage": {"prompt_tokens": 200, "completion_tokens": 100, "total_tokens": 300,
                          "cost": "0.0001"},
            })
        except Exception as exc:
            self.errors.append(type(exc).__name__)
            raise


@contextlib.contextmanager
def running_local_app(app: FastAPI):
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    port = listener.getsockname()[1]
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None, log_level="critical",
                            access_log=False, lifespan="off", loop="asyncio", timeout_graceful_shutdown=5)
    server = uvicorn.Server(config)
    errors = []

    def serve():
        try:
            server.run(sockets=[listener])
        except (OSError, RuntimeError, ValueError, SystemExit) as exc:
            errors.append(type(exc).__name__)

    thread = threading.Thread(target=serve, name="nonpaid-population-api", daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    try:
        while not server.started and not errors and time.monotonic() < deadline:
            time.sleep(0.01)
        assert server.started and not errors, "local integration API did not start"
        yield port
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        listener.close()
        assert not thread.is_alive() and not errors
