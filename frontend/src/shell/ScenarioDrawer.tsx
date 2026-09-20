import { useStore } from '../store'
import type { SimulationRun } from '../types'
import { fmt } from '../util'
import PopulationRunControl from './PopulationRunControl'
import PopulationRunActions from './PopulationRunActions'
import { populationReplayReady } from '../populationLifecycle'

function StatusPill({ run }: { run: SimulationRun }) {
  const cls = run.status === 'paused' ? '' : run.status === 'completed' ? 'ok' : run.status === 'running' || run.status === 'queued' ? 'busy' : 'bad'
  return (
    <span className={`pill ${cls}`}>
      {run.status}
      {run.status === 'running' ? ` ${Math.round(run.progress * 100)}%` : ''}
    </span>
  )
}

/** Scenario lineage + plans + runs. Opens from the scenario name in the top strip. */
export default function ScenarioDrawer({ onClose }: { onClose: () => void }) {
  const scenarios = useStore((s) => s.scenarios)
  const scenarioId = useStore((s) => s.scenarioId)
  const scenario = scenarios.find((x) => x.scenario_id === scenarioId) ?? null
  const pack = useStore((s) => s.pack)
  const packs = useStore((s) => s.packs)
  const selectPack = useStore((s) => s.selectPack)
  const plans = useStore((s) => s.plans)
  const runs = useStore((s) => s.runs)
  const primaryRunId = useStore((s) => s.primaryRunId)
  const compareRunId = useStore((s) => s.compareRunId)
  const loadingReplay = useStore((s) => s.loadingReplay)
  const selectScenario = useStore((s) => s.selectScenario)
  const submitRun = useStore((s) => s.submitRun)
  const cancelRun = useStore((s) => s.cancelRun)
  const openRun = useStore((s) => s.openRun)
  const refreshRuns = useStore((s) => s.refreshRuns)
  const setCompareMode = useStore((s) => s.setCompareMode)
  const select = useStore((s) => s.select)

  const samePack = scenarios.filter((s) => s.pack_id === (pack?.pack_id ?? s.pack_id))
  const runsFor = (pid: string) => runs.filter((r) => r.plan_id === pid)

  return (
    <aside className="drawer scenario-drawer">
      <div className="drawer-head">
        <b>Scenarios</b>
        <button className="iconbtn small" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {packs.length > 1 && (
        <div className="seg">
          {packs.map((p) => (
            <button key={p.pack_id} className={p.pack_id === pack?.pack_id ? 'on' : ''} onClick={() => void selectPack(p.pack_id)}>
              {p.name.split(',')[0]}
            </button>
          ))}
        </div>
      )}
      <div className="list">
        {samePack.length === 0 && <div className="dim small">No scenarios for this city yet.</div>}
        {samePack.map((s) => (
          <button key={s.scenario_id} className={`listitem ${s.scenario_id === scenarioId ? 'on' : ''}`} onClick={() => void selectScenario(s.scenario_id)}>
            <span>{s.parent_scenario_id ? `↳ branch · ${s.change_set[s.change_set.length - 1] ?? s.scenario_id}` : s.label.split(' during ')[0].replace(/\s*\(.*\)\)?\s*$/, '')}</span>
            <span className="dim">{s.scenario_kind ?? 'transport'} · {s.scenario_id}</span>
          </button>
        ))}
      </div>
      {scenario && scenario.scenario_kind !== 'population' && (
        <div className="small">
          <div className="dim">
            fleet {scenario.constraints.fleet.map((f) => `${f.vehicle_id} (${f.capacity})`).join(', ')} · window +{fmt(scenario.constraints.service_window_s[0])}–+
            {fmt(scenario.constraints.service_window_s[1])} · horizon +{fmt(scenario.constraints.horizon_s)}
          </div>
          {scenario.restrictions.map((r) => (
            <button key={r.restriction_id} className="linkish" onClick={() => select({ kind: 'restriction', id: r.restriction_id })}>
              ⛔ {r.label} — {r.edge_ids.length} segments, +{fmt(r.start_s)}–+{fmt(r.end_s)}
            </button>
          ))}
          {scenario.hazards.map((h) => (
            <div key={h.track_id} className="warn">
              🌪 {h.label} — r {h.radius_m} m, +{fmt(h.start_s)}–+{fmt(h.end_s)}
            </div>
          ))}
        </div>
      )}

      {scenario?.scenario_kind === 'population' ? <>
        <div className="drawer-head"><b>Resident society</b></div>
        <PopulationRunControl />
        <div className="drawer-head"><b>Population runs</b><button className="ghostbtn" onClick={() => void refreshRuns()}>Refresh status</button></div>
        <div className="small dim">Execution pause waits for a verified paired checkpoint. Playback pause only stops the viewer; Stop does not request a checkpoint.</div>
        {runs.length === 0 && <div className="small dim">No execution yet. Building a definition does not start model calls.</div>}
        {runs.map((r) => <div className="plan" key={r.run_id}>
          <div className="row between"><span className="mono">{r.run_id}</span><StatusPill run={r} /></div>
          <div className="small dim">{r.engine_version || 'engine not started'} · seed {r.seed}</div>
          <div className="row wrap">
            {populationReplayReady(r) && <button className={`ghostbtn ${primaryRunId === r.run_id ? 'on' : ''}`} disabled={loadingReplay === r.run_id} onClick={() => void openRun(r.run_id, 'primary', true)}>{loadingReplay === r.run_id ? 'Loading…' : r.status === 'paused' ? 'View paused records' : 'View recorded artifacts'}</button>}
          </div>
          <PopulationRunActions run={r} />
          {r.error && <div className="bad small">{r.error}</div>}
          {r.warnings.map((warning, i) => <div className="warn small" key={i}>{warning}</div>)}
        </div>)}
      </> : <>
      <div className="drawer-head">
        <b>Plans</b>
      </div>
      {plans.map(({ plan, validation }) => (
        <div key={plan.plan_id} className={`plan ${validation && !validation.valid ? 'invalid' : ''}`}>
          <div className="row between">
            <b>{plan.name}</b>
            <span className={`pill ${validation?.valid ? 'ok' : 'bad'}`}>{validation ? (validation.valid ? 'valid' : 'rejected') : '?'}</span>
          </div>
          <div className="dim small">
            {plan.family} · {plan.duties.length} duties · by {plan.authored_by}
          </div>
          {plan.rationale && <div className="small">{plan.rationale}</div>}
          {validation?.issues.map((i, k) => (
            <div key={k} className={`small ${i.severity === 'hard' ? 'bad' : 'dim'}`}>
              {i.message}
            </div>
          ))}
          <div className="row wrap">
            <button className="ghostbtn" disabled={!validation?.valid} onClick={() => void submitRun(plan.plan_id)}>
              Run in SUMO
            </button>
            {runsFor(plan.plan_id).map((r) => (
              <span key={r.run_id} className="runrow">
                <StatusPill run={r} />
                {r.status === 'completed' && (
                  <>
                    <button className={`ghostbtn ${primaryRunId === r.run_id ? 'on' : ''}`} onClick={() => void openRun(r.run_id, 'primary')}>
                      {loadingReplay === r.run_id ? '…' : 'View'}
                    </button>
                    <button
                      className={`ghostbtn ${compareRunId === r.run_id ? 'on' : ''}`}
                      onClick={() => {
                        void openRun(r.run_id, 'compare')
                        setCompareMode(true)
                      }}
                    >
                      Compare
                    </button>
                  </>
                )}
                {(r.status === 'running' || r.status === 'queued') && (
                  <button className="ghostbtn" onClick={() => void cancelRun(r.run_id)}>
                    Cancel
                  </button>
                )}
                {r.error && <span className="bad small">{r.error}</span>}
              </span>
            ))}
          </div>
        </div>
      ))}
      </>}
    </aside>
  )
}
