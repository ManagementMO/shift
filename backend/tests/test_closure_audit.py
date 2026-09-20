from pathlib import Path

from cityshift.contracts import ConstraintSet, Restriction, ScenarioSpec
from cityshift.domain.runs import closure_violations


def _scenario() -> ScenarioSpec:
    return ScenarioSpec(
        scenario_id="s",
        pack_id="p",
        demand_id="d",
        restrictions=[Restriction(restriction_id="r", edge_ids=["B"], start_s=100, end_s=200)],
        constraints=ConstraintSet(fleet=[], horizon_s=1000, service_window_s=(0, 1000), allowed_stop_ids=[]),
    )


def _write(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "vehroutes.xml"
    p.write_text(f'<?xml version="1.0"?>\n<routes>\n{body}\n</routes>\n')
    return p


def test_exit_times_clear_a_vehicle_that_left_the_edge_before_closure(tmp_path):
    # A -> B -> C; leaves B at t=90, closure starts at 100: not a violation even though the trip overlaps the window.
    body = '<vehicle id="early" depart="0.00" arrival="500.00"><route edges="A B C" exitTimes="50.00 90.00 500.00"/></vehicle>'
    assert closure_violations(_write(tmp_path, body), _scenario()) == {}


def test_exit_times_flag_a_vehicle_that_entered_the_edge_while_closed(tmp_path):
    body = '<vehicle id="late" depart="0.00" arrival="500.00"><route edges="A B C" exitTimes="120.00 150.00 500.00"/></vehicle>'
    assert closure_violations(_write(tmp_path, body), _scenario()) == {"late": "entered"}


def test_vehicle_already_on_the_edge_at_closure_is_caught_not_a_violation(tmp_path):
    body = '<vehicle id="inside" depart="0.00" arrival="500.00"><route edges="A B C" exitTimes="50.00 150.00 500.00"/></vehicle>'
    assert closure_violations(_write(tmp_path, body), _scenario()) == {"inside": "caught"}


def test_without_exit_times_the_audit_stays_conservative(tmp_path):
    body = '<vehicle id="v" depart="0.00" arrival="500.00"><route edges="A B C"/></vehicle>'
    assert closure_violations(_write(tmp_path, body), _scenario()) == {"v": "entered"}


def test_route_distribution_uses_the_driven_route(tmp_path):
    body = (
        '<vehicle id="rr" depart="0.00" arrival="500.00"><routeDistribution>'
        '<route replacedOnEdge="A" replacedAtTime="20.00" edges="A B C"/>'
        '<route edges="A D C" exitTimes="50.00 150.00 500.00"/>'
        "</routeDistribution></vehicle>"
    )
    assert closure_violations(_write(tmp_path, body), _scenario()) == {}


def test_audit_respects_vehicle_modes(tmp_path):
    scenario = _scenario()
    scenario.restrictions[0].modes = ["bus"]
    body = (
        '<vehicle id="car" type="car" depart="0" arrival="500"><route edges="A B C" exitTimes="120 150 500"/></vehicle>'
        '<vehicle id="bus" type="shuttle_bus" depart="0" arrival="500"><route edges="A B C" exitTimes="120 150 500"/></vehicle>'
    )
    assert closure_violations(_write(tmp_path, body), scenario) == {"bus": "entered"}


def test_closure_window_is_start_inclusive_end_exclusive(tmp_path):
    body = (
        '<vehicle id="start" depart="0" arrival="500"><route edges="A B C" exitTimes="100 150 500"/></vehicle>'
        '<vehicle id="end" depart="0" arrival="500"><route edges="A B C" exitTimes="200 250 500"/></vehicle>'
        '<vehicle id="left" depart="0" arrival="500"><route edges="A B C" exitTimes="50 100 500"/></vehicle>'
    )
    assert closure_violations(_write(tmp_path, body), _scenario()) == {"start": "entered"}


def test_unfinished_route_audits_current_edge_but_not_unvisited_edges(tmp_path):
    body = (
        '<vehicle id="inside" depart="0" arrival="-1"><route edges="A B C" exitTimes="120 -1 -1"/></vehicle>'
        '<vehicle id="upstream" depart="0" arrival="-1"><route edges="A B C" exitTimes="-1 -1 -1"/></vehicle>'
    )
    assert closure_violations(_write(tmp_path, body), _scenario()) == {"inside": "entered"}


def test_integrity_violation_cannot_also_report_all_clear(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from cityshift.contracts import SimulationRun, ValidationReport
    from cityshift.domain import runs
    from cityshift.domain.compiler import CompileResult, baseline_plan
    from cityshift.transport.runner import RunRecord

    scenario = _scenario()
    record = RunRecord(tracks={}, events=[], occupancy={}, stop_queue={}, teleports=0, end_time=1000)
    compiled = CompileResult(True, tmp_path / "cfg", [], {}, {}, {}, {}, [], [], {})
    monkeypatch.setattr(runs, "RUN_ROOT", tmp_path)
    monkeypatch.setattr(runs, "validate_plan", lambda *args: ValidationReport(plan_id="baseline", valid=True))
    monkeypatch.setattr(runs, "compile_scenario", lambda *args: compiled)
    monkeypatch.setattr(runs, "runner_for", lambda *args: SimpleNamespace(run=lambda *args, **kwargs: record))
    monkeypatch.setattr(runs, "closure_violations", lambda *args: {"illegal": "entered"})
    pack = SimpleNamespace(pack_id="p", network_fingerprint="n")
    demand = SimpleNamespace(demand_id="d")
    run = SimulationRun(run_id="audit", scenario_id=scenario.scenario_id, plan_id="baseline", seed=1)
    result = runs.execute_run(run, pack, scenario, demand, baseline_plan(), persist=lambda _: None)
    assert result.metrics is not None
    assert any("RESTRICTION INTEGRITY" in w for w in result.warnings)
    assert not any("no vehicle route" in w for w in result.warnings)
