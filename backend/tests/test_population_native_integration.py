from __future__ import annotations

import hashlib
import ipaddress
import json
import shutil
import socket
import tempfile
import time
import uuid
from collections import Counter
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI


def test_nonpaid_real_native_sumo_paired_restart_with_local_model_double(tmp_path, monkeypatch):
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "1")
    monkeypatch.setenv("OTEL_SDK_DISABLED", "true")
    monkeypatch.setenv("DO_NOT_TRACK", "1")
    monkeypatch.chdir(tmp_path)
    connections = []
    original_connect = socket.socket.connect

    def local_connections_only(sock, address):
        if sock.family in {socket.AF_INET, socket.AF_INET6}:
            assert ipaddress.ip_address(address[0]).is_loopback, "non-local socket connection is forbidden"
            connections.append(address)
        return original_connect(sock, address)

    monkeypatch.setattr(socket.socket, "connect", local_connections_only)

    from population_native_integration_support import (
        EVIDENCE_LABEL,
        MODEL,
        DeterministicPopulationModelDouble,
        running_local_app,
        tiny_native_population,
    )

    from cityshift.agents import population_client
    from cityshift.agents.population_gateway import GatewayError, PopulationGateway, get_population_gateway
    from cityshift.api.population_gateway_router import router as gateway_router
    from cityshift.api.population_router import router as population_router
    from cityshift.api.population_service import PopulationService, get_population_service
    from cityshift.api.service import Service
    from cityshift.contracts import PopulationArtifact, RunStatus, SimulationRun
    from cityshift.domain import population_runs
    from cityshift.domain.population_checkpoints import file_hash, load_checkpoint
    from cityshift.providers import PopulationProviderConfig
    from cityshift.store import Store
    from cityshift.transport.population import PopulationMobility

    source_root = population_client.SWARM_ROOT.resolve()
    assert (source_root / ".venv" / "bin" / "python").is_file(), "the actual isolated native SDK is required"
    runtime_parent = source_root / "var"
    created_runtime_parent = not runtime_parent.exists()
    runtime_parent.mkdir(mode=0o700, exist_ok=True)
    double = DeterministicPopulationModelDouble()
    gateway = PopulationGateway(
        config=PopulationProviderConfig(enabled=True, api_key=double.expected_key),
        ledger_path=tmp_path / "local-model-double-budget.sqlite3", transport=httpx.MockTransport(double.handle),
    )
    gateway_errors = []
    original_complete = gateway.complete

    async def observed_complete(token, body):
        try:
            return await original_complete(token, body)
        except GatewayError as error:
            gateway_errors.append((error.code, len(json.dumps(body).encode())))
            raise

    monkeypatch.setattr(gateway, "complete", observed_complete)
    owner = Service(Store(tmp_path / "store"))
    service = PopulationService(owner)
    app = FastAPI()
    app.include_router(population_router)
    app.include_router(gateway_router)
    app.dependency_overrides[get_population_service] = lambda: service
    app.dependency_overrides[get_population_gateway] = lambda: gateway
    gateway_http_errors = []

    @app.middleware("http")
    async def observe_gateway_rejections(request, call_next):
        response = await call_next(request)
        if request.url.path.endswith("/chat/completions") and response.status_code >= 400:
            gateway_http_errors.append((response.status_code, request.headers.get("content-length")))
        return response

    monkeypatch.setattr(population_runs, "get_population_gateway", lambda: gateway)
    native_clients = []
    native_processes = []
    mobility_instances = []
    sumo_processes = []
    retired_bridges = []
    actor_capabilities = {}
    gateway_capabilities = []
    restored_bodies = []
    run_root = tmp_path / "runs"
    native_test_project = Path(tempfile.mkdtemp(prefix="coupled-local-model-double-", dir=source_root / "var"))
    (native_test_project / ".venv").symlink_to(source_root / ".venv", target_is_directory=True)
    monkeypatch.setattr(population_client, "SWARM_ROOT", native_test_project)
    deadline = time.monotonic() + 180

    class ObservedNativeClient(population_client.NativePopulationClient):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            native_clients.append(self)

        def start(self, resume=None):
            double.generation = 1 if resume is not None else 0
            old_calls = len(double.calls)
            super().start(resume)
            assert self._process is not None
            native_processes.append(self._process)
            gateway_capabilities.append(hashlib.sha256(self._gateway_token.encode()).hexdigest())
            assert len(double.calls) == old_calls, "startup/replay must not repeat historical inference"

        def decide(self, packets):
            result = super().decide(packets)
            actor_capabilities[self.generation] = set(service.bridge(self.run_id)._scopes)
            return result

    class ObservedMobility(PopulationMobility):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            mobility_instances.append(self)

        def open(self):
            result = super().open()
            assert self._process is not None
            sumo_processes.append(self._process)
            return result

        def restore_checkpoint(self, path, metadata):
            super().restore_checkpoint(path, metadata)
            conn = self._require_open()
            live_ids = set(conn.person.getIDList()) | set(conn.vehicle.getIDList())
            assert set(metadata["active"]).issubset(live_ids)
            assert self._residents == metadata["residents"]
            restored_bodies.append({key: trip.resident_id for key, trip in self._active.items()})

    monkeypatch.setattr(population_runs, "NativePopulationClient", ObservedNativeClient)
    monkeypatch.setattr(population_runs, "PopulationMobility", ObservedMobility)
    pack, population = tiny_native_population(tmp_path)
    owner.store.put_population(population)
    run_id = population_runs.population_run_id(population, f"nonpaid-{uuid.uuid4().hex}")
    run = SimulationRun(run_id=run_id, scenario_id=population.population_id, population_id=population.population_id,
                        run_kind="population", plan_id="service-ledger-v1", seed=population.spec.seed)
    runtime_root = native_test_project / "var" / run_id

    def register_bridge(key, bridge):
        service.register_bridge(key, bridge)
        retired_bridges.append(bridge)

    def execute(*, resume=False, pause=None, cancel=None):
        return population_runs.execute_population_run(
            run, pack, population, owner.store.put_run, register_bridge, service.release_bridge,
            service._control_token, run_root=run_root, pause=pause, cancel=cancel, resume=resume,
        )

    def failure_details():
        error_file = run_root / run_id / "error.json"
        return {
            "error": run.error, "stack": json.loads(error_file.read_text()) if error_file.exists() else None,
            "local_double_errors": double.errors, "calls": len(double.calls), "gateway_errors": gateway_errors,
            "test_artifact_directory": str(tmp_path),
            "gateway_statuses": dict(Counter(row["status"] for row in gateway.usage(run_id)["requests"])),
        }

    try:
        with running_local_app(app) as port:
            monkeypatch.setattr(population_runs, "API_PORT", port)
            monkeypatch.setattr(population_runs, "POPULATION_GATEWAY_BASE", f"http://127.0.0.1:{port}/api/population/model/v1")
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=5) as http:
                bind_path = f"/api/population/bridge/{run_id}/bind"
                payload = {"resident_id": population.profiles[0].resident_id, "worker_id": "not-a-worker"}
                assert http.post(bind_path, json=payload).status_code == 401
                assert http.post(bind_path, headers={"Authorization": "Bearer untrusted"}, json=payload).status_code == 403
                assert http.get("/api/population/model/v1/models").status_code == 401
            paused = execute(pause=lambda: mobility_instances[-1].t >= 14,
                             cancel=lambda: time.monotonic() > deadline)
            assert paused.status == RunStatus.paused, failure_details()
            assert paused.checkpoint_available and paused.checkpoint_id
            assert all(process.poll() is not None for process in native_processes + sumo_processes)
            assert len(native_processes) == len(sumo_processes) == 1
            assert not service._bridges
            assert not double.errors
            before = PopulationArtifact.model_validate_json((run_root / run_id / "population.json").read_text())
            checkpoint = load_checkpoint(run_root / run_id, run_id, population)
            saved = checkpoint["world"]
            manifest = checkpoint["manifest"]
            assert before.metrics.end_time_s == saved["t"] == manifest["native"]["t"] == 14
            assert before.metrics.resident_count == 6
            assert not gateway_http_errors, gateway_http_errors
            assert not gateway_errors, gateway_errors
            assert all(record.source == "jiuwenswarm" for record in before.decisions), (
                failure_details(), [(record.resident_id, record.epoch, record.fallback_reason, record.reason)
                                    for record in before.decisions if record.source != "jiuwenswarm"],
            )
            assert {binding.resident_id for binding in before.swarm_bindings} == set(saved["states"])
            assert len({binding.worker_id for binding in before.swarm_bindings}) == 6
            assert len({binding.session_id for binding in before.swarm_bindings}) == 6
            assert len({call["epoch"] for call in double.calls}) >= 2
            assert checkpoint["mobility"]["active"], "the paired checkpoint must include a real active SUMO body"
            assert any(task["status"] == "assigned" for task in saved["tasks"].values())
            for name, digest in manifest["files"].items():
                assert file_hash(checkpoint["directory"] / name) == digest
            assert manifest["native"]["world_state_hash"] == manifest["files"]["world.json"]
            native_folder = runtime_root / "checkpoints" / manifest["native"]["checkpoint_id"]
            native_manifest = json.loads((native_folder / "manifest.json").read_text())
            assert file_hash(native_folder / "manifest.json") == manifest["native"]["checkpoint_hash"]
            assert native_manifest["workflow_name"] == "cityshift_population_v1"
            assert set(native_manifest["context_hashes"]) == set(saved["states"])
            assert native_manifest["session_tokens_spent"] == manifest["native"]["native_tokens_spent"] > 0
            assert set(native_manifest["files"]) == {"checkpoint.db", "team.db", "journal.jsonl.wal", "boundaries.json"}
            for name, digest in native_manifest["files"].items():
                assert file_hash(native_folder / name) == digest
            health = json.loads((run_root / run_id / "native.json").read_text())
            assert health["native_available"] and health["verified"]
            assert health["model_execution_verified"] is False
            assert health["sources"]["openjiuwen"]["sha"] == "ad0c9dfbbd577423cc60f73edffa0a4699cc53f9"
            assert health["sources"]["workswarm"]["sha"] == "70aa6715992d9cb2c3ec81ee35991d13747e5ce0"
            assert health["sources"]["openjiuwen"]["patch"] == native_manifest["core_patch"]
            assert native_manifest["core_patch"]["source_modified"] is True
            assert native_manifest["core_patch"]["profile"] == "cityshift-stateful-failures-v1"
            for binding in before.swarm_bindings:
                persisted = native_manifest["bindings"][binding.resident_id]
                for field in ("team_id", "workflow_id", "worker_id", "session_id", "resolved_model_id"):
                    assert persisted[field] == getattr(binding, field)
            first_calls = list(double.calls)
            first_audit = retired_bridges[0].audit()
            assert {entry["resident_id"] for entry in first_audit} == set(saved["states"])
            assert all(entry["status"] == "accepted" for entry in first_audit)
            for record in before.decisions:
                names = [entry["name"] for entry in first_audit if (entry["resident_id"], entry["epoch"])
                         == (record.resident_id, record.epoch)]
                assert {"observe_local_state", "view_tasks", "propose_action"}.issubset(names)
            damaged = checkpoint["directory"] / "mobility.json"
            original = damaged.read_bytes()
            damaged.write_bytes(original + b" ")
            try:
                with pytest.raises(ValueError, match="hash"):
                    load_checkpoint(run_root / run_id, run_id, population)
            finally:
                damaged.write_bytes(original)
            resumed = execute(resume=True, cancel=lambda: mobility_instances[-1].t >= 110 or time.monotonic() > deadline)
            assert resumed.status == RunStatus.canceled, failure_details()
            assert time.monotonic() < deadline, "bounded native/SUMO proof exceeded its wall-clock deadline"
            assert not resumed.checkpoint_available
            assert not service._bridges
            assert len(native_processes) == len(sumo_processes) == 2
            assert len({process.pid for process in native_processes + sumo_processes}) == 4
            assert all(process.poll() is not None for process in native_processes + sumo_processes)
            assert [client.generation for client in native_clients] == [0, 1]
            assert len(set(gateway_capabilities)) == 2
            assert len(actor_capabilities[0]) == len(actor_capabilities[1]) == 6
            assert actor_capabilities[0].isdisjoint(actor_capabilities[1])
            assert restored_bodies == [{key: trip["resident_id"] for key, trip in checkpoint["mobility"]["active"].items()}]
            assert double.calls[:len(first_calls)] == first_calls
            assert all(call["generation"] == 1 and call["epoch"] > saved["epoch"] and call["t"] >= saved["t"]
                       for call in double.calls[len(first_calls):])
            assert not double.errors
            assert not gateway_http_errors, gateway_http_errors
            assert not gateway_errors, gateway_errors
            assert all(count == 1 for count in double.stage_counts.values()), "historical model turns were repeated"
            assert double.resumed_private_histories == set(saved["states"])
            assert all(entry["epoch"] > saved["epoch"] for entry in retired_bridges[1].audit())
            assert all(entry["status"] == "accepted" for entry in retired_bridges[1].audit())
            recorded_audit = json.loads((run_root / run_id / "native_tools.json").read_text())
            assert recorded_audit == first_audit + retired_bridges[1].audit()
            after = PopulationArtifact.model_validate_json((run_root / run_id / "population.json").read_text())
            assert (after.run_id, after.attempt_id, after.definition) == (before.run_id, before.attempt_id, before.definition)
            assert after.metrics.end_time_s == 110
            assert after.metrics.completed_deliveries == 1
            assert after.metrics.completed_visits == 1
            assert after.metrics.completed_trips >= 3 and after.metrics.failed_trips == 0
            assert after.events[:len(before.events)] == before.events
            assert after.states[:len(before.states)] == before.states
            assert after.tasks[:len(before.tasks)] == before.tasks
            assert [record.decision_id for record in after.decisions[:len(before.decisions)]] == [
                record.decision_id for record in before.decisions
            ]
            for first, second in zip(before.decisions, after.decisions, strict=False):
                assert first.model_dump(exclude={"outcome_event_ids"}) == second.model_dump(exclude={"outcome_event_ids"})
                assert second.outcome_event_ids[:len(first.outcome_event_ids)] == first.outcome_event_ids
            assert len({event.event_id for event in after.events}) == len(after.events)
            assert len({record.decision_id for record in after.decisions}) == len(after.decisions)
            assert all(record.source == "jiuwenswarm" for record in after.decisions)
            assert all("LOCAL MODEL DOUBLE" in record.summary for record in after.decisions)
            assert all(binding.requested_model_id == binding.resolved_model_id == MODEL for binding in after.swarm_bindings)
            old_bindings = {binding.resident_id: binding for binding in before.swarm_bindings}
            new_bindings = {binding.resident_id: binding for binding in after.swarm_bindings if binding.generation == 1}
            assert set(old_bindings) == set(new_bindings)
            for resident_id, binding in new_bindings.items():
                assert binding.restored and binding.bound_s >= saved["t"]
                for field in ("team_id", "workflow_id", "worker_id", "session_id"):
                    assert getattr(binding, field) == getattr(old_bindings[resident_id], field)
            for resident_id, state in saved["states"].items():
                newest = next(snapshot.state for snapshot in reversed(after.states) if snapshot.state.resident_id == resident_id)
                assert [memory.model_dump(mode="json") for memory in newest.memories[:len(state["memories"])]] == state["memories"]
                assert f"world-private[{resident_id}]" in newest.model_dump_json()
            for entity_id, trip in checkpoint["mobility"]["active"].items():
                bindings = [binding for binding in after.mobility_bindings if binding.entity_id == entity_id]
                assert len(bindings) == 1 and bindings[0].resident_id == trip["resident_id"]
                assert bindings[0].end_s is not None and bindings[0].end_s > saved["t"]
            prepared = next(event for event in after.events if event.kind == "task_ready")
            transported = next(event for event in after.events if event.kind == "transport_accepted")
            assert prepared.t < transported.t or prepared.t == transported.t
            assert any(packet["resident_id"] == "resident-0003" and packet["t"] >= prepared.t
                       and any(task["task_id"] == prepared.task_id and task["status"] == "ready"
                               and task["provider_id"] == "resident-0001" for task in packet["tasks"])
                       for packet in double.observations.values())
            completed = [event for event in after.events if event.kind == "task_completed"]
            assert len(completed) == 2 and all(event.t > saved["t"] for event in completed)
            assert EVIDENCE_LABEL in after.definition.assumptions
            assert all(brain.api_provider == "local-mock-transport" for brain in after.definition.assignments.values())
            assert gateway.usage(run_id)["requests"] and all(row["status"] == "succeeded" for row in gateway.usage(run_id)["requests"])
            assert len(gateway.usage(run_id)["requests"]) == len(double.calls)
            assert connections and double.key_gets and double.gets
            assert owner.store.root.is_relative_to(tmp_path)
            assert Path(run.run_dir).is_relative_to(tmp_path)
            assert runtime_root.is_relative_to(native_test_project)
            assert all(Path(output).is_relative_to(tmp_path) for mobility in mobility_instances for output in mobility._output_dirs)
            with pytest.raises(ValueError, match="consumed"):
                load_checkpoint(run_root / run_id, run_id, population)
            evidence = {
                "label": EVIDENCE_LABEL, "live_model_evidence": False, "invoice_evidence": False,
                "real_provider_key_cap_verified": False, "model_transport": "httpx.MockTransport",
                "native_runtime": "actual isolated JiuwenSwarm/Core with reviewed patch",
                "sumo_runtime": run.engine_version, "resident_count": 6,
                "run_id": run_id, "attempt_id": after.attempt_id,
                "native_pids": [process.pid for process in native_processes],
                "sumo_pids": [process.pid for process in sumo_processes],
                "checkpoint_world_sha256": manifest["files"]["world.json"],
                "checkpoint_native_sha256": manifest["native"]["checkpoint_hash"],
                "mock_http_completions": len(double.calls), "epochs": len({call["epoch"] for call in double.calls}),
                "historical_model_replays": 0, "completed_deliveries": after.metrics.completed_deliveries,
                "completed_visits": after.metrics.completed_visits, "completed_trips": after.metrics.completed_trips,
            }
            (tmp_path / "nonpaid-native-integration-evidence.json").write_text(json.dumps(evidence, indent=2))
    finally:
        for client in native_clients:
            client.close()
        for mobility in mobility_instances:
            mobility.close()
        owner.pool.shutdown(wait=True)
        owner.agent_pool.shutdown(wait=True)
        log = runtime_root / "adapter.log"
        if log.is_file():
            shutil.copyfile(log, tmp_path / "local-native-adapter.log")
        (native_test_project / ".venv").unlink()
        shutil.rmtree(native_test_project)
        if created_runtime_parent:
            try:
                runtime_parent.rmdir()
            except OSError:
                pass
