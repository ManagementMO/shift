from __future__ import annotations

import copy
import json
import logging
import re
import threading
import uuid
from collections import deque
from collections.abc import Callable
from concurrent.futures import Future
from pathlib import Path

from cityshift.contracts import CityPack
from cityshift.domain.network import load_pack
from cityshift.live.contracts import InterventionRequest, SessionConfig, stored_command, temperature_response
from cityshift.live.engine import LiveEngine
from cityshift.live.recording import CHUNK_SECONDS, COUNT_KEYS, FrameStore, atomic_json

LIVE_ROOT = Path(__file__).resolve().parents[3] / "var" / "live"
SESSION_ID = re.compile(r"^live-[a-f0-9]{12}$")
log = logging.getLogger(__name__)


class LiveSession:
    recording: FrameStore

    def __init__(self, session_id: str, pack: CityPack, config: SessionConfig, root: Path,
                 parent: LiveSession | None = None, fork_s: int | None = None,
                 history: list[InterventionRequest] | None = None, archived_state: dict | None = None):
        self.session_id = session_id
        self.pack = pack
        self.config = config
        self.root = root
        self.parent_id = parent.session_id if parent else None
        self.fork_s = fork_s
        self.commands = list(history or [])
        self.recording = FrameStore(root / "frames", parent.recording if parent else None, fork_s)
        self._condition = threading.Condition()
        self._jobs: deque[tuple[str, object, Future]] = deque()
        self._ready = threading.Event()
        self._closing = False
        self._target = max(0, self.recording.latest_s)
        self._engine: LiveEngine | None = None
        self._state: dict = {
            "session_id": session_id, "pack_id": pack.pack_id, "network_fingerprint": pack.network_fingerprint,
            "config": config.model_dump(), "parent_session_id": self.parent_id, "fork_s": fork_s,
            "time_s": 0, "available_until_s": self.recording.latest_s, "horizon_s": config.horizon_s,
            "status": "restoring" if parent else "starting", "error": None, "revision": len(self.commands),
            "temperature_c": config.temperature_c, "counts": dict.fromkeys(COUNT_KEYS, 0), "commands": [],
            "chunk_seconds": CHUNK_SECONDS, "protocol": "CSF1", "engine_version": "", "entity_count": 0,
        }
        self.thread = threading.Thread(target=self._run, name=session_id, daemon=True)
        if archived_state is not None:
            self._state = copy.deepcopy(archived_state)
            self._state["status"] = "failed" if archived_state["status"] == "failed" else "closed"
            self._closing = True
            self._ready.set()
        else:
            atomic_json(self.root / "session.json", self._state)
            self.thread.start()

    def wait_ready(self, timeout: float = 90) -> None:
        if not self._ready.wait(timeout):
            raise TimeoutError("SUMO session is still starting")
        if self.snapshot()["status"] == "failed":
            raise RuntimeError(self.snapshot()["error"])

    def snapshot(self) -> dict:
        with self._condition:
            return copy.deepcopy(self._state)

    def _call(self, name: str, value: object = None):
        self.wait_ready()
        future: Future = Future()
        with self._condition:
            if self._closing or not self.thread.is_alive():
                raise ValueError("session is closed; its recorded history remains available")
            self._jobs.append((name, value, future))
            self._condition.notify()
        return future.result(timeout=120)

    def advance(self, target_s: int) -> dict:
        return self._call("advance", target_s)

    def pause(self) -> dict:
        if not self.thread.is_alive():
            return self.snapshot()
        return self._call("pause")

    def apply(self, request: InterventionRequest) -> dict:
        return self._call("apply", request)

    def metadata(self) -> dict:
        if not self.thread.is_alive():
            path, routes = self.root / "entities.json", self.root / "routes.json"
            return {"entities": json.loads(path.read_text()) if path.exists() else [], "routes": json.loads(routes.read_text()) if routes.exists() else [], "fleet": self.snapshot().get("fleet", [])}
        return self._call("metadata")

    def _save_metadata(self) -> None:
        engine = self._engine
        assert engine is not None
        atomic_json(self.root / "entities.json", engine.entities)
        atomic_json(self.root / "routes.json", engine.transit.public_routes())

    def _publish(self, status: str | None = None, error: str | None = None) -> None:
        engine = self._engine
        with self._condition:
            if engine is not None:
                self._state.update(
                    time_s=engine.time_s, available_until_s=self.recording.latest_s,
                    temperature_c=engine.temperature_c, counts=engine.counts(), engine_version=engine.engine_version,
                    entity_count=len(engine.entities), mobility=temperature_response(engine.temperature_c).model_dump(),
                    metrics=engine.metrics(), fleet=engine.transit.fleet(), closed_edge_ids=sorted(engine.network.closed_edges),
                    incidents=engine.snapshot_incidents(), developments=engine.snapshot_developments(),
                )
            self._state.update(revision=len(self.commands), commands=[c.stored() for c in self.commands])
            if status is not None:
                self._state["status"] = status
            self._state["error"] = error
            value = copy.deepcopy(self._state)
            self._condition.notify_all()
        atomic_json(self.root / "session.json", value)

    def _execute(self, name: str, value: object):
        engine = self._engine
        assert engine is not None
        if name == "advance":
            if not isinstance(value, int) or not engine.time_s <= value <= min(engine.config.horizon_s, engine.time_s + 120):
                raise ValueError("advance must be within the horizon and at most 120 seconds ahead")
            self._target = value
        elif name == "pause":
            self._target = engine.time_s
        elif name == "metadata":
            return {"entities": copy.deepcopy(engine.entities), "routes": engine.transit.public_routes(), "fleet": engine.transit.fleet()}
        elif name == "apply":
            assert isinstance(value, InterventionRequest)
            for command in self.commands:
                if command.command_id == value.command_id:
                    if command.intervention != value.intervention or command.at_s != value.at_s:
                        raise ValueError("command id was already used for different inputs")
                    return self.snapshot()
            if value.expected_revision != len(self.commands):
                raise ValueError("session revision changed; refresh before applying")
            if value.at_s != engine.time_s:
                raise ValueError("interventions must apply at the current simulated second")
            self._target = engine.time_s
            engine.apply(value.intervention, value.command_id)
            self.commands.append(value)
            self._save_metadata()
        else:
            raise ValueError("unknown worker command")
        self._publish("running" if self._target > engine.time_s else "paused")
        return self.snapshot()

    def _run(self) -> None:
        try:
            engine = LiveEngine(self.pack, self.config, self.root, self.recording)
            self._engine = engine
            for command in self.commands:
                engine.advance_to(command.at_s, record=False)
                engine.apply(command.intervention, command.command_id)
            engine.advance_to(self._target, record=False)
            self._save_metadata()
            self._publish("paused")
            self._ready.set()
            while True:
                with self._condition:
                    self._condition.wait_for(lambda: self._closing or bool(self._jobs) or engine.time_s < self._target)
                    if self._closing:
                        break
                    job = self._jobs.popleft() if self._jobs else None
                if job:
                    name, value, future = job
                    try:
                        future.set_result(self._execute(name, value))
                    except ValueError as exc:
                        future.set_exception(exc)
                    except Exception as exc:
                        future.set_exception(exc)
                        raise
                else:
                    engine.step()
                    status = "completed" if engine.time_s >= self.config.horizon_s else "running" if engine.time_s < self._target else "paused"
                    self._publish(status)
        except Exception as exc:
            log.exception("Live session %s failed", self.session_id)
            self._publish("failed", f"{type(exc).__name__}: {exc}"[:500])
        finally:
            if self._engine is not None:
                self._engine.close()
            with self._condition:
                self._closing = True
                for _, _, future in self._jobs:
                    future.set_exception(RuntimeError("session stopped"))
                self._jobs.clear()
            if self._state["status"] != "failed":
                self._publish("closed")
            self._ready.set()

    def close(self) -> None:
        with self._condition:
            self._closing = True
            self._condition.notify_all()
        if self.thread.ident is not None:
            self.thread.join(timeout=120)
        if self.thread.is_alive():
            raise TimeoutError("SUMO worker did not stop")


class LiveRegistry:
    def __init__(self, root: Path = LIVE_ROOT, pack_loader: Callable[[str], CityPack] = load_pack):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.pack_loader = pack_loader
        self.sessions: dict[str, LiveSession] = {}
        self.lock = threading.RLock()
        receipts = self.root / "receipts.json"
        self.receipts: dict[str, dict] = json.loads(receipts.read_text()) if receipts.exists() else {}
        self._loading: set[str] = set()

    def create(self, config: SessionConfig, parent: LiveSession | None = None, fork_s: int | None = None,
               history: list[InterventionRequest] | None = None) -> LiveSession:
        with self.lock:
            active = [s for s in self.sessions.values() if s.thread.is_alive()]
            if len(active) >= 3:
                disposable = next((s for s in active if s.snapshot()["status"] in ("paused", "completed")), None)
                if disposable is None:
                    raise ValueError("three live sessions are already running; pause one first")
                disposable.close()
            session_id = "live-" + uuid.uuid4().hex[:12]
            pack = self.pack_loader(config.pack_id)
            session = LiveSession(session_id, pack, config, self.root / session_id, parent, fork_s, history)
            self.sessions[session_id] = session
            return session

    def get(self, session_id: str) -> LiveSession:
        if not SESSION_ID.fullmatch(session_id):
            raise KeyError("live session not found")
        if session_id in self.sessions:
            return self.sessions[session_id]
        with self.lock:
            if session_id in self.sessions:
                return self.sessions[session_id]
            root = self.root / session_id
            path = root / "session.json"
            if not path.resolve().is_relative_to(self.root.resolve()) or not path.is_file():
                raise KeyError("live session not found")
            if session_id in self._loading:
                raise ValueError("recorded session lineage contains a cycle")
            self._loading.add(session_id)
            try:
                state = json.loads(path.read_text())
                config = SessionConfig.model_validate(state["config"])
                parent = self.get(state["parent_session_id"]) if state.get("parent_session_id") else None
                history = [InterventionRequest.model_validate(stored_command(c)) for c in state["commands"]]
                session = LiveSession(session_id, self.pack_loader(config.pack_id), config, root, parent, state.get("fork_s"), history, state)
                self.sessions[session_id] = session
                return session
            finally:
                self._loading.remove(session_id)

    def apply(self, session_id: str, request: InterventionRequest) -> LiveSession:
        with self.lock:
            receipt_key = f"{session_id}:{request.command_id}"
            previous = self.receipts.get(receipt_key)
            if previous:
                if stored_command(previous["request"]) != request.stored():
                    raise ValueError("command id was already used for different inputs")
                return self.get(previous["session_id"])
            parent = self.get(session_id)
            state = parent.pause()
            if state["network_fingerprint"] != parent.pack.network_fingerprint:
                raise ValueError("the city network changed; this recording cannot be continued")
            if state["revision"] != request.expected_revision:
                raise ValueError("session revision changed; refresh before applying")
            if request.at_s > state["available_until_s"]:
                raise ValueError("that time has not been simulated")
            session = parent
            if request.at_s < state["time_s"] or not parent.thread.is_alive():
                history = [c for c in parent.commands if c.at_s <= request.at_s]
                session = self.create(parent.config, parent, request.at_s, history)
                session.wait_ready()
            local = request.model_copy(update={"expected_revision": len(session.commands)})
            session.apply(local)
            self.receipts[receipt_key] = {"session_id": session.session_id, "request": request.stored()}
            atomic_json(self.root / "receipts.json", self.receipts)
            return session

    def resume(self, session_id: str) -> LiveSession:
        with self.lock:
            session = self.get(session_id)
            if session.thread.is_alive():
                return session
            state = session.snapshot()
            if state["network_fingerprint"] != session.pack.network_fingerprint:
                raise ValueError("the city network changed; this recording cannot be continued")
            if session.recording.latest_s < 0:
                raise ValueError("this session has no recorded state; start a new city")
            return self.create(session.config, session, session.recording.latest_s, list(session.commands))

    def close(self) -> None:
        for session in list(self.sessions.values()):
            session.close()
