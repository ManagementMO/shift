from __future__ import annotations

import copy
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest
import sumolib
import traci
from traci import constants as tc

from cityshift.contracts import ActivityAnchor, AnchorAccess, TravelClass
from cityshift.transport.population import MobilityOutcome, PopulationMobility
from cityshift.transport.tiny_fixture import build_tiny_network

CLASSES: tuple[TravelClass, ...] = ("pedestrian", "bicycle", "passenger", "delivery", "truck")
KINDS = {"pedestrian": "person", "bicycle": "bicycle", "passenger": "car", "delivery": "delivery", "truck": "truck"}


@pytest.fixture(scope="module")
def geo_net_path(tmp_path_factory) -> Path:
    return build_tiny_network(tmp_path_factory.mktemp("population_mobility"), geo=True)


def anchor(net, anchor_id: str, edge_id: str = "e_AB", position_m: float = 80) -> ActivityAnchor:
    lane = net.getLane(f"{edge_id}_0")
    xy = sumolib.geomhelper.positionAtShapeOffset(lane.getShape(), position_m)
    lon, lat = net.convertXY2LonLat(*xy)
    return ActivityAnchor(
        anchor_id=anchor_id, name=anchor_id, purpose="home", lon=lon, lat=lat,
        access={
            travel_class: AnchorAccess(edge_id=edge_id, position_m=position_m, lane_index=0 if travel_class == "pedestrian" else 1)
            for travel_class in CLASSES
        },
    )


def complete(mobility: PopulationMobility, limit: int = 1000) -> MobilityOutcome:
    for _ in range(limit):
        outcomes = mobility.step()
        if outcomes:
            assert len(outcomes) == 1
            return outcomes[0]
    pytest.fail("SUMO did not report a mobility outcome")


@pytest.mark.parametrize("travel_class", CLASSES)
def test_real_classes_positions_tracks_and_arrivals(tmp_path, geo_net_path, travel_class):
    net = sumolib.net.readNet(str(geo_net_path))
    origin = anchor(net, "origin", position_m=80)
    destination = anchor(net, "destination", position_m=160)
    with PopulationMobility(geo_net_path, tmp_path, f"class-{travel_class}", 7, 300) as mobility:
        estimate = mobility.estimate_trip(origin, destination, travel_class)
        assert estimate["target_id"] == "destination"
        assert estimate["travel_class"] == travel_class
        assert estimate["reachable"] and not estimate["reason"]
        assert estimate["distance_m"] == pytest.approx(80, abs=1)
        assert estimate["duration_s"] > 0
        body = mobility.start_trip("resident", origin, destination, travel_class)
        assert body != "resident"
        assert mobility.step() == []
        conn = mobility._conn
        assert conn is not None
        if travel_class == "pedestrian":
            assert conn.person.getIDList() == (body,)
            assert not conn.vehicle.getIDList()
            stage = conn.person.getStage(body)
            assert stage.type == tc.STAGE_WALKING
            assert stage.arrivalPos == pytest.approx(160)
            domain = conn.person
        else:
            assert conn.vehicle.getIDList() == (body,)
            assert not conn.person.getIDList()
            assert conn.vehicle.getVehicleClass(body) == travel_class
            assert conn.vehicle.getRoute(body) == ("e_AB",)
            domain = conn.vehicle
        assert domain.getLanePosition(body) == pytest.approx(80, abs=2)
        assert domain.getLaneID(body) == f"e_AB_{origin.access[travel_class].lane_index}"
        track = mobility.tracks[body]
        assert track.kind == KINDS[travel_class]
        assert track.resident_id == "resident"
        assert track.vehicle_class == travel_class
        measured = net.convertXY2LonLat(*domain.getPosition(body))
        assert track.samples[-1][1:3] == pytest.approx(measured, abs=1e-7)
        outcome = complete(mobility)
        assert outcome.status == "arrived" and not outcome.reason
        assert (outcome.resident_id, outcome.entity_id, outcome.destination_id) == ("resident", body, "destination")
        assert outcome.t == mobility.t
        assert [row[0] for row in track.samples] == list(range(1, len(track.samples) + 1))
        assert [event.event for event in mobility.events] == ["depart", "arrive"]
        assert all(event.person_id == "resident" for event in mobility.events)
        assert mobility.teleports == 0
    root = ET.parse(tmp_path / "tripinfo.xml")
    trip = root.find(f"personinfo[@id='{body}']/walk") if travel_class == "pedestrian" else root.find(f"tripinfo[@id='{body}']")
    assert trip is not None
    assert float(trip.attrib["departPos"]) == pytest.approx(80)
    assert float(trip.attrib["arrivalPos"]) == pytest.approx(160)


def test_return_trips_mode_changes_and_active_body_identity(tmp_path, geo_net_path):
    net = sumolib.net.readNet(str(geo_net_path))
    home = anchor(net, "home", position_m=100)
    shop = anchor(net, "shop", edge_id="e_BC", position_m=40)
    with PopulationMobility(geo_net_path, tmp_path, "repeat", 7, 1500) as mobility:
        bodies = []
        for origin, destination, travel_class in [(home, shop, "bicycle"), (shop, home, "pedestrian"), (home, shop, "delivery")]:
            body = mobility.start_trip("resident", origin, destination, travel_class)
            bodies.append(body)
            with pytest.raises(ValueError, match="active"):
                mobility.start_trip("resident", origin, destination, travel_class)
            outcome = complete(mobility)
            assert outcome.status == "arrived"
            assert outcome.entity_id == body and outcome.destination_id == destination.anchor_id
            assert not mobility._conn.vehicle.getIDList()
            assert not mobility._conn.person.getIDList()
            for _ in range(10):
                assert mobility.step() == []
        assert len(set(bodies)) == 3
        assert set(mobility.tracks) == set(bodies)
        assert [mobility.tracks[body].kind for body in bodies] == ["bicycle", "person", "delivery"]
        assert {track.resident_id for track in mobility.tracks.values()} == {"resident"}
        assert [event.event for event in mobility.events] == ["depart", "arrive"] * 3


def test_idle_connection_remains_stepable_for_future_trips(tmp_path, geo_net_path):
    net = sumolib.net.readNet(str(geo_net_path))
    with PopulationMobility(geo_net_path, tmp_path, "idle", 7, 200) as mobility:
        conn = mobility._conn
        for _ in range(35):
            assert mobility.step() == []
        assert mobility.t == 35 and conn.simulation.getMinExpectedNumber() == 0
        body = mobility.start_trip("later", anchor(net, "a"), anchor(net, "b", position_m=100), "passenger")
        assert complete(mobility).entity_id == body
        while mobility.t < 200:
            assert mobility.step() == []
        assert mobility._conn is conn and mobility.t == 200
        assert mobility.step() == []
        with pytest.raises(ValueError, match="horizon"):
            mobility.start_trip("too-late", anchor(net, "a"), anchor(net, "b"), "pedestrian")


@pytest.mark.parametrize("side,travel_class,update,reason", [
    ("origin", "passenger", {"lane_index": 0}, "permission"),
    ("destination", "pedestrian", {"lane_index": 1}, "permission"),
    ("origin", "bicycle", {"lane_index": 99}, "lane"),
    ("destination", "truck", {"position_m": 10000}, "position"),
    ("origin", "delivery", {"edge_id": "missing"}, "edge"),
])
def test_invalid_anchor_access_is_rejected_before_insertion(tmp_path, geo_net_path, side, travel_class, update, reason):
    net = sumolib.net.readNet(str(geo_net_path))
    origin, destination = anchor(net, "a"), anchor(net, "b", position_m=160)
    target = origin if side == "origin" else destination
    target.access[travel_class] = target.access[travel_class].model_copy(update=update)
    with PopulationMobility(geo_net_path, tmp_path, "invalid", 7, 100) as mobility:
        estimate = mobility.estimate_trip(origin, destination, travel_class)
        assert not estimate["reachable"] and reason in estimate["reason"].lower()
        assert estimate["duration_s"] is None and estimate["distance_m"] is None
        with pytest.raises(ValueError, match=reason):
            mobility.start_trip("resident", origin, destination, travel_class)
        assert not mobility.tracks and not mobility.events
        assert not mobility._conn.person.getIDList() and not mobility._conn.vehicle.getLoadedIDList()


@pytest.mark.parametrize("travel_class", CLASSES)
def test_disconnected_routes_are_not_fabricated(tmp_path, geo_net_path, travel_class):
    tree = ET.parse(geo_net_path)
    for edge_id in ("e_BC", "e_CB"):
        for lane in tree.findall(f"edge[@id='{edge_id}']/lane"):
            lane.set("allow", "rail")
            lane.attrib.pop("disallow", None)
    blocked = tmp_path / "blocked.net.xml"
    tree.write(blocked)
    net = sumolib.net.readNet(str(blocked))
    with PopulationMobility(blocked, tmp_path, "disconnected", 7, 100) as mobility:
        origin, destination = anchor(net, "a"), anchor(net, "b", edge_id="e_CD")
        estimate = mobility.estimate_trip(origin, destination, travel_class)
        assert not estimate["reachable"] and estimate["reason"]
        with pytest.raises(ValueError):
            mobility.start_trip("resident", origin, destination, travel_class)
        assert not mobility.tracks


@pytest.mark.parametrize("travel_class", ["pedestrian", "passenger"])
def test_disappearance_is_failure_not_arrival(tmp_path, geo_net_path, travel_class):
    net = sumolib.net.readNet(str(geo_net_path))
    with PopulationMobility(geo_net_path, tmp_path, "removed", 7, 200) as mobility:
        body = mobility.start_trip("resident", anchor(net, "a"), anchor(net, "b", edge_id="e_CD"), travel_class)
        assert mobility.step() == []
        domain = mobility._conn.person if travel_class == "pedestrian" else mobility._conn.vehicle
        domain.remove(body, reason=tc.REMOVE_VAPORIZED)
        outcome = complete(mobility, limit=2)
        assert outcome.status == "failed" and outcome.reason
        assert outcome.entity_id == body
        assert not any(event.event == "arrive" for event in mobility.events)


def test_same_edge_reverse_route_is_mode_and_position_aware(tmp_path, geo_net_path):
    net = sumolib.net.readNet(str(geo_net_path))
    origin = anchor(net, "a", position_m=180)
    destination = anchor(net, "b", position_m=80)
    with PopulationMobility(geo_net_path, tmp_path, "reverse", 7, 500) as mobility:
        walk = mobility.estimate_trip(origin, destination, "pedestrian")
        bicycle = mobility.estimate_trip(origin, destination, "bicycle")
        assert walk["reachable"] and bicycle["reachable"]
        assert walk["distance_m"] == pytest.approx(100, abs=1)
        assert bicycle["distance_m"] > 300
        body = mobility.start_trip("resident", origin, destination, "bicycle")
        mobility.step()
        assert len(mobility._conn.vehicle.getRoute(body)) > 1
        assert complete(mobility).status == "arrived"


@pytest.mark.parametrize("reverse", [False, True])
def test_walking_estimates_use_both_access_positions(tmp_path, geo_net_path, reverse):
    net = sumolib.net.readNet(str(geo_net_path))
    origin, destination = anchor(net, "a"), anchor(net, "b", edge_id="e_BC", position_m=40)
    if reverse:
        origin, destination = destination, origin
    with PopulationMobility(geo_net_path, tmp_path, "walk-positions", 7, 300) as mobility:
        estimate = mobility.estimate_trip(origin, destination, "pedestrian")
        expected = net.getEdge("e_AB").getLength() - 80 + 40
        assert estimate["reachable"]
        assert estimate["distance_m"] == pytest.approx(expected, abs=1)
        assert estimate["duration_s"] == pytest.approx(expected / 1.4, abs=1)
        assert not mobility.tracks and not mobility.events and mobility.t == 0


def test_horizon_reports_unfinished_trip_as_failure(tmp_path, geo_net_path):
    net = sumolib.net.readNet(str(geo_net_path))
    with PopulationMobility(geo_net_path, tmp_path, "horizon", 7, 2) as mobility:
        body = mobility.start_trip("resident", anchor(net, "a"), anchor(net, "b", edge_id="e_CD"), "pedestrian")
        assert mobility.step() == []
        outcomes = mobility.step()
        assert len(outcomes) == 1 and outcomes[0].entity_id == body
        assert outcomes[0].status == "failed" and "horizon" in outcomes[0].reason
        assert mobility.step() == []
        assert not any(event.event == "arrive" for event in mobility.events)


def test_real_vehicle_teleport_fails_trip(tmp_path, geo_net_path):
    net = sumolib.net.readNet(str(geo_net_path))
    origin, destination = anchor(net, "a"), anchor(net, "b", edge_id="e_CD")
    with PopulationMobility(geo_net_path, tmp_path, "teleport", 7, 700) as mobility:
        blocker = mobility.start_trip("blocker", origin, destination, "passenger")
        mobility._conn.vehicle.setStop(blocker, "e_AB", pos=150, laneIndex=1, duration=1000.0)
        follower = mobility.start_trip("follower", origin, destination, "passenger")
        outcomes = []
        for _ in range(650):
            outcomes.extend(mobility.step())
            if outcomes:
                break
        outcome = next(outcome for outcome in outcomes if outcome.entity_id == follower)
        assert mobility.teleports >= 1
        assert outcome.status == "failed" and "teleport" in outcome.reason
        assert not any(event.event == "arrive" and event.person_id == "follower" for event in mobility.events)


@pytest.mark.parametrize("allowed_class", ["bicycle", "delivery", "truck"])
def test_class_specific_path_permissions_are_not_shared(tmp_path, geo_net_path, allowed_class):
    tree = ET.parse(geo_net_path)
    for edge_id in ("e_BC", "e_CB"):
        lane = tree.find(f"edge[@id='{edge_id}']/lane[@index='1']")
        lane.set("allow", allowed_class)
        lane.attrib.pop("disallow", None)
    restricted = tmp_path / "restricted.net.xml"
    tree.write(restricted)
    net = sumolib.net.readNet(str(restricted))
    with PopulationMobility(restricted, tmp_path, "permissions", 7, 700) as mobility:
        origin, destination = anchor(net, "a"), anchor(net, "b", edge_id="e_CD")
        for travel_class in CLASSES:
            estimate = mobility.estimate_trip(origin, destination, travel_class)
            assert estimate["reachable"] == (travel_class in {"pedestrian", allowed_class})
        mobility.start_trip("resident", origin, destination, allowed_class)
        assert complete(mobility, limit=700).status == "arrived"


@pytest.mark.parametrize("departed", [False, True])
def test_empty_walking_stages_do_not_fabricate_arrival(tmp_path, geo_net_path, departed):
    net = sumolib.net.readNet(str(geo_net_path))
    with PopulationMobility(geo_net_path, tmp_path, "empty-stage", 7, 100) as mobility:
        body = mobility.start_trip("resident", anchor(net, "a"), anchor(net, "b", edge_id="e_CD"), "pedestrian")
        if departed:
            mobility.step()
        mobility._conn.person.removeStages(body)
        outcome = complete(mobility, limit=2)
        assert outcome.status == "failed" and outcome.reason
        assert not any(event.event == "arrive" for event in mobility.events)


@pytest.mark.parametrize("travel_class", ["pedestrian", "passenger"])
def test_zero_length_trip_still_uses_sumo_arrival(tmp_path, geo_net_path, travel_class):
    net = sumolib.net.readNet(str(geo_net_path))
    with PopulationMobility(geo_net_path, tmp_path, "zero", 7, 20) as mobility:
        origin, destination = anchor(net, "a"), anchor(net, "b")
        assert mobility.estimate_trip(origin, destination, travel_class)["distance_m"] == pytest.approx(0, abs=0.01)
        body = mobility.start_trip("resident", origin, destination, travel_class)
        outcome = complete(mobility, limit=5)
        assert outcome.entity_id == body and outcome.status == "arrived"
        assert outcome.t > 0


def test_missing_mode_access_and_live_source_permission_are_validated(tmp_path, geo_net_path):
    net = sumolib.net.readNet(str(geo_net_path))
    with PopulationMobility(geo_net_path, tmp_path, "access", 7, 100) as mobility:
        origin, destination = anchor(net, "a"), anchor(net, "b", position_m=160)
        del destination.access["delivery"]
        assert not mobility.estimate_trip(origin, destination, "delivery")["reachable"]
        assert mobility.estimate_trip(origin, destination, "truck")["reachable"]
        mobility._conn.lane.setAllowed("e_AB_1", ["bicycle"])
        assert not mobility.estimate_trip(origin, destination, "truck")["reachable"]
        assert mobility.estimate_trip(origin, destination, "bicycle")["reachable"]
        assert not mobility.tracks


def test_rejected_walking_stage_rolls_back_pending_person(tmp_path, geo_net_path, monkeypatch):
    net = sumolib.net.readNet(str(geo_net_path))
    with PopulationMobility(geo_net_path, tmp_path, "rollback", 7, 100) as mobility:
        rejected = []

        def reject_stage(entity_id, *args, **kwargs):
            rejected.append(entity_id)
            raise traci.TraCIException("stage rejected")

        with monkeypatch.context() as patch:
            patch.setattr(mobility._conn.person, "appendWalkingStage", reject_stage)
            with pytest.raises(ValueError, match="stage rejected"):
                mobility.start_trip("resident", anchor(net, "a"), anchor(net, "b", position_m=100), "pedestrian")
        assert len(rejected) == 1
        with pytest.raises(traci.TraCIException, match="not known"):
            mobility._conn.person.getRemainingStages(rejected[0])
        assert not mobility.tracks and not mobility.events
        mobility.start_trip("resident", anchor(net, "a"), anchor(net, "b", position_m=100), "pedestrian")
        assert complete(mobility).status == "arrived"


def test_connections_are_isolated_and_close_is_idempotent(tmp_path, geo_net_path):
    first = PopulationMobility(geo_net_path, tmp_path / "first", "same-run-id", 7, 10)
    second = PopulationMobility(geo_net_path, tmp_path / "second", "same-run-id", 7, 10)
    with first, second:
        assert first._conn is not second._conn
        first.open()
        first.step()
        first.step()
        second.step()
        assert (first.t, second.t) == (2, 1)
    first.close()
    second.close()
    with pytest.raises(RuntimeError, match="open|closed"):
        first.step()


def test_non_geographic_network_is_rejected_instead_of_faking_lonlat(tmp_path):
    net_file = build_tiny_network(tmp_path / "local")
    with pytest.raises(ValueError, match="geographic|projection"), PopulationMobility(net_file, tmp_path / "run", "no-geo", 7, 10):
        pass


def recording(mobility):
    return {
        "t": mobility.t,
        "tracks": {key: track.model_dump(mode="json") for key, track in mobility.tracks.items()},
        "events": [event.model_dump(mode="json") for event in mobility.events],
        "teleports": mobility.teleports,
    }


def restart(mobility, checkpoint):
    before = recording(mobility)
    metadata = json.loads(json.dumps(mobility.save_checkpoint(checkpoint), allow_nan=False))
    assert metadata["t"] == mobility.t
    assert metadata["run_id"] == mobility.run_id
    assert metadata["seed"] == mobility.seed and metadata["horizon_s"] == mobility.horizon_s
    state = ET.parse(checkpoint).getroot()
    assert state.tag == "snapshot" and float(state.attrib["time"]) == mobility.t
    assert state.find("rngState") is not None
    assert state.findall("rngState/rngLane")
    expected = set(mobility._active)
    assert {node.attrib["id"] for node in state.findall("vehicle") + state.findall(".//person")} == expected
    mobility.close()
    old_files = {
        path: path.read_bytes() for path in mobility.run_dir.rglob("*") if path.is_file()
    }
    restored = PopulationMobility(mobility.net_file, mobility.run_dir, mobility.run_id, mobility.seed, mobility.horizon_s)
    try:
        restored.open()
        restored.restore_checkpoint(checkpoint, metadata)
        assert recording(restored) == before
        assert set(restored._active) == expected
        assert restored._residents == mobility._residents
        assert restored._sequence == mobility._sequence
        assert all(path.read_bytes() == content for path, content in old_files.items())
    except BaseException:
        restored.close()
        raise
    return restored


def assert_same_recordings(actual, expected):
    assert actual[1] == expected[1]
    assert {key: value for key, value in actual[0].items() if key != "tracks"} == {
        key: value for key, value in expected[0].items() if key != "tracks"
    }
    assert actual[0]["tracks"].keys() == expected[0]["tracks"].keys()
    for entity_id, expected_track in expected[0]["tracks"].items():
        actual_track = actual[0]["tracks"][entity_id]
        assert {key: value for key, value in actual_track.items() if key != "samples"} == {
            key: value for key, value in expected_track.items() if key != "samples"
        }
        assert len(actual_track["samples"]) == len(expected_track["samples"])
        differences = [(index, left, right) for index, (left, right) in enumerate(
            zip(expected_track["samples"], actual_track["samples"], strict=True)
        ) if left != right]
        assert not differences, (entity_id, len(differences), differences[:4])


def test_checkpoint_runtime_enables_native_rng_and_transportable_state(tmp_path, geo_net_path):
    with PopulationMobility(geo_net_path, tmp_path, "native-options", 7, 20) as mobility:
        assert mobility._conn.simulation.getOption("save-state.rng") == "true"
        assert mobility._conn.simulation.getOption("save-state.transportables") == "true"
        assert int(mobility._conn.simulation.getOption("save-state.precision")) >= 17
        state_file = tmp_path / "state.xml"
        mobility.save_checkpoint(state_file)
        state = ET.parse(state_file).getroot()
        assert state.find("rngState") is not None and state.findall("rngState/rngLane")


def mixed_checkpoint_run(net_file, run_dir, resume):
    mobility = PopulationMobility(net_file, run_dir, "mixed-checkpoint", 19, 1200)
    outcomes = []
    try:
        mobility.open()
        net = mobility.net
        for resident_id, kind, edge, position, dest_edge, dest_position in [
            ("walker", "pedestrian", "e_AB", 260, "e_CE", 120),
            ("cyclist", "bicycle", "e_AB", 90, "e_CE", 180),
            ("van", "delivery", "e_DC", 90, "e_AB", 140),
            ("truck", "truck", "e_BC", 130, "e_CE", 150),
            ("driver", "passenger", "e_CE", 250, "e_AB", 100),
        ]:
            mobility.start_trip(resident_id, anchor(net, f"{resident_id}-a", edge, position),
                                anchor(net, f"{resident_id}-b", dest_edge, dest_position), kind)
        while mobility.t < 17:
            outcomes.extend(mobility.step())
        assert len(mobility._active) == 5 and all(trip.departed for trip in mobility._active.values())
        if resume:
            mobility = restart(mobility, run_dir / "checkpoint.xml")
        while mobility.t < 300:
            outcomes.extend(mobility.step())
        future = mobility.start_trip("future", anchor(net, "future-a", position_m=100),
                                     anchor(net, "future-b", position_m=160), "passenger")
        assert future.endswith("000006")
        while mobility.t < mobility.horizon_s:
            outcomes.extend(mobility.step())
        assert not mobility._active and all(outcome.status == "arrived" for outcome in outcomes)
        return recording(mobility), [asdict(outcome) for outcome in outcomes]
    finally:
        mobility.close()


def test_checkpoint_process_restart_matches_uninterrupted_mixed_paths_and_events(tmp_path, geo_net_path):
    expected = mixed_checkpoint_run(geo_net_path, tmp_path / "uninterrupted", False)
    actual = mixed_checkpoint_run(geo_net_path, tmp_path / "restarted", True)
    assert_same_recordings(actual, expected)


def pending_checkpoint_run(net_file, run_dir, resume, at_t):
    mobility = PopulationMobility(net_file, run_dir, "pending-checkpoint", 23, 400)
    outcomes = []
    try:
        mobility.open()
        origin = anchor(mobility.net, "a")
        destination = anchor(mobility.net, "b", "e_CD", 100)
        blocker = mobility.start_trip("blocker", origin, destination, "delivery")
        mobility._conn.vehicle.setStop(blocker, "e_AB", pos=140, laneIndex=1, duration=60.0)
        queued = mobility.start_trip("queued", origin, destination, "truck")
        while mobility.t < at_t:
            outcomes.extend(mobility.step())
        walker = mobility.start_trip("waiting-person", origin, anchor(mobility.net, "near", position_m=140), "pedestrian")
        assert walker not in mobility._conn.person.getIDList()
        assert not mobility._active[walker].departed and not mobility._active[queued].departed
        if at_t:
            assert queued in mobility._conn.simulation.getPendingVehicles()
        if resume:
            mobility = restart(mobility, run_dir / "checkpoint.xml")
            assert queued in mobility._conn.vehicle.getLoadedIDList()
            assert mobility._conn.person.getRemainingStages(walker) >= 1
            assert not mobility._active[walker].departed and not mobility._active[queued].departed
        while mobility.t < mobility.horizon_s:
            outcomes.extend(mobility.step())
        assert len(outcomes) == 3 and all(outcome.status == "arrived" for outcome in outcomes)
        return recording(mobility), [asdict(outcome) for outcome in outcomes]
    finally:
        mobility.close()


@pytest.mark.parametrize("at_t", [0, 1])
def test_checkpoint_restores_pending_person_and_queued_vehicle(tmp_path, geo_net_path, at_t):
    expected = pending_checkpoint_run(geo_net_path, tmp_path / "uninterrupted", False, at_t)
    actual = pending_checkpoint_run(geo_net_path, tmp_path / "restarted", True, at_t)
    assert_same_recordings(actual, expected)


def idle_checkpoint_run(net_file, run_dir, resume, completed_trip):
    mobility = PopulationMobility(net_file, run_dir, "idle-checkpoint", 31, 300)
    outcomes = []
    try:
        mobility.open()
        origin = anchor(mobility.net, "a")
        destination = anchor(mobility.net, "b", position_m=100)
        if completed_trip:
            mobility.start_trip("resident", origin, destination, "pedestrian")
            outcomes.append(complete(mobility))
        while mobility.t < 40:
            outcomes.extend(mobility.step())
        assert not mobility._active and mobility._conn.simulation.getMinExpectedNumber() == 0
        if resume:
            mobility = restart(mobility, run_dir / "checkpoint.xml")
        while mobility.t < 65:
            assert mobility.step() == []
        mobility.start_trip("resident", destination, anchor(mobility.net, "next", "e_CE", 40), "bicycle")
        while mobility.t < mobility.horizon_s:
            outcomes.extend(mobility.step())
        assert not mobility._active and all(outcome.status == "arrived" for outcome in outcomes)
        return recording(mobility), [asdict(outcome) for outcome in outcomes]
    finally:
        mobility.close()


@pytest.mark.parametrize("completed_trip", [False, True])
def test_checkpoint_idle_future_trip_and_completed_history(tmp_path, geo_net_path, completed_trip):
    expected = idle_checkpoint_run(geo_net_path, tmp_path / "uninterrupted", False, completed_trip)
    actual = idle_checkpoint_run(geo_net_path, tmp_path / "restarted", True, completed_trip)
    assert_same_recordings(actual, expected)


def turning_checkpoint_run(net_file, run_dir, resume, travel_class="delivery"):
    mobility = PopulationMobility(net_file, run_dir, "turning-checkpoint", 41, 1000)
    outcomes = []
    try:
        mobility.open()
        body = mobility.start_trip("driver", anchor(mobility.net, "a", "e_BC", 240),
                                   anchor(mobility.net, "b", "e_CE", 100), travel_class)
        for _ in range(100):
            assert mobility.step() == []
            domain = mobility._conn.person if travel_class == "pedestrian" else mobility._conn.vehicle
            if domain.getLaneID(body).startswith(":"):
                break
        else:
            pytest.fail("Fixture body did not enter its turning junction")
        if resume:
            mobility = restart(mobility, run_dir / "checkpoint.xml")
            domain = mobility._conn.person if travel_class == "pedestrian" else mobility._conn.vehicle
            assert domain.getLaneID(body).startswith(":")
        while mobility.t < mobility.horizon_s:
            outcomes.extend(mobility.step())
        assert len(outcomes) == 1 and outcomes[0].status == "arrived"
        return recording(mobility), [asdict(outcome) for outcome in outcomes]
    finally:
        mobility.close()


@pytest.mark.parametrize("travel_class", ["pedestrian", "bicycle", "delivery", "truck"])
def test_checkpoint_during_real_junction_turn(tmp_path, geo_net_path, travel_class):
    expected = turning_checkpoint_run(geo_net_path, tmp_path / "uninterrupted", False, travel_class)
    actual = turning_checkpoint_run(geo_net_path, tmp_path / "restarted", True, travel_class)
    assert_same_recordings(actual, expected)


def test_checkpoint_preserves_teleport_failures_and_accounting(tmp_path, geo_net_path):
    with PopulationMobility(geo_net_path, tmp_path, "teleport-checkpoint", 7, 700) as mobility:
        origin, destination = anchor(mobility.net, "a"), anchor(mobility.net, "b", "e_CD")
        blocker = mobility.start_trip("blocker", origin, destination, "passenger")
        mobility._conn.vehicle.setStop(blocker, "e_AB", pos=150, laneIndex=1, duration=1000.0)
        follower = mobility.start_trip("follower", origin, destination, "passenger")
        for _ in range(650):
            outcomes = mobility.step()
            if outcomes:
                break
        assert len(outcomes) == 1 and outcomes[0].entity_id == follower and outcomes[0].status == "failed"
        assert mobility.teleports == 1
        with restart(mobility, tmp_path / "checkpoint.xml") as restored:
            assert restored.teleports == 1 and set(restored._active) == {blocker}
            while restored.t < restored.horizon_s:
                restored.step()
            assert restored.teleports == 1
            assert not any(event.person_id == "follower" and event.event == "arrive" for event in restored.events)


def test_checkpoint_multiple_restarts_keep_existing_outputs_and_identity(tmp_path, geo_net_path):
    run_dir = tmp_path / "run"
    mobility = PopulationMobility(geo_net_path, run_dir, "multiple-checkpoints", 7, 300)
    old_files = {}
    try:
        mobility.open()
        body = mobility.start_trip("resident", anchor(mobility.net, "a"),
                                   anchor(mobility.net, "b", position_m=160), "pedestrian")
        for index in range(3):
            for _ in range(4):
                assert mobility.step() == []
            mobility = restart(mobility, run_dir / f"checkpoint-{index}.xml")
            assert mobility.output_dir != run_dir
            assert set(mobility._active) == {body}
            old_files.update({path: path.read_bytes() for path in run_dir.iterdir() if path.is_file()})
        assert complete(mobility).status == "arrived"
        assert [event.event for event in mobility.events] == ["depart", "arrive"]
        assert len(mobility.tracks) == 1 and mobility._sequence == 1
    finally:
        mobility.close()
    assert all(path.read_bytes() == content for path, content in old_files.items())
    assert len(list((run_dir / "mobility-continuations").iterdir())) == 3


def crowd_checkpoint_run(net_file, run_dir, resume):
    mobility = PopulationMobility(net_file, run_dir, "crowd-checkpoint", 47, 300)
    outcomes = []
    try:
        mobility.open()
        for index in range(5):
            mobility.start_trip(f"walker-{index}", anchor(mobility.net, "a", position_m=80 + index),
                                anchor(mobility.net, "b", position_m=240), "pedestrian")
        while mobility.t < 23:
            outcomes.extend(mobility.step())
        if resume:
            mobility = restart(mobility, run_dir / "checkpoint.xml")
        while mobility.t < mobility.horizon_s:
            outcomes.extend(mobility.step())
        assert len(outcomes) == 5 and all(outcome.status == "arrived" for outcome in outcomes)
        return recording(mobility), [asdict(outcome) for outcome in outcomes]
    finally:
        mobility.close()


def test_checkpoint_preserves_interacting_pedestrian_crowd(tmp_path, geo_net_path):
    expected = crowd_checkpoint_run(geo_net_path, tmp_path / "uninterrupted", False)
    actual = crowd_checkpoint_run(geo_net_path, tmp_path / "restarted", True)
    assert_same_recordings(actual, expected)


def test_checkpoint_gzip_round_trip_and_detached_metadata(tmp_path, geo_net_path):
    state_file = tmp_path / "state.xml.gz"
    with PopulationMobility(geo_net_path, tmp_path, "gzip-checkpoint", 7, 100) as mobility:
        mobility.start_trip("resident", anchor(mobility.net, "a"), anchor(mobility.net, "b", position_m=200), "pedestrian")
        for _ in range(8):
            mobility.step()
        metadata = mobility.save_checkpoint(state_file)
        frozen = json.dumps(metadata, sort_keys=True, allow_nan=False)
        expected_outcomes = []
        while mobility.t < mobility.horizon_s:
            expected_outcomes.extend(mobility.step())
        expected = recording(mobility), [asdict(outcome) for outcome in expected_outcomes]
        assert json.dumps(metadata, sort_keys=True, allow_nan=False) == frozen
    with PopulationMobility(geo_net_path, tmp_path, "gzip-checkpoint", 7, 100) as restored:
        restored.restore_checkpoint(state_file, metadata)
        actual_outcomes = []
        while restored.t < restored.horizon_s:
            actual_outcomes.extend(restored.step())
        actual = recording(restored), [asdict(outcome) for outcome in actual_outcomes]
        assert_same_recordings(actual, expected)


@pytest.fixture
def saved_mobility(tmp_path, geo_net_path):
    with PopulationMobility(geo_net_path, tmp_path / "original", "checkpoint-validation", 7, 100) as mobility:
        body = mobility.start_trip("resident", anchor(mobility.net, "a"), anchor(mobility.net, "b", "e_CD"), "pedestrian")
        mobility.step()
        state_file = tmp_path / "state.xml"
        metadata = mobility.save_checkpoint(state_file)
    return state_file, metadata, body


@pytest.mark.parametrize("field,value", [
    ("t", 2), ("seed", 9), ("horizon_s", 101), ("run_id", "other-run"),
    ("network_sha256", "0" * 64), ("sequence", 0), ("teleports", -1),
])
def test_checkpoint_rejects_inconsistent_metadata_before_loading(tmp_path, geo_net_path, saved_mobility, field, value):
    state_file, metadata, _ = saved_mobility
    invalid = copy.deepcopy(metadata)
    invalid[field] = value
    with PopulationMobility(geo_net_path, tmp_path / "resumed", "checkpoint-validation", 7, 100) as mobility:
        with pytest.raises(ValueError):
            mobility.restore_checkpoint(state_file, invalid)
        assert mobility.t == 0 and mobility._conn.simulation.getTime() == 0
        assert not mobility.tracks and not mobility.events
        mobility.restore_checkpoint(state_file, metadata)
        assert mobility.t == 1


@pytest.mark.parametrize("change", ["resident", "class", "map", "track", "missing"])
def test_checkpoint_rejects_inconsistent_body_ownership(tmp_path, geo_net_path, saved_mobility, change):
    state_file, metadata, body = saved_mobility
    invalid = copy.deepcopy(metadata)
    if change == "resident":
        invalid["active"][body]["resident_id"] = "another-resident"
    elif change == "class":
        invalid["active"][body]["travel_class"] = "truck"
    elif change == "map":
        invalid["residents"] = {}
    elif change == "track":
        invalid["tracks"][body]["resident_id"] = "another-resident"
    else:
        invalid["active"] = {}
        invalid["residents"] = {}
    with PopulationMobility(geo_net_path, tmp_path / "resumed", "checkpoint-validation", 7, 100) as mobility:
        with pytest.raises(ValueError):
            mobility.restore_checkpoint(state_file, invalid)
        assert mobility.t == 0 and mobility._conn.simulation.getTime() == 0


def test_checkpoint_rejects_different_network_digest(tmp_path, geo_net_path, saved_mobility):
    state_file, metadata, _ = saved_mobility
    tree = ET.parse(geo_net_path)
    tree.find("edge[@id='e_AB']/lane[@index='1']").set("speed", "12.00")
    changed = tmp_path / "different.net.xml"
    tree.write(changed)
    with (
        PopulationMobility(changed, tmp_path / "resumed", "checkpoint-validation", 7, 100) as mobility,
        pytest.raises(ValueError, match="network"),
    ):
        mobility.restore_checkpoint(state_file, metadata)


@pytest.mark.parametrize("change", ["digest", "time", "rng", "native-class", "arrival-position"])
def test_checkpoint_rejects_invalid_native_state_before_loading(tmp_path, geo_net_path, saved_mobility, change):
    state_file, metadata, _ = saved_mobility
    invalid = copy.deepcopy(metadata)
    tree = ET.parse(state_file)
    root = tree.getroot()
    if change in {"digest", "time"}:
        root.set("time", "2.000")
    elif change == "rng":
        root.remove(root.find("rngState"))
    elif change == "native-class":
        root.find(".//person").set("type", "truck")
    else:
        root.find(".//person/walk").set("arrivalPos", "79")
    changed_file = tmp_path / "changed-state.xml"
    tree.write(changed_file)
    if change != "digest":
        invalid["state_sha256"] = hashlib.sha256(changed_file.read_bytes()).hexdigest()
    with PopulationMobility(geo_net_path, tmp_path / "resumed", "checkpoint-validation", 7, 100) as mobility:
        with pytest.raises(ValueError):
            mobility.restore_checkpoint(changed_file, invalid)
        assert mobility.t == 0 and mobility._conn.simulation.getTime() == 0


@pytest.mark.parametrize("state", ["advanced", "active", "restored"])
def test_checkpoint_restore_requires_pristine_open_adapter(tmp_path, geo_net_path, saved_mobility, state):
    state_file, metadata, _ = saved_mobility
    with PopulationMobility(geo_net_path, tmp_path / "resumed", "checkpoint-validation", 7, 100) as mobility:
        if state == "advanced":
            mobility.step()
        elif state == "active":
            mobility.start_trip("new", anchor(mobility.net, "a"), anchor(mobility.net, "b"), "bicycle")
        else:
            mobility.restore_checkpoint(state_file, metadata)
        before = recording(mobility)
        with pytest.raises(ValueError, match="pristine|fresh"):
            mobility.restore_checkpoint(state_file, metadata)
        assert recording(mobility) == before


def test_checkpoint_verifies_restored_sumo_time_and_fails_closed(tmp_path, geo_net_path, saved_mobility, monkeypatch):
    state_file, metadata, _ = saved_mobility
    with PopulationMobility(geo_net_path, tmp_path / "resumed", "checkpoint-validation", 7, 100) as mobility:
        native_load = mobility._conn.simulation.loadState

        def wrong_time(path):
            native_load(path)
            mobility._conn.simulationStep()

        monkeypatch.setattr(mobility._conn.simulation, "loadState", wrong_time)
        with pytest.raises(ValueError, match="time"):
            mobility.restore_checkpoint(state_file, metadata)
        assert mobility._conn is None


def test_checkpoint_operations_require_owner_thread_and_preserve_existing_state(tmp_path, geo_net_path):
    mobility = PopulationMobility(geo_net_path, tmp_path, "owner", 7, 20)
    state_file = tmp_path / "state.xml"
    with pytest.raises(RuntimeError, match="open|closed"):
        mobility.save_checkpoint(state_file)
    with mobility, ThreadPoolExecutor(max_workers=1) as executor:
        with pytest.raises(RuntimeError, match="owner"):
            executor.submit(mobility.save_checkpoint, state_file).result()
        metadata = mobility.save_checkpoint(state_file)
        content = state_file.read_bytes()
        with pytest.raises(FileExistsError):
            mobility.save_checkpoint(state_file)
        assert state_file.read_bytes() == content
        with pytest.raises(RuntimeError, match="owner"):
            executor.submit(mobility.restore_checkpoint, state_file, metadata).result()
        mobility.restore_checkpoint(state_file, metadata)
        assert mobility.t == 0
