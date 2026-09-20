from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
import sumolib

from cityshift.contracts import (
    ActivityAnchor,
    AnchorAccess,
    BrainAssignment,
    CityPack,
    PopulationArtifact,
    PopulationSpec,
    RunStatus,
    SimulationRun,
)
from cityshift.domain.population import generate_population
from cityshift.domain.population_runs import execute_population_run, population_run_id
from cityshift.transport.tiny_fixture import build_tiny_network


def network_population(tmp_path: Path, count: int = 12, horizon: int = 1800):
    net_file = build_tiny_network(tmp_path / "net", geo=True)
    net = sumolib.net.readNet(str(net_file))
    brain = BrainAssignment(model_family="rules", model_id="baseline-v1", api_provider="local",
                            config_ref="baseline", control_mode="rules")
    spec = PopulationSpec(brains=[brain], count=count, horizon_s=horizon,
                          recurring_need_s=300, service_duration_s=10)
    anchors = []
    for name, purpose, eid, position in (
        ("shop", "shop", "e_BC", 100), ("service", "service", "e_CD", 80),
        ("home-a", "home", "e_AB", 200), ("home-b", "home", "e_BC", 200),
        ("home-c", "home", "e_CD", 150), ("home-d", "home", "e_CB", 100),
        ("rest", "rest", "e_CE", 50),
    ):
        edge = net.getEdge(eid)
        access = {}
        for kind in spec.enabled_classes:
            lane = next(lane for lane in edge.getLanes() if lane.allows(kind))
            access[kind] = AnchorAccess(edge_id=eid, position_m=position, lane_index=lane.getIndex())
        lane = edge.getLanes()[access["pedestrian"].lane_index]
        x, y = sumolib.geomhelper.positionAtShapeOffset(lane.getShape(), position)
        lon, lat = net.convertXY2LonLat(x, y)
        anchors.append(ActivityAnchor(anchor_id=name, name=name, purpose=purpose, lon=lon, lat=lat,
                                      access=access, capacity=max(2, count // 12), service_duration_s=10))
    pack = CityPack(pack_id="fixture", name="Synthetic population fixture", version="1", net_file=str(net_file),
                    network_fingerprint=hashlib.sha256(net_file.read_bytes()).hexdigest()[:16],
                    bbox=(-79.40, 43.63, -79.37, 43.65), center=(-79.385, 43.64), venue_edge_id="e_AB",
                    venue_lonlat=(anchors[0].lon, anchors[0].lat), stops=[], zones=[], real_data=False)
    spec.pack_id = pack.pack_id
    population = generate_population(spec, anchors, pack.network_fingerprint)
    return pack, population


def test_real_sumo_closed_loop_preserves_society_after_first_trip(tmp_path, monkeypatch):
    from cityshift.domain import population_runs

    published_at = []
    original_save = population_runs._save

    def save(world, *args, **kwargs):
        published_at.append(world.t)
        return original_save(world, *args, **kwargs)

    monkeypatch.setattr(population_runs, "_save", save)
    pack, population = network_population(tmp_path)
    rid = population_run_id(population, "one-attempt")
    assert rid == population_run_id(population, "one-attempt")
    assert rid != population_run_id(population, "another-attempt")
    run = SimulationRun(run_id=rid, scenario_id=population.population_id, population_id=population.population_id,
                        run_kind="population", plan_id="service-ledger-v1", seed=7)
    bridges = {}
    history = []
    result = execute_population_run(run, pack, population, lambda value: history.append(value.model_copy(deep=True)),
                                    lambda key, value: bridges.__setitem__(key, value),
                                    lambda key: bridges.pop(key), "test-control-only", run_root=tmp_path / "runs")
    assert result.status == RunStatus.completed, result.error
    assert published_at == list(range(0, population.spec.horizon_s, population_runs.ARTIFACT_INTERVAL_S)) + [population.spec.horizon_s]
    assert not bridges
    artifact = PopulationArtifact.model_validate_json((Path(result.run_dir) / "population.json").read_text())
    assert artifact.definition == population
    assert artifact.metrics.resident_count == 12
    assert artifact.metrics.end_time_s == population.spec.horizon_s
    assert artifact.metrics.completed_deliveries > 0
    assert artifact.metrics.completed_visits > 0
    assert artifact.metrics.completed_trips > 0
    assert {record.source for record in artifact.decisions} == {"rules"}
    assert any(event.kind == "recurring_need" for event in artifact.events)
    assert any(event.kind == "request_created" for event in artifact.events)
    assert not artifact.swarm_bindings
    tracks = json.loads((Path(result.run_dir) / "tracks.json").read_text())
    assert tracks and all(track["resident_id"] for track in tracks.values())
    assert all(all(len(sample) == 5 for sample in track["samples"]) for track in tracks.values())
    manifest = json.loads((Path(result.run_dir) / "manifest.json").read_text())
    assert manifest["attempt_id"] and manifest["spec_hash"]
    assert manifest["control_mode"] == "rules"
    for name, digest in manifest["artifacts"].items():
        assert hashlib.sha256((Path(result.run_dir) / name).read_bytes()).hexdigest() == digest


@pytest.mark.parametrize("failure", ["stopped_runtime", "transport_timeout", "invalid_boundary"])
def test_native_boundary_failure_stops_instead_of_finishing_with_repeated_fallbacks(tmp_path, monkeypatch, failure):
    from cityshift.agents.population_client import SwarmUnavailable
    from cityshift.domain import population_runs

    pack, population = network_population(tmp_path, horizon=60)
    brain = BrainAssignment(model_family="claude", model_id="anthropic/claude-haiku-4.5", api_provider="openrouter",
                            config_ref="native-failure-test", control_mode="jiuwenswarm")
    population.spec.brains = [brain]
    population.assignments = dict.fromkeys(population.assignments, brain)
    rid = population_run_id(population, failure)
    run = SimulationRun(run_id=rid, scenario_id=population.population_id, population_id=population.population_id,
                        run_kind="population", plan_id="service-ledger-v1", seed=population.spec.seed)
    usage = {"remaining_microdollars": 20_000_000, "blocked": False,
             "run_totals": {"calls": 0, "reported_tokens": 0, "reported_cost_microdollars": 0,
                           "accounted_microdollars": 0, "uncertain_requests": 0}}
    gateway = SimpleNamespace(preflight=AsyncMock(return_value={}),
                              register_run=lambda *a, **k: SimpleNamespace(token="local-test-gateway-token"),
                              unregister_run=lambda _: None, usage=lambda _: usage)
    errors = {"stopped_runtime": SwarmUnavailable("native runtime failed"),
              "transport_timeout": httpx.ReadTimeout("local boundary timeout"),
              "invalid_boundary": ValueError("wrong native boundary")}

    class UnavailableNativeRuntime:
        def __init__(self, *args):
            self.health = {"native_available": True, "evidence": "local boundary double"}

        def start(self, resume=None):
            pass

        def decide(self, packets):
            raise errors[failure]

        def close(self):
            pass

    monkeypatch.setattr(population_runs, "get_population_gateway", lambda: gateway)
    monkeypatch.setattr(population_runs, "NativePopulationClient", UnavailableNativeRuntime)
    bridges, records = {}, []
    result = execute_population_run(run, pack, population, lambda value: records.append(value.model_copy(deep=True)),
                                    lambda key, value: bridges.__setitem__(key, value), lambda key: bridges.pop(key),
                                    "local-test-control", run_root=tmp_path / "runs")
    assert result.status == RunStatus.failed
    artifact = PopulationArtifact.model_validate_json((Path(result.run_dir) / "population.json").read_text())
    assert artifact.metrics.end_time_s == 0
    assert not artifact.decisions
    assert not artifact.swarm_bindings
    assert not bridges
    assert records[-1].status == RunStatus.failed


@pytest.mark.parametrize("failure", ["constructor", "artifact", "network"])
def test_setup_or_artifact_failure_releases_resources_and_persists_final_status(tmp_path, monkeypatch, failure):
    from cityshift.domain import population_runs

    pack, population = network_population(tmp_path, horizon=60)
    rid = population_run_id(population, failure)
    run = SimulationRun(run_id=rid, scenario_id=population.population_id, population_id=population.population_id,
                        run_kind="population", plan_id="service-ledger-v1", seed=7)
    bridges, records = {}, []

    def unavailable(*args, **kwargs):
        raise OSError("synthetic unavailable resource")

    if failure == "network":
        population.network_fingerprint = "changed-network"
    else:
        monkeypatch.setattr(population_runs, "PopulationMobility" if failure == "constructor" else "_save", unavailable)
    result = execute_population_run(run, pack, population, lambda value: records.append(value.model_copy(deep=True)),
                                    lambda key, value: bridges.__setitem__(key, value), lambda key: bridges.pop(key),
                                    "fixture-control", run_root=tmp_path / "runs", cancel=lambda: True)
    assert result.status == RunStatus.failed
    assert result.ended_at is not None
    assert records[-1].status == RunStatus.failed and records[-1].ended_at is not None
    assert not bridges
