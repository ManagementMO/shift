import { useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { InterventionProposal } from '../types'
import { fmt } from '../util'

export default function EditPanel() {
  const scenarioId = useStore((s) => s.scenarioId)
  const selectScenario = useStore((s) => s.selectScenario)
  const setError = useStore((s) => s.setError)
  const [prompt, setPrompt] = useState('Also close Erb St through Uptown from 10:00 to 30:00')
  const [proposal, setProposal] = useState<InterventionProposal | null>(null)
  const [busy, setBusy] = useState(false)

  const preview = async () => {
    if (!scenarioId) return
    setBusy(true)
    try {
      setProposal(await api.previewEdit(scenarioId, prompt))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  const apply = async () => {
    if (!scenarioId || !proposal) return
    setBusy(true)
    try {
      const s = await api.applyEdit(scenarioId, proposal)
      const scenarios = await api.scenarios()
      useStore.setState({ scenarios })
      setProposal(null)
      await selectScenario(s.scenario_id)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="edit">
      <h2>Edit scenario (typed preview → confirm)</h2>
      <div className="row">
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ flex: 1 }} placeholder="close / reopen a street, move a stop, set fleet, add a storm corridor…" />
        <button onClick={() => void preview()} disabled={busy || !scenarioId}>
          Preview
        </button>
      </div>
      {proposal && (
        <div className={`proposal ${proposal.kind === 'unsupported' || proposal.ambiguous ? 'invalid' : ''}`}>
          <div>
            <b>{proposal.kind}</b> {proposal.ambiguous ? '(ambiguous — not applied)' : ''}
          </div>
          <div className="small">{proposal.reason}</div>
          {proposal.edge_ids.length > 0 && <div className="small mono dim">{proposal.edge_ids.length} edges: {proposal.edge_ids.slice(0, 6).join(' ')}{proposal.edge_ids.length > 6 ? ' …' : ''}</div>}
          {proposal.stop_id && (
            <div className="small">
              stop {proposal.stop_id} → {proposal.target_stop_id}
            </div>
          )}
          {proposal.fleet_count !== null && <div className="small">fleet → {proposal.fleet_count} buses</div>}
          {proposal.start_s !== null && proposal.end_s !== null && (
            <div className="small">
              {fmt(proposal.start_s)}–{fmt(proposal.end_s)}
            </div>
          )}
          {proposal.hazard && (
            <div className="small">
              storm corridor: {proposal.hazard.waypoints.length} waypoints, r={proposal.hazard.radius_m}m — {proposal.hazard.label}
            </div>
          )}
          {proposal.warnings.map((w, i) => (
            <div key={i} className="warn small">
              {w}
            </div>
          ))}
          <div className="row">
            <button onClick={() => void apply()} disabled={busy || proposal.kind === 'unsupported' || proposal.ambiguous}>
              Confirm → new scenario variant
            </button>
            <button onClick={() => setProposal(null)}>discard</button>
          </div>
          <div className="dim small">Applying creates a new scenario id; existing runs stay immutable.</div>
        </div>
      )}
    </div>
  )
}
