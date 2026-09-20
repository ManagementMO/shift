import { populationBudgetPolicy, populationCostLimit, populationScaleReason, populationUnavailableReason } from '../populationControls'
import { useStore } from '../store'
import { fmt } from '../util'

export default function PopulationRunControl() {
  const definition = useStore((s) => s.populationDefinition)
  const status = useStore((s) => s.populationStatus)
  const statusError = useStore((s) => s.populationStatusError)
  const busy = useStore((s) => s.populationSubmitting)
  const active = useStore((s) => s.runs.some((r) => r.status === 'queued' || r.status === 'running'))
  const submit = useStore((s) => s.submitPopulationRun)
  const refresh = useStore((s) => s.refreshPopulationStatus)
  if (!definition) return null
  const native = definition.spec.brains.every((brain) => brain.control_mode === 'jiuwenswarm')
  const reason = !native ? 'This archived population uses rules fixtures, not native JiuwenSwarm. Replay is available; native execution is disabled for this definition.' : populationUnavailableReason(status, statusError) ?? populationScaleReason(status, definition.spec.count)
  return <div className="population-run small">
    <div>{definition.spec.count} residents · seed {definition.spec.seed} · horizon {fmt(definition.spec.horizon_s)} · cost cap ${definition.spec.budget.max_cost_usd.toFixed(2)}</div>
    <div className={reason ? 'warn' : 'dim'}>{reason ?? 'Native JiuwenSwarm is available. Status is not proof of a successful model run.'}</div>
    {status && <div className="dim">Available inference funds: ${populationCostLimit(status).toFixed(2)}. {populationBudgetPolicy(status)}</div>}
    <button className="primary" onClick={() => void submit()} disabled={Boolean(reason) || busy || active}>
      {busy ? 'Submitting population run…' : active ? 'Population run in progress…' : 'Start new society run (uses models)'}
    </button>
    <div className="dim">Start new creates a different run. Use execution Pause/Resume on a saved run below to keep its simulation identity.</div>
    <div className="dim">Only explicit Start/Resume actions execute cognition. Generation, playback, and inspection do not call models. No mock or rules execution is substituted.</div>
    <button className="ghostbtn" onClick={() => void refresh()} disabled={busy}>Refresh JiuwenSwarm status</button>
  </div>
}
