import { useEffect, useMemo, useRef } from 'react'
import ResidentInspector from '../components/ResidentInspector'
import { buildDefinitionIndex, residentStateAt } from '../population'
import { selectionPosition } from '../selection'
import { useStore } from '../store'
import { agentPose, currentPose } from '../world/camera'
import { cameraTo, leadMap } from '../world/registry'
import { residentDetailsSource } from './residentDetailsSource'
import './residentDetails.css'

export default function ResidentDetails() {
  const active = useStore(s => s.populationActive)
  const primaryRunId = useStore(s => s.primaryRunId)
  const replay = useStore(s => s.primaryRunId ? s.replays[s.primaryRunId] ?? null : null)
  const definition = useStore(s => s.populationDefinition)
  const selection = useStore(s => s.selection)
  const select = useStore(s => s.select)
  const t = useStore(s => s.t)
  const initial = useMemo(() => definition ? buildDefinitionIndex(definition) : null, [definition])
  const { population, residentId, time } = residentDetailsSource(primaryRunId, replay, initial, selection, t)
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    if (panel.current) panel.current.scrollTop = 0
  }, [residentId, primaryRunId])
  if (!active) return null
  // Keep the selected identity visible while a resumed run publishes its next boundary.
  const pendingId = selection?.kind === 'resident' ? selection.id : null
  if (!residentId && !pendingId) return null

  const anchorId = !primaryRunId && population && residentId ? residentStateAt(population, residentId, 0)?.anchor_id : null
  const anchor = anchorId && population ? population.anchors[anchorId] : null
  const position = primaryRunId && replay && residentId ? selectionPosition(replay, { kind: 'resident', id: residentId }, time) : anchor ? [anchor.lon, anchor.lat] as [number, number] : null
  const frame = () => {
    const map = leadMap()
    if (map && position) cameraTo(agentPose(position, null, currentPose(map)), 'district')
  }
  const follow = () => {
    const map = leadMap()
    if (map && position) cameraTo(agentPose(position, null, currentPose(map)), 'agent')
  }

  return <aside ref={panel} id="resident-details" tabIndex={-1} className="resident-details glass" aria-label="Resident details">
    {population && residentId && population.profiles[residentId]
      ? <ResidentInspector key={`${primaryRunId ?? 'definition'}:${residentId}`} population={population} residentId={residentId} t={time} onSelect={id => select({ kind: 'resident', id })} onClose={() => select(null)} onFrame={position ? frame : undefined} onFollow={primaryRunId && replay && position ? follow : undefined} />
      : <div className="resident-details-empty small">
        <div className="row between"><h2>Resident details</h2><button className="tiny" onClick={() => select(null)}>Close</button></div>
        <p>{primaryRunId && !replay ? 'Waiting for the next recorded boundary. The selected resident is preserved while execution continues.' : 'Resident state is unavailable in this recording.'}</p>
        <p className="dim">Inspection makes no model calls.</p>
      </div>}
  </aside>
}
