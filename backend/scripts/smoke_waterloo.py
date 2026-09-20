"""Compile + validate + run baseline and heuristic plans on the Waterloo pack.  Prints metrics."""

from __future__ import annotations

import sys
import time

from cityshift.contracts import RunStatus, SimulationRun
from cityshift.domain.compiler import baseline_plan, heuristic_plans
from cityshift.domain.network import load_pack
from cityshift.domain.runs import execute_run, run_id_for
from cityshift.domain.scenarios import flagship_scenario
from cityshift.domain.validators import validate_plan


def main() -> None:
    pack = load_pack("waterloo")
    spec, demand = flagship_scenario(pack, cohort_size=int(sys.argv[1]) if len(sys.argv) > 1 else 120)
    plans = [baseline_plan(), *heuristic_plans(pack, spec, demand)]
    for plan in plans:
        rep = validate_plan(pack, spec, plan, demand)
        print(f"\n== {plan.plan_id} valid={rep.valid} duties={len(plan.duties)}")
        for i in rep.issues:
            print(f"   [{i.severity}] {i.code}: {i.message}")
        if not rep.valid:
            continue
        run = SimulationRun(run_id=run_id_for(spec, plan, 1, demand), scenario_id=spec.scenario_id, plan_id=plan.plan_id, seed=1)
        t0 = time.time()
        execute_run(run, pack, spec, demand, plan, persist=lambda r: None)
        print(f"   status={run.status} in {time.time()-t0:.1f}s dir={run.run_dir}")
        if run.status == RunStatus.completed and run.metrics:
            m = run.metrics
            print(f"   completed {m.completed}/{m.cohort_size} waiting={m.unfinished_waiting} riding={m.unfinished_riding} walking={m.unfinished_walking} "
                  f"not_departed={m.unfinished_not_departed} unroutable={m.unroutable} boardings={m.boardings} max_occ={m.max_occupancy} "
                  f"wait_pm={m.waiting_person_minutes} median={m.completed_duration_median_s} p95={m.completed_duration_p95_s} teleports={m.teleports}")
            for w in m.warnings:
                print("   !", w)
        else:
            print("   error:", run.error)


if __name__ == "__main__":
    main()
