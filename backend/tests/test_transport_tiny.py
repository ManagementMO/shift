"""Phase B: prove transport semantics on the smallest fixture."""

from __future__ import annotations

from pathlib import Path

import pytest

from cityshift.transport.runner import SumoRunner, compute_metrics
from cityshift.transport.sumo_xml import BusTrip, PersonTrip, write_additional, write_routes, write_sumocfg
from cityshift.transport.tiny_fixture import STOPS, build_tiny_network

FIX = Path(__file__).parent / "_out"


@pytest.fixture(scope="module")
def net() -> Path:
    return build_tiny_network(FIX / "tiny")


def _scenario(tmp: Path, net: Path, buses, persons, cars=(), horizon=900, seed=1, cap=60):
    add = tmp / "add.xml"
    rou = tmp / "rou.xml"
    cfg = tmp / "run.sumocfg"
    write_additional(add, STOPS)
    write_routes(rou, buses, persons, list(cars), bus_capacity=cap)
    write_sumocfg(cfg, net, rou, [add], horizon, seed, tmp / "tripinfo.xml")
    return cfg


def test_one_passenger_one_bus_boards_rides_alights_completes(tmp_path, net):
    # walking 255 m at 1.4 m/s takes ~180 s, so a bus that leaves at t=60 would miss the traveler.
    bus = BusTrip("bus_1", ["e_AB", "e_BC", "e_CD"], [("S1", 60), ("S2", 20)], depart_s=180, line="L1")
    p = PersonTrip("p_1", "e_AB", "S1", "S2", "e_CD", depart_s=0, lines="L1")
    cfg = _scenario(tmp_path, net, [bus], [p])
    r = SumoRunner(net)
    rec = r.run(cfg, 900, ["p_1"], {"p_1": 0}, ["bus_1"], [s.stop_id for s in STOPS], label="t1")
    kinds = [e.event for e in rec.events if e.person_id == "p_1"]
    assert "board" in kinds and "alight" in kinds and "arrive" in kinds, kinds
    assert kinds.index("board") < kinds.index("alight") < kinds.index("arrive")
    board = next(e for e in rec.events if e.event == "board")
    assert board.vehicle_id == "bus_1"
    assert board.stop_id == "S1"
    m = compute_metrics(rec, 900, ["bus_1"])
    assert m.completed == 1 and m.cohort_size == 1
    assert m.boardings == 1
    assert m.max_occupancy["bus_1"] == 1
    assert m.extra_fleet_ids == ["bus_1"]
    # trajectory truth: bus track has samples and heading roughly east (SUMO angle 90 = east)
    bt = rec.tracks["bus_1"]
    assert len(bt.samples) > 20
    moving = [s for s in bt.samples if s[4] > 3]
    assert moving and abs(moving[len(moving) // 2][3] - 90) < 10


def test_capacity_overflow_leaves_people_waiting_and_accounted(tmp_path, net):
    bus = BusTrip("bus_1", ["e_AB", "e_BC", "e_CD"], [("S1", 60), ("S2", 20)], depart_s=180, line="L1")
    persons = [PersonTrip(f"p_{i}", "e_AB", "S1", "S2", "e_CD", depart_s=0, lines="L1") for i in range(6)]
    cfg = _scenario(tmp_path, net, [bus], persons, cap=3)
    r = SumoRunner(net)
    ids = [p.person_id for p in persons]
    rec = r.run(cfg, 600, ids, {i: 0 for i in ids}, ["bus_1"], [s.stop_id for s in STOPS], label="t2")
    m = compute_metrics(rec, 600, ["bus_1"])
    assert m.boardings == 3
    assert m.max_occupancy["bus_1"] <= 3
    assert m.completed == 3
    assert m.unfinished_waiting == 3
    assert m.completed + m.unfinished_waiting + m.unfinished_riding + m.unfinished_walking + m.unfinished_not_departed + m.unroutable == 6
    assert m.waiting_person_minutes > 0


def test_persistent_bus_makes_return_cycle(tmp_path, net):
    # One physical bus does two service cycles: out, back, out.  Same vehicle ID throughout.
    route = ["e_AB", "e_BC", "e_CD", "e_DC", "e_CB", "e_BA", "e_AB", "e_BC", "e_CD"]
    # second call at S1 is scheduled (until=600) so the bus holds for the second wave
    bus = BusTrip("bus_1", route, [("S1", 60), ("S2", 20), ("S1r", 5), ("S1", 30, 600), ("S2", 20)], depart_s=180, line="L1")
    early = [PersonTrip(f"a_{i}", "e_AB", "S1", "S2", "e_CD", depart_s=0, lines="L1") for i in range(3)]
    late = [PersonTrip(f"b_{i}", "e_AB", "S1", "S2", "e_CD", depart_s=300, lines="L1") for i in range(3)]
    cfg = _scenario(tmp_path, net, [bus], early + late, horizon=1500, cap=3)
    r = SumoRunner(net)
    ids = [p.person_id for p in early + late]
    rec = r.run(cfg, 1500, ids, {p.person_id: p.depart_s for p in early + late}, ["bus_1"], [s.stop_id for s in STOPS], label="t3")
    m = compute_metrics(rec, 1500, ["bus_1"])
    assert m.extra_fleet_ids == ["bus_1"], "exactly one persistent vehicle id"
    assert m.completed == 6, m
    boards = [e for e in rec.events if e.event == "board"]
    assert len(boards) == 6
    assert len({e.t for e in boards}) >= 2, "boardings occur on two distinct cycles"


def test_missing_route_person_is_not_silently_dropped(tmp_path, net):
    # Person wants to ride a line that never comes: must remain accounted as waiting, not vanish.
    bus = BusTrip("bus_1", ["e_AB", "e_BC", "e_CD"], [("S1", 60), ("S2", 20)], depart_s=180, line="L1")
    p = PersonTrip("p_1", "e_AB", "S1", "S2", "e_CD", depart_s=0, lines="L9")
    cfg = _scenario(tmp_path, net, [bus], [p], horizon=400)
    rec = SumoRunner(net).run(cfg, 400, ["p_1"], {"p_1": 0}, ["bus_1"], [s.stop_id for s in STOPS], label="t4")
    m = compute_metrics(rec, 400, ["bus_1"])
    assert m.completed == 0
    assert m.unfinished_waiting == 1
    assert m.boardings == 0
