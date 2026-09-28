from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path

import pytest
import sumolib

from cityshift.contracts import (
    ActivityAnchor,
    AnchorAccess,
    BrainAssignment,
    CityPack,
    PopulationSpec,
    PopulationStimulus,
    RunStatus,
    SimulationRun,
    TravelClass,
)
from cityshift.domain.population import generate_population
from cityshift.domain.population_runs import execute_population_run, population_run_id
from cityshift.domain.population_stimuli import enqueue_stimuli
from cityshift.transport.hazards import HAZARDS, alarm_radius, resident_classes
from cityshift.transport.population import HazardFootprint, PopulationMobility
from cityshift.transport.tiny_fixture import build_grid_network

CLASSES: tuple[TravelClass, ...] = ("pedestrian", "bicycle", "passenger", "delivery", "truck")


@pytest.fixture(scope="module")
def grid(tmp_path_factory) -> Path:
    return build_grid_network(tmp_path_factory.mktemp("hazard_grid"))


def anchor(net, anchor_id: str, edge_id: str, position_m: float) -> ActivityAnchor:
    edge = net.getEdge(edge_id)
    access = {kind: AnchorAccess(edge_id=edge_id, position_m=position_m,
                                 lane_index=next(lane.getIndex() for lane in edge.getLanes() if lane.allows(kind)))
              for kind in CLASSES}
    lane = edge.getLanes()[access["pedestrian"].lane_index]
    lon, lat = net.convertXY2LonLat(*sumolib.geomhelper.positionAtShapeOffset(lane.getShape(), position_m))
    return ActivityAnchor(anchor_id=anchor_id, name=anchor_id, purpose="home", lon=lon, lat=lat, access=access)


def street_centre(net, edge_id: str) -> tuple[float, float]:
    shape = net.getEdge(edge_id).getShape()
    return net.convertXY2LonLat((shape[0][0] + shape[-1][0]) / 2, (shape[0][1] + shape[-1][1]) / 2)


def places(grid: Path):
    net = sumolib.net.readNet(str(grid))
    home = anchor(net, "home", "g_00_10", 40)
    shop = anchor(net, "shop", "g_21_22", 60)
    park = anchor(net, "park", "g_01_02", 100)
    lon, lat = street_centre(net, "g_10_20")
    fire = HazardFootprint("fire-1", lon, lat, 40, resident_classes("fire"), 900)
    return home, shop, park, fire


def run_to_arrivals(mobility: PopulationMobility, hazards, count: int, limit: int = 1500, stop_at: int | None = None):
    outcomes, notices = [], []
    for _ in range(limit):
        outcomes += mobility.step()
        mobility.set_hazards(hazards)
        notices += mobility.take_notices()
        if len(outcomes) == count or mobility.t == stop_at:
            break
    return outcomes, notices


def test_hazard_classes_follow_the_declared_profiles():
    assert resident_classes("fire") == {"pedestrian", "bicycle", "passenger", "delivery", "truck"}
    assert resident_classes("crash") == {"bicycle", "passenger", "delivery", "truck"}
    assert resident_classes("storm") == resident_classes("crash")
    assert resident_classes("rain") == frozenset()
    assert alarm_radius("tornado", 100) == 100 * HAZARDS["tornado"].alarm_factor


def test_closure_diverts_vehicles_in_place_and_walkers_into_a_detour_body(tmp_path, grid):
    home, shop, _, fire = places(grid)
    with PopulationMobility(grid, tmp_path, "divert", 7, 1500) as mobility:
        before = ("passenger", "pedestrian")
        car = mobility.start_trip("driver", home, shop, "passenger")
        walker = mobility.start_trip("walker", home, shop, "pedestrian")
        route = mobility._conn.vehicle.getRoute(car)
        assert "g_10_20" in route
        for _ in range(15):
            assert mobility.step() == []
        mobility.set_hazards([fire])
        notices = {notice.resident_id: notice for notice in mobility.take_notices()}
        assert notices["driver"].status == notices["walker"].status == "diverted"
        assert notices["driver"].entity_id == car and notices["driver"].previous_entity_id is None
        # SUMO keeps a replanned walk's history in its state, so the detour continues in a new body.
        detour_body = notices["walker"].entity_id
        assert notices["walker"].previous_entity_id == walker and detour_body != walker
        assert "g_10_20" not in mobility._conn.vehicle.getRoute(car)
        assert not {"g_10_20", "g_20_10"} & set(mobility._conn.person.getEdges(detour_body))
        assert mobility.trip_status("walker")["route"] == "clear"
        # Both L-shaped routes around a grid block are equally long: the detour is found, not a longer trip.
        assert all(mobility.estimate_trip(home, shop, kind)["reachable"] for kind in before)
        outcomes, _ = run_to_arrivals(mobility, [fire], 2)
        assert {(o.resident_id, o.entity_id, o.status) for o in outcomes} == {
            ("driver", car, "arrived"), ("walker", detour_body, "arrived"),
        }
        # The first walking body's measured track ends where the detour body continues.
        assert mobility.tracks[walker].samples[-1][0] <= 15 < mobility.tracks[detour_body].samples[0][0]
        assert mobility.teleports == 0
    assert "Error" not in (tmp_path / "sumo.log").read_text()


def test_closures_expire_and_new_trips_cannot_enter_a_closed_destination(tmp_path, grid):
    home, shop, _, fire = places(grid)
    at_shop = HazardFootprint("fire-2", shop.lon, shop.lat, 30, resident_classes("fire"), 60)
    with PopulationMobility(grid, tmp_path, "expire", 7, 600) as mobility:
        open_estimates = [mobility.estimate_trip(home, shop, kind) for kind in CLASSES]
        mobility.set_hazards([at_shop, fire])
        for kind in CLASSES:
            estimate = mobility.estimate_trip(home, shop, kind)
            assert not estimate["reachable"] and "closed" in estimate["reason"]
        with pytest.raises(ValueError, match="closed"):
            mobility.start_trip("walker", home, shop, "pedestrian")
        rain = HazardFootprint("rain-1", shop.lon, shop.lat, 300, resident_classes("rain"), 600)
        for _ in range(60):
            mobility.step()
        mobility.set_hazards([at_shop, fire, rain])  # the shop fire has burned out; the longer fire remains
        assert "g_21_22" not in mobility._blocked_walk and "g_10_20" in mobility._blocked_walk
        assert mobility.estimate_trip(home, shop, "pedestrian")["reachable"]
        mobility.set_hazards([rain])  # rain closes nothing
        assert [mobility.estimate_trip(home, shop, kind) for kind in CLASSES] == open_estimates
        assert "passenger" not in mobility._conn.lane.getDisallowed("g_10_20_1")


def test_blocked_trips_are_reported_and_redirects_continue_from_the_measured_position(tmp_path, grid):
    home, shop, park, _ = places(grid)
    at_shop = HazardFootprint("fire-2", shop.lon, shop.lat, 30, resident_classes("fire"), 1500)
    with PopulationMobility(grid, tmp_path, "redirect", 7, 1500) as mobility:
        car = mobility.start_trip("driver", home, shop, "passenger")
        walker = mobility.start_trip("walker", home, shop, "pedestrian")
        for _ in range(20):
            mobility.step()
        mobility.set_hazards([at_shop])
        notices = mobility.take_notices()
        assert {(n.resident_id, n.entity_id, n.status, n.hazard_ids) for n in notices} == {
            ("driver", car, "blocked", ("fire-2",)), ("walker", walker, "blocked", ("fire-2",)),
        }
        mobility.set_hazards([at_shop])
        assert mobility.take_notices() == []  # a standing blockage is reported once
        status = mobility.trip_status("walker")
        assert status["route"] == "blocked" and status["blocked_by"] == ["fire-2"] and status["destination_id"] == "shop"
        with pytest.raises(ValueError, match="Already"):
            mobility.redirect_trip("driver", shop)
        estimate = mobility.estimate_redirect("driver", park)
        assert estimate["reachable"] and estimate["target_id"] == "park"
        road = mobility._conn.vehicle.getRoadID(car)
        new_car = mobility.redirect_trip("driver", park)
        new_walker = mobility.redirect_trip("walker", park)
        assert {new_car, new_walker}.isdisjoint({car, walker})
        assert mobility._conn.vehicle.getRoute(new_car)[0] == road
        assert mobility.trip_status("driver") == {"destination_id": "park", "travel_class": "passenger", "position": None,
                                                  "route": "clear", "blocked_by": []}
        outcomes, _ = run_to_arrivals(mobility, [at_shop], 2)
        assert {(o.resident_id, o.entity_id, o.destination_id, o.status) for o in outcomes} == {
            ("driver", new_car, "park", "arrived"), ("walker", new_walker, "park", "arrived"),
        }
        # The new body starts where the old one was last measured.
        continued = mobility.net.convertLonLat2XY(*mobility.tracks[new_car].samples[0][1:3])
        left = mobility.net.convertLonLat2XY(*mobility.tracks[car].samples[-1][1:3])
        assert math.dist(continued, left) < 5
    assert "Error" not in (tmp_path / "sumo.log").read_text()


def test_closures_and_blockages_survive_a_checkpoint_restart(tmp_path, grid):
    home, shop, _, fire = places(grid)
    at_shop = HazardFootprint("fire-2", shop.lon, shop.lat, 30, resident_classes("fire"), 1500)

    def begin(mobility):
        mobility.start_trip("driver", home, shop, "passenger")
        mobility.start_trip("walker", home, shop, "pedestrian")
        mobility.start_trip("cyclist", shop, home, "bicycle")
        for _ in range(15):
            mobility.step()
        mobility.set_hazards([fire, at_shop])
        return mobility.take_notices()

    with PopulationMobility(grid, tmp_path / "whole", "restart", 7, 1500) as mobility:
        begin(mobility)
        expected, _ = run_to_arrivals(mobility, [fire, at_shop], 3, stop_at=400)
        expected_blocked = dict(mobility._blocked)
    assert expected_blocked  # the driver bound for the closed shop street waits at the closure
    with PopulationMobility(grid, tmp_path / "first", "restart", 7, 1500) as mobility:
        begin(mobility)
        first, _ = run_to_arrivals(mobility, [fire, at_shop], 3, stop_at=120)
        metadata = mobility.save_checkpoint(tmp_path / "state.xml")
    assert metadata["hazards"]["fire-1"]["classes"] == sorted(resident_classes("fire"))
    with PopulationMobility(grid, tmp_path / "second", "restart", 7, 1500) as restored:
        restored.restore_checkpoint(tmp_path / "state.xml", metadata)
        assert restored._closed_to("passenger") >= {"g_10_20", "g_20_10"}
        assert "passenger" in restored._conn.lane.getDisallowed("g_10_20_1")
        rest, notices = run_to_arrivals(restored, [fire, at_shop], 3 - len(first), stop_at=400)
        assert notices == []
        assert restored._blocked == expected_blocked
    assert first + rest == expected


def test_checkpoint_rejects_closures_on_unknown_streets(tmp_path, grid):
    _, _, _, fire = places(grid)
    with PopulationMobility(grid, tmp_path / "saved", "reject", 7, 300) as mobility:
        mobility.set_hazards([fire])
        mobility.step()
        metadata = mobility.save_checkpoint(tmp_path / "state.xml")
    metadata["hazards"]["fire-1"]["edges"].append("not-a-street")
    with PopulationMobility(grid, tmp_path / "restored", "reject", 7, 300) as restored, pytest.raises(ValueError, match="unknown street"):
        restored.restore_checkpoint(tmp_path / "state.xml", metadata)


def grid_population(grid: Path, horizon: int = 900):
    net = sumolib.net.readNet(str(grid))
    brain = BrainAssignment(model_family="rules", model_id="baseline-v1", api_provider="local",
                            config_ref="baseline", control_mode="rules")
    spec = PopulationSpec(brains=[brain], count=12, horizon_s=horizon, recurring_need_s=300, service_duration_s=10)
    anchors = []
    for name, purpose, edge_id, position in (
        ("shop", "shop", "g_21_22", 60), ("service", "service", "g_12_22", 80), ("home-a", "home", "g_00_10", 40),
        ("home-b", "home", "g_01_02", 60), ("home-c", "home", "g_10_00", 120), ("home-d", "home", "g_02_12", 100),
        ("rest", "rest", "g_22_21", 100),
    ):
        place = anchor(net, name, edge_id, position)
        anchors.append(place.model_copy(update={"purpose": purpose, "capacity": 2, "service_duration_s": 10}))
    pack = CityPack(pack_id="grid", name="Synthetic grid", version="1", net_file=str(grid),
                    network_fingerprint=hashlib.sha256(grid.read_bytes()).hexdigest()[:16],
                    bbox=(-79.40, 43.63, -79.37, 43.65), center=(-79.387, 43.642), venue_edge_id="g_00_10",
                    venue_lonlat=(anchors[0].lon, anchors[0].lat), stops=[], zones=[], real_data=False)
    spec.pack_id = pack.pack_id
    return pack, generate_population(spec, anchors, pack.network_fingerprint)


def run_with_fire(root: Path, pack, population, pause_again_at: int | None = None) -> dict:
    """Pause after 24 s, queue a fire on the shop, resume (optionally pausing and resuming once more)."""
    run = SimulationRun(run_id=population_run_id(population, "grid-fire"), scenario_id=population.population_id,
                        population_id=population.population_id, run_kind="population", plan_id="service-ledger-v1", seed=7)
    bridges: dict = {}
    args = (run, pack, population, lambda _: None, bridges.__setitem__, bridges.pop, "test-control")

    def pause_on(call: int):
        calls = iter(range(1, 100_000))
        return lambda: next(calls) == call

    assert execute_population_run(*args, pause=pause_on(25), run_root=root).status == RunStatus.paused
    shop = next(anchor for anchor in population.anchors if anchor.anchor_id == "shop")
    enqueue_stimuli(root, run.run_id, [PopulationStimulus(
        stimulus_id="fire-1", kind="incident", hazard="fire", text="Smoke is pouring out of the shop.",
        lon=shop.lon, lat=shop.lat, radius_m=30, duration_s=600)])
    if pause_again_at is not None:
        assert execute_population_run(*args, resume=True, pause=pause_on(pause_again_at), run_root=root).status == RunStatus.paused
    assert execute_population_run(*args, resume=True, run_root=root).status == RunStatus.completed
    return json.loads((root / run.run_id / "snapshot.json").read_text())


def test_real_sumo_fire_closes_the_shop_and_travellers_choose_new_destinations(tmp_path, grid):
    pack, population = grid_population(grid)
    snapshot = run_with_fire(tmp_path / "whole", pack, population)
    record = snapshot["population"]
    events = record["events"]
    blocked = [event for event in events if event["kind"] == "route_blocked"]
    assert blocked and all(event["t"] == 24 and "no open detour" in event["text"] for event in blocked)
    for event in blocked:
        rid = event["resident_ids"][0]
        decision = next(d for d in record["decisions"] if d["resident_id"] == rid and d["t"] == 24)
        assert decision["accepted"] and decision["proposal"]["action"] == "redirect"
        assert any(e["kind"] == "trip_redirected" and e["resident_ids"] == [rid] for e in events)
        assert any(e["kind"] == "trip_arrived" and e["resident_ids"] == [rid] and e["t"] > 24 for e in events)
    # Nothing enters the closed footprint while it burns: every measured position stays outside it.
    net = sumolib.net.readNet(str(grid))
    shop = next(anchor for anchor in population.anchors if anchor.anchor_id == "shop")
    centre = net.convertLonLat2XY(shop.lon, shop.lat)
    for track in snapshot["tracks"].values():
        for t, lon, lat, *_ in track["samples"]:
            if 24 < t < 624:
                assert math.dist(net.convertLonLat2XY(lon, lat), centre) > 25
    assert not any(e["kind"] == "trip_failed" and "teleport" in e["text"] for e in events)


def test_real_sumo_pause_while_a_fire_burns_resumes_identically(tmp_path, grid):
    pack, population = grid_population(grid, horizon=400)
    whole = run_with_fire(tmp_path / "whole", pack, population)
    resumed = run_with_fire(tmp_path / "resumed", pack, population, pause_again_at=60)

    def outcome(snapshot: dict) -> dict:
        # A checkpoint boundary consumes one decision epoch, so only epoch-numbered identities may differ.
        record = snapshot["population"]
        return {
            "tracks": snapshot["tracks"], "person_events": snapshot["events"], "states": record["states"],
            "bindings": record["mobility_bindings"], "stimuli": record["stimuli"],
            "tasks": [{**row, "task": {**row["task"], "cause_id": None}} for row in record["tasks"]],
            "events": [(e["t"], e["kind"], e["resident_ids"], e["text"]) for e in record["events"]],
            "decisions": [(d["t"], d["resident_id"], d["accepted"], d["reason"], d["proposal"]["action"],
                           d["proposal"]["target_id"]) for d in record["decisions"]],
        }

    assert any(event["kind"] == "route_blocked" for event in whole["population"]["events"])
    assert outcome(resumed) == outcome(whole)


def test_a_vehicle_inside_a_footprint_drives_out_but_cannot_start_over_there(tmp_path, grid):
    home, shop, park, fire = places(grid)
    net = sumolib.net.readNet(str(grid))
    inside = anchor(net, "inside", "g_10_20", 60)
    with PopulationMobility(grid, tmp_path, "inside", 7, 900) as mobility:
        car = mobility.start_trip("driver", inside, shop, "passenger")
        for _ in range(3):
            mobility.step()
        mobility.set_hazards([fire])
        assert mobility._conn.vehicle.getRoadID(car) == "g_10_20"
        assert mobility.take_notices() == []  # its street is closed, but nothing ahead of it is
        with pytest.raises(ValueError, match="closed street"):
            mobility.redirect_trip("driver", park)
        outcomes, _ = run_to_arrivals(mobility, [fire], 1)
        assert [(o.entity_id, o.status) for o in outcomes] == [(car, "arrived")]
        assert not mobility.estimate_trip(inside, home, "passenger")["reachable"]  # nothing departs from a closed street


@pytest.mark.parametrize("crossings", [True, False])
def test_detour_walks_follow_sumo_pedestrian_connectivity(tmp_path, monkeypatch, crossings):
    """Every detour our router plans is walkable by SUMO, with and without walking areas at junctions."""
    import random
    import subprocess

    import traci

    from cityshift.transport.sumo_env import binary
    from cityshift.transport.sumo_xml import POPULATION_TYPES

    net_file = tmp_path / "net.xml"
    subprocess.run([binary("netgenerate"), "--rand", "--rand.iterations", "80", "--rand.min-distance", "60", "--seed", "3",
                    "--sidewalks.guess", *(["--crossings.guess"] if crossings else []), "--default.speed", "11",
                    "--no-turnarounds", "false", "-o", str(net_file)], check=True, capture_output=True)
    monkeypatch.setattr(sumolib.net.Net, "hasGeoProj", lambda self: True)  # generated networks are planar
    rng = random.Random(3)
    with PopulationMobility(net_file, tmp_path / "run", "fuzz", 3, 3000) as mobility:
        conn = mobility._conn
        walkable = sorted(e.getID() for e in mobility.net.getEdges() if not e.isSpecial() and e.allows("pedestrian"))
        pairs = [(rng.choice(walkable), rng.choice(walkable)) for _ in range(60)]
        for a, b in pairs[:30]:  # with nothing closed, our router agrees with SUMO's on what is reachable
            mid_a, mid_b = mobility.net.getEdge(a).getLength() / 2, mobility.net.getEdge(b).getLength() / 2
            stages = conn.simulation.findIntermodalRoute(a, b, modes="", pType=POPULATION_TYPES["pedestrian"],
                                                         departPos=mid_a, arrivalPos=mid_b)
            assert (mobility._walk_path(a, mid_a, b, mid_b) is not None) == (len(stages) == 1 and bool(stages[0].edges))
        mobility._blocked_walk = frozenset(rng.sample(walkable, len(walkable) // 8))
        started = 0
        for index, (a, b) in enumerate(pairs):
            source, target = rng.uniform(0, mobility.net.getEdge(a).getLength()), rng.uniform(0, mobility.net.getEdge(b).getLength())
            path = mobility._walk_path(a, source, b, target)
            if path is None:
                continue
            assert not mobility._blocked_walk & set(path[0][1:])
            conn.person.add(f"w{index}", a, source, depart=0, typeID=POPULATION_TYPES["pedestrian"])
            conn.person.appendWalkingStage(f"w{index}", list(path[0]), arrivalPos=target)
            started += 1
        arrived = 0
        while conn.simulation.getMinExpectedNumber() and conn.simulation.getTime() < 3000:
            try:
                conn.simulationStep()
            except traci.FatalTraCIError:
                pytest.fail("SUMO rejected a planned walk: " + (tmp_path / "run" / "sumo.log").read_text()[-400:])
            arrived += conn.simulation.getArrivedPersonNumber()
    assert started > 40 and arrived == started
    assert "Error" not in (tmp_path / "run" / "sumo.log").read_text()
