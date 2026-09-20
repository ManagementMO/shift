import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { fmt } from '../util'
import { hazardFootprint } from '../replay'
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
  const [runAfter, setRunAfter] = useState(false)
  const [busy, setBusy] = useState(false)
  const card = useRef<HTMLDivElement>(null)
  const p = ghost?.proposal
  useEffect(() => { card.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [p?.proposal_id])
  if (!p) return null
  const empty = (p.kind === 'storm' || p.kind === 'replace_hazard') && !!p.hazard && !p.edge_ids.length
  const blocked = p.kind === 'unsupported' || p.ambiguous

  const focus = () => {
    const lead = leadMap()
    if (!lead) return
    const base = currentPose(lead)
    if (p.hazard) {
      const fp = hazardFootprint(p.hazard, 0, true)
      if (fp) cameraTo(incidentPose(fp.center, fp.span_m, base), 'incident')
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
      const child = await applyGhost()
      const s = useStore.getState()
      if (child && runAfter && s.scenarioId === child.scenario_id) {
        const plans = s.plans.filter((x) => x.validation?.valid)
        const pick = plans.find((x) => x.plan.plan_id === primaryPlan) ?? plans[0]
        if (pick) {
          await api.submitRun(child.scenario_id, pick.plan.plan_id, 1)
          await s.refreshRuns()
        }
      }
    } catch (e) {
      useStore.getState().setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={card} className={`proposal ${blocked ? 'blocked' : ''}`}>
      <div className="proposal-head">
        <span className="kind">{empty ? 'Visual only · no roads affected' : blocked ? 'Needs clarification' : 'Unconfirmed preview'}</span>
        <b>{proposalTitle(p)}</b>
      </div>
      <div className="small">{p.reason}</div>
      {p.start_s !== null && p.end_s !== null && !blocked && (
        <div className="small dim">
          window +{fmt(p.start_s)} → +{fmt(p.end_s)}
        </div>
      )}
      {p.hazard && (
        <>
          <div className="small">{p.hazard.label} · {p.hazard.waypoints.length === 1 ? 'point buffer' : `${p.hazard.waypoints.length}-point corridor`} · {p.hazard.radius_m} m</div>
          <div className="small dim">{p.hazard.modes.map((m) => m === 'passenger' ? 'Cars' : 'Buses').join(' + ')} · full-window static footprint · pedestrians unaffected</div>
          <div className="small dim">Drawn as {p.hazard.kind === 'fire' ? 'a spreading fire' : p.hazard.kind === 'rain' ? 'a rain cloud' : 'a storm cloud'}; the visual is illustrative and does not change the restriction.</div>
          <details className="small">
            <summary>{p.edge_ids.length} exact affected network edges</summary>
            <div className="hazard-edge-list">{p.edge_ids.map((id) => <code key={id}>{id}</code>)}</div>
          </details>
        </>
      )}
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
            {building ? 'Building…' : runAfter ? 'Confirm & run' : p.kind === 'storm' ? 'Confirm event' : p.kind === 'replace_hazard' ? 'Confirm move' : p.kind === 'remove_hazard' ? 'Confirm removal' : 'Confirm branch'}
          </button>
        )}
        {!leadMap()?.cameraLocked && (p.edge_ids.length > 0 || p.hazard) && (
          <button onClick={focus} className="ghostbtn">
            Frame
          </button>
        )}
        <button onClick={() => { setGhost(null); if (p.hazard) useStore.getState().setTool(null) }} className="ghostbtn" disabled={busy || !!building}>
          Discard
        </button>
      </div>
      <div className="small dim">{blocked ? 'This preview cannot be applied. Refine the request or discard it.' : 'Confirm creates a child scenario. The parent, its demand, and its runs stay unchanged. Transport effects are measured only after a SUMO run.'}</div>
    </div>
  )
}
