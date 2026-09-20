import { useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { fmt } from '../util'
import { proposalTitle } from './ghost'
import { cameraTo, leadMap } from '../world/registry'
import { corridorPose, currentPose, incidentPose } from '../world/camera'

/** Ghost preview → confirm. Confirming branches the scenario; the parent and its runs stay immutable. */
export default function ProposalCard() {
  const ghost = useStore((s) => s.ghost)
  const setGhost = useStore((s) => s.setGhost)
  const applyGhost = useStore((s) => s.applyGhost)
  const roads = useStore((s) => s.roads)
  const building = useStore((s) => s.building)
  const primaryPlan = useStore((s) => s.runs.find((r) => r.run_id === s.primaryRunId)?.plan_id ?? null)
  const [runAfter, setRunAfter] = useState(true)
  const [busy, setBusy] = useState(false)
  const p = ghost?.proposal
  if (!p) return null
  const blocked = p.kind === 'unsupported' || p.ambiguous

  const focus = () => {
    const lead = leadMap()
    if (!lead) return
    const base = currentPose(lead)
    if (p.hazard) {
      const wp = p.hazard.waypoints
      cameraTo(incidentPose(wp[0], p.hazard.radius_m * 3, base), 'incident')
      return
    }
    if (roads && p.edge_ids.length) {
      const pts: [number, number][] = []
      for (const f of roads.features) {
        if (!p.edge_ids.includes(String(f.properties?.id))) continue
        const g = f.geometry
        if (g.type === 'LineString') pts.push(g.coordinates[0] as [number, number], g.coordinates[g.coordinates.length - 1] as [number, number])
      }
      if (pts.length >= 2) cameraTo(corridorPose([pts[0], pts[pts.length - 1]], base), 'corridor')
    }
  }

  const run = async () => {
    setBusy(true)
    try {
      await applyGhost()
      const s = useStore.getState()
      if (runAfter && s.scenarioId) {
        const plans = s.plans.filter((x) => x.validation?.valid)
        const pick = plans.find((x) => x.plan.plan_id === primaryPlan) ?? plans[0]
        if (pick) {
          await api.submitRun(s.scenarioId, pick.plan.plan_id, 1)
          await s.refreshRuns()
        }
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`proposal ${blocked ? 'blocked' : ''}`}>
      <div className="proposal-head">
        <span className="kind">{blocked ? 'Needs clarification' : 'Ghost preview'}</span>
        <b>{proposalTitle(p)}</b>
      </div>
      <div className="small">{p.reason}</div>
      {p.start_s !== null && p.end_s !== null && !blocked && (
        <div className="small dim">
          window +{fmt(p.start_s)} → +{fmt(p.end_s)}
        </div>
      )}
      {p.hazard && <div className="small dim">{p.hazard.label}</div>}
      {p.warnings.map((w, i) => (
        <div key={i} className="small warn">
          {w}
        </div>
      ))}
      {!blocked && (
        <label className="small check">
          <input type="checkbox" checked={runAfter} onChange={(e) => setRunAfter(e.target.checked)} />
          re-run {primaryPlan ?? 'a valid plan'} in SUMO on the new branch
        </label>
      )}
      <div className="row">
        {!blocked && (
          <button className="primary" onClick={() => void run()} disabled={busy || !!building}>
            {building ? 'Building…' : 'Run branch'}
          </button>
        )}
        {!leadMap()?.cameraLocked && (p.edge_ids.length > 0 || p.hazard) && (
          <button onClick={focus} className="ghostbtn">
            Frame
          </button>
        )}
        <button onClick={() => setGhost(null)} className="ghostbtn">
          Discard
        </button>
      </div>
      <div className="small dim">Nothing changes until you run the branch. The current scenario and its runs stay as they are.</div>
    </div>
  )
}
