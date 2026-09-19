import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import type { Investigation, SimulationRun } from '../types'
import { fmt } from '../util'

function StatusPill({ run }: { run: SimulationRun }) {
  const cls = run.status === 'completed' ? 'ok' : run.status === 'running' || run.status === 'queued' ? 'busy' : 'bad'
  return (
    <span className={`pill ${cls}`}>
      {run.status}
      {run.status === 'running' ? ` ${Math.round(run.progress * 100)}%` : ''}
    </span>
  )
}

export default function ScenarioPanel() {
  const scenarios = useStore((s) => s.scenarios)
  const scenarioId = useStore((s) => s.scenarioId)
  const scenario = scenarios.find((x) => x.scenario_id === scenarioId) ?? null
  const plans = useStore((s) => s.plans)
  const runs = useStore((s) => s.runs)
  const primaryRunId = useStore((s) => s.primaryRunId)
  const compareRunId = useStore((s) => s.compareRunId)
  const loadingReplay = useStore((s) => s.loadingReplay)
  const selectScenario = useStore((s) => s.selectScenario)
  const createFlagship = useStore((s) => s.createFlagship)
  const submitRun = useStore((s) => s.submitRun)
  const cancelRun = useStore((s) => s.cancelRun)
  const openRun = useStore((s) => s.openRun)
  const refreshRuns = useStore((s) => s.refreshRuns)
  const investigation = useStore((s) => s.investigation)
  const setInvestigation = useStore((s) => s.setInvestigation)
  const setError = useStore((s) => s.setError)
  const health = useStore((s) => s.health)

  const [cohort, setCohort] = useState(120)
  const [seed, setSeed] = useState(7)
  const [problem, setProblem] = useState(
    'A concert at Waterloo Park ends at 22:30 while King St S through Uptown is closed. ~120 attendees need to get to UW, Laurier, Grand River Hospital, Columbia/Weber and Uptown.',
  )
  const [constraint, setConstraint] = useState('Two extra 60-seat buses for 35 minutes. No other resources.')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const anyActive = runs.some((r) => r.status === 'running' || r.status === 'queued')
    if (!anyActive) return
    const id = setInterval(() => void refreshRuns(), 1500)
    return () => clearInterval(id)
  }, [runs, refreshRuns])

  useEffect(() => {
    if (!investigation || investigation.status !== 'running') return
    const id = setInterval(async () => {
      try {
        const inv = await api.investigation(investigation.investigation_id)
        setInvestigation(inv)
        if (inv.status !== 'running' && scenarioId) {
          const p = await api.plans(scenarioId)
          useStore.setState({ plans: p })
        }
      } catch (e) {
        setError(String(e))
      }
    }, 2000)
    return () => clearInterval(id)
  }, [investigation, scenarioId, setInvestigation, setError])

  const runInvestigation = async () => {
    if (!scenarioId) return
    setBusy(true)
    try {
      const inv: Investigation = await api.investigate(scenarioId, problem, constraint)
      setInvestigation(inv)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const runsFor = (pid: string) => runs.filter((r) => r.plan_id === pid)

  return (
    <div className="panel left">
      <h2>Scenario</h2>
      <div className="field">
        <select value={scenarioId ?? ''} onChange={(e) => void selectScenario(e.target.value)}>
          {scenarios.map((s) => (
            <option key={s.scenario_id} value={s.scenario_id}>
              {s.scenario_id}
            </option>
          ))}
        </select>
      </div>
      {scenario && (
        <div className="small">
          <div>{scenario.label}</div>
          <div className="dim">
            fleet {scenario.constraints.fleet.map((f) => `${f.vehicle_id}(${f.capacity})`).join(', ')} · horizon {fmt(scenario.constraints.horizon_s)} · service window{' '}
            {fmt(scenario.constraints.service_window_s[0])}–{fmt(scenario.constraints.service_window_s[1])}
          </div>
          {scenario.parent_scenario_id && (
            <div className="dim">
              variant of {scenario.parent_scenario_id}: {scenario.change_set.join('; ')}
            </div>
          )}
          {scenario.restrictions.map((r) => (
            <div key={r.restriction_id} className="warn small">
              ⛔ {r.label} — {r.edge_ids.length} edges, {fmt(r.start_s)}–{fmt(r.end_s)}
            </div>
          ))}
          {scenario.hazards.map((h) => (
            <div key={h.track_id} className="warn small">
              🌩 {h.label} — r={h.radius_m}m, {fmt(h.start_s)}–{fmt(h.end_s)}
            </div>
          ))}
        </div>
      )}
      <details>
        <summary>New flagship scenario</summary>
        <div className="row">
          <label>
            cohort <input type="number" value={cohort} min={20} max={600} onChange={(e) => setCohort(Number(e.target.value))} />
          </label>
          <label>
            seed <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} />
          </label>
          <button onClick={() => void createFlagship(cohort, seed)}>Create</button>
        </div>
        <div className="dim small">Demand is synthetic and labeled as such; geometry is real OSM.</div>
      </details>

      <h2>Problem → agents</h2>
      <textarea value={problem} onChange={(e) => setProblem(e.target.value)} rows={3} />
      <textarea value={constraint} onChange={(e) => setConstraint(e.target.value)} rows={2} />
      <button onClick={() => void runInvestigation()} disabled={busy || !scenarioId || investigation?.status === 'running'}>
        {investigation?.status === 'running' ? 'Agents working…' : 'Investigate with agents'}
      </button>
      {health && (
        <div className="dim small">
          model: {health.providers.llm.model} via {health.providers.llm.provider}
          {health.providers.llm.sponsor ? ' (Baseten)' : ' (local fallback, not Baseten)'} · evidence:{' '}
          {health.providers.evidence.available ? health.providers.evidence.provider : 'unavailable'}
        </div>
      )}
      {investigation && (
        <div className="decisions small">
          <div>
            <b>{investigation.status}</b> · {investigation.decisions.length} decisions
            {investigation.evidence_bundle_id ? ` · evidence ${investigation.evidence_bundle_id}` : ''}
          </div>
          {investigation.error && <div className="bad">{investigation.error}</div>}
          {investigation.decisions.map((d) => (
            <div key={d.decision_id} className="decision">
              <span className="mono">{d.role}</span> {d.action}: {d.output_summary}
              {d.validation && <div className="dim">→ {d.validation}</div>}
            </div>
          ))}
        </div>
      )}

      <h2>Plans</h2>
      {plans.map(({ plan, validation }) => (
        <div key={plan.plan_id} className={`plan ${validation && !validation.valid ? 'invalid' : ''}`}>
          <div className="row">
            <b>{plan.name}</b>
            <span className={`pill ${validation?.valid ? 'ok' : 'bad'}`}>{validation ? (validation.valid ? 'valid' : 'rejected') : '?'}</span>
          </div>
          <div className="dim small">
            {plan.family} · {plan.duties.length} duties · by {plan.authored_by}
          </div>
          {plan.rationale && <div className="small">{plan.rationale}</div>}
          {validation?.issues.map((i, k) => (
            <div key={k} className={`small ${i.severity === 'hard' ? 'bad' : 'dim'}`}>
              [{i.severity}] {i.code}: {i.message}
            </div>
          ))}
          <div className="row">
            <button disabled={!validation?.valid} onClick={() => void submitRun(plan.plan_id)}>
              Run in SUMO
            </button>
            {runsFor(plan.plan_id).map((r) => (
              <span key={r.run_id} className="runrow">
                <StatusPill run={r} />
                {r.status === 'completed' && (
                  <>
                    <button className={primaryRunId === r.run_id ? 'active' : ''} onClick={() => void openRun(r.run_id, 'primary')}>
                      {loadingReplay === r.run_id ? '…' : 'view'}
                    </button>
                    <button className={compareRunId === r.run_id ? 'active' : ''} onClick={() => void openRun(r.run_id, 'compare')}>
                      compare
                    </button>
                  </>
                )}
                {(r.status === 'running' || r.status === 'queued') && <button onClick={() => void cancelRun(r.run_id)}>cancel</button>}
                {r.error && <span className="bad small">{r.error}</span>}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
