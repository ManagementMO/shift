"""Run orchestration: compile -> validate -> SUMO -> persist artifacts.  Runs are immutable once completed."""

from __future__ import annotations

import json
import threading
import traceback
from collections.abc import Callable
from pathlib import Path

from cityshift.contracts import (
    CityPack,
    DemandSet,
    RunStatus,
    ScenarioSpec,
    ServicePlan,
    SimulationRun,
    content_hash,
    utcnow,
)
from cityshift.domain.compiler import compile_scenario
from cityshift.domain.validators import validate_plan
from cityshift.transport.runner import SumoRunner, compute_metrics, parse_tripinfo, save_record
from cityshift.transport.sumo_env import sumo_version

RUN_ROOT = Path(__file__).resolve().parents[3] / "var" / "runs"


def closure_violations(vehroutes: Path, scenario: ScenarioSpec) -> dict[str, str]:
    """Audit SUMO's own vehroute output against the scenario's closures.

    Returns vehicle id -> "entered" (entered a closed edge while it was closed; with SUMO this is a teleport jumping
    along its route) or "caught" (was already on the edge when it closed).

    With `vehroute-output.exit-times` each edge has an occupancy interval [previous exit, own exit]; without it the
    audit falls back to the conservative trip-level overlap (route touches a closed edge and the trip spans the window).
    """
    if not vehroutes.exists() or not scenario.restrictions:
        return {}
    import xml.etree.ElementTree as ET

    closed: dict[str, list[tuple[int, int]]] = {}
    for r in scenario.restrictions:
        for eid in r.edge_ids:
            closed.setdefault(eid, []).append((r.start_s, r.end_s))

    bad: dict[str, str] = {}
    for veh in ET.parse(vehroutes).getroot().iter("vehicle"):
        depart = float(veh.get("depart", "0"))
        arrival = float(veh.get("arrival") or scenario.constraints.horizon_s)
        route_el = veh.find("route")
        if route_el is None:
            route_el = veh.find("routeDistribution/route[last()]")
        if route_el is None:
            continue
        edges = (route_el.get("edges") or "").split()
        exits = [float(x) for x in (route_el.get("exitTimes") or "").split()]
        windows: list[tuple[str, float, float]] = []
        if len(exits) == len(edges):
            prev = depart
            for eid, ex in zip(edges, exits, strict=True):
                windows.append((eid, prev, ex))
                prev = ex
        else:
            windows = [(eid, depart, arrival) for eid in edges]
        vid = veh.get("id", "?")
        precise = len(exits) == len(edges)
        for eid, a, b in windows:
            for start, end in closed.get(eid, ()):
                if not (a < end and b > start):
                    continue
                if a >= start or not precise:
                    bad[vid] = "entered"
                else:
                    bad.setdefault(vid, "caught")
    return bad

_runners: dict[str, SumoRunner] = {}
_lock = threading.Lock()


def runner_for(pack: CityPack) -> SumoRunner:
    with _lock:
        if pack.pack_id not in _runners:
            _runners[pack.pack_id] = SumoRunner(Path(pack.net_file))
        return _runners[pack.pack_id]


def run_id_for(scenario: ScenarioSpec, plan: ServicePlan, seed: int) -> str:
    """Deterministic: same scenario + plan + seed => same run id (duplicate submissions are idempotent)."""
    return "run-" + content_hash({"s": scenario.model_dump(mode="json"), "p": plan.model_dump(mode="json"), "seed": seed})[:12]


def execute_run(
    run: SimulationRun,
    pack: CityPack,
    scenario: ScenarioSpec,
    demand: DemandSet,
    plan: ServicePlan,
    persist: Callable[[SimulationRun], None],
    cancel: Callable[[], bool] | None = None,
) -> SimulationRun:
    run_dir = RUN_ROOT / run.run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    run.run_dir = str(run_dir)
    run.engine_version = sumo_version()
    report = validate_plan(pack, scenario, plan, demand)
    (run_dir / "validation.json").write_text(report.model_dump_json(indent=1))
    if not report.valid:
        run.status = RunStatus.invalid
        run.error = "; ".join(i.message for i in report.issues if i.severity == "hard")
        persist(run)
        return run
    run.status = RunStatus.running
    run.started_at = utcnow()
    persist(run)
    try:
        comp = compile_scenario(pack, scenario, demand, plan, run_dir, run.seed)
        (run_dir / "compile.json").write_text(json.dumps({
            "ok": comp.ok, "errors": comp.errors, "notes": comp.notes, "mode_assignment": comp.mode_assignment,
            "unroutable": comp.unroutable, "line_schedule": comp.line_schedule,
            "duties": [{"duty_id": s.duty.duty_id, "vehicle_id": s.duty.vehicle_id, "line": s.line, "stop_sequence": s.duty.stop_sequence,
                        "depart_s": s.duty.depart_s, "est_arrivals_s": s.est_arrivals_s, "est_end_s": s.est_end_s,
                        "est_return_s": s.est_return_s, "edges": [e for seg in s.segments for e in seg]} for s in comp.duty_schedules],
        }, indent=1))
        if not comp.ok or comp.cfg is None:
            run.status = RunStatus.invalid
            run.error = "; ".join(comp.errors)
            persist(run)
            return run
        runner = runner_for(pack)

        def progress(p: float) -> None:
            run.progress = p
            persist(run)

        rec = runner.run(
            comp.cfg, scenario.constraints.horizon_s, comp.cohort_ids, comp.desired_depart,
            [f.vehicle_id for f in scenario.constraints.fleet], comp.stop_ids,
            on_progress=progress, cancel=cancel, label=run.run_id,
            line_schedule=comp.line_schedule, cohort_vehicles=comp.cohort_vehicles, unroutable=comp.unroutable,
        )
        metrics = compute_metrics(rec, scenario.constraints.horizon_s, [f.vehicle_id for f in scenario.constraints.fleet])
        metrics.warnings.extend(comp.notes)
        audit = closure_violations(run_dir / "vehroutes.xml", scenario)
        entered = sorted(v for v, how in audit.items() if how == "entered")
        caught = sorted(v for v, how in audit.items() if how == "caught")
        if entered:
            metrics.warnings.append(
                f"RESTRICTION INTEGRITY: {len(entered)} vehicle(s) crossed a closed edge while it was closed "
                f"(SUMO teleports jump along the route; their trails are broken, not drawn): {entered[:5]}"
            )
        if caught:
            metrics.warnings.append(f"{len(caught)} vehicle(s) were already on an edge when it closed and finished leaving it: {caught[:5]}")
        else:
            metrics.warnings.append("restriction integrity: no vehicle route used a closed edge during its closure (vehroute audit)")
        save_record(rec, metrics, run_dir)
        (run_dir / "tripinfo_summary.json").write_text(json.dumps({k: len(v) for k, v in parse_tripinfo(run_dir / "tripinfo.xml").items()}))
        run.metrics = metrics
        run.warnings = list(metrics.warnings)
        run.status = RunStatus.canceled if "canceled" in rec.warnings else RunStatus.completed
        run.progress = 1.0
        run.ended_at = utcnow()
        manifest = {
            "run_id": run.run_id, "scenario_id": scenario.scenario_id, "plan_id": plan.plan_id, "seed": run.seed,
            "pack": pack.pack_id, "network_fingerprint": pack.network_fingerprint, "engine": run.engine_version,
            "evidence_hash": scenario.evidence_hash, "demand_id": demand.demand_id,
        }
        run.manifest_hash = content_hash(manifest)
        (run_dir / "manifest.json").write_text(json.dumps(manifest | {"manifest_hash": run.manifest_hash}, indent=1))
    except Exception as exc:  # noqa: BLE001
        run.status = RunStatus.failed
        run.error = f"{type(exc).__name__}: {exc}"
        (run_dir / "error.txt").write_text(traceback.format_exc())
    persist(run)
    return run
