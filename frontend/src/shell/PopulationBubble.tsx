import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { bindingAt, bindingsForEntityAt, brainColor, buildDefinitionIndex, residentViewAt } from '../population'
import { selectedResidentId, selectionPosition } from '../selection'
import { useStore } from '../store'
import { bubblePlacement, fmt } from '../util'
import { agentPose, currentPose } from '../world/camera'
import { clock } from '../world/playback'
import { cameraTo, leadMap } from '../world/registry'
import './population.css'

/** A recorded resident follows their current body, never a similarly named live traveler. */
export default function PopulationBubble() {
  const selection = useStore(s => s.selection)
  const rx = useStore(s => s.primaryRunId ? s.replays[s.primaryRunId] ?? null : null)
  const runId = useStore(s => s.primaryRunId)
  const definition = useStore(s => s.populationDefinition)
  const t = useStore(s => s.t)
  const cameraMode = useStore(s => s.cameraMode)
  const select = useStore(s => s.select)
  const initial = useMemo(() => definition ? buildDefinitionIndex(definition) : null, [definition])
  const population = runId ? rx?.population ?? null : initial
  const time = rx ? t : 0
  const residentId = rx ? selectedResidentId(rx, selection, time) : selection?.kind === 'resident' ? selection.id : null
  const resident = population && residentId ? residentViewAt(population, residentId, time) : null
  const element = useRef<HTMLDivElement>(null)
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null)
  const [bounds, setBounds] = useState({ width: 280, height: 280, viewportWidth: 1024, viewportHeight: 768 })
  const position = (at: number): [number, number] | null => {
    if (rx) return selectionPosition(rx, selection, at)
    const b = population && residentId ? bindingAt(population, residentId, 0) : null
    const anchor = b?.anchor_id ? population?.anchors[b.anchor_id] : null
    return !runId && anchor ? [anchor.lon, anchor.lat] : null
  }

  useLayoutEffect(() => {
    if (!element.current) return
    const measure = () => {
      const rect = element.current?.getBoundingClientRect()
      if (rect) setBounds({ width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element.current)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [selection, population])

  useEffect(() => {
    let lastFollow = 0
    const update = (at: number, follow: boolean) => {
      const map = leadMap()
      const pos = position(at)
      const projected = map && pos ? map.project(pos) : null
      setPoint(previous => previous?.x === projected?.x && previous?.y === projected?.y ? previous : projected)
      if (!map || !pos || !follow || map.cameraLocked || cameraMode !== 'agent' || map.isMoving()) return
      const now = performance.now()
      const c = map.getCenter()
      if (now - lastFollow > 650 && Math.hypot((pos[0] - c.lng) * 80000, (pos[1] - c.lat) * 111000) > 12) {
        lastFollow = now
        map.easeTo({ ...currentPose(map), center: pos, duration: 700, easing: x => x })
      }
    }
    const move = () => update(clock.t, false)
    const map = leadMap()
    map?.on('move', move)
    update(clock.t, false)
    const off = clock.onFrame(at => update(at, true))
    return () => { off(); map?.off('move', move) }
    // Position reads the frozen replay plus the current binding at the frame's time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, rx, population, residentId, runId, cameraMode])

  if (!selection || ['stop', 'restriction', 'development', 'building'].includes(selection.kind)) return null
  const placement = point ? bubblePlacement(point, bounds, { width: bounds.viewportWidth, height: bounds.viewportHeight }) : null
  const style = placement ? { left: placement.left, top: placement.top, transform: 'translateX(-50%)' } : undefined
  const pos = position(time)
  const follow = () => {
    const map = leadMap()
    if (map && pos) cameraTo(agentPose(pos, null, currentPose(map)), 'agent')
  }
  const close = <button className="iconbtn small" onClick={() => select(null)} aria-label="Close resident selection">×</button>
  const riders = population && !resident ? bindingsForEntityAt(population, selection.id, time) : []
  return <div ref={element} className={`bubble population-bubble ${resident ? 'resident-summary-bubble' : ''} ${point ? placement?.shifted ? 'shifted' : '' : 'docked'}`} style={style} role="dialog" aria-label={resident ? `${resident.profile.name}, recorded resident` : 'Recorded vehicle'}>
    {resident ? <>
      <div className="bubble-head"><i className="brain-dot" style={{ background: `rgb(${brainColor(resident.assignment).join(',')})` }} /><b>{resident.profile.name}</b>{close}</div>
      <div className="small">{resident.state?.role.replaceAll('_', ' ')} · {resident.state?.activity} · {resident.binding?.mode ?? resident.state?.mobility_mode}</div>
      <div className="small population-persona">{resident.profile.persona}</div>
      <div className="small dim">{resident.binding?.ownership === 'abstract' ? `Abstract presence · ${population?.anchors[resident.binding.anchor_id ?? '']?.name ?? 'declared anchor'}` : resident.binding?.ownership === 'shared' ? `Aboard shared vehicle ${resident.binding.entity_id}` : pos ? 'Measured SUMO movement' : 'No recorded position at this time'}</div>
      <div className="small">Assigned {resident.provenance.assignedFamily} · Actual: <b>{resident.provenance.source === 'none' ? 'no decision yet' : resident.provenance.source}</b>{resident.provenance.actualModel ? ` / ${resident.provenance.actualModel}` : ''}</div>
      <div className="small population-summary"><b>Recorded summary{resident.decision ? ` · +${fmt(resident.decision.t)}` : ''}</b><p>{resident.decision?.summary || 'No decision recorded by this time.'}</p></div>
      {resident.decision?.proposal && <div className="small">{resident.decision.proposal.action} · {resident.decision.accepted ? 'accepted' : 'not accepted'} · completion is recorded separately</div>}
      {resident.provenance.fallbackReason && <div className="small warn">Fallback: {resident.provenance.fallbackReason}</div>}
    </> : <>
      <div className="bubble-head"><b>{selection.kind === 'bus' ? 'Shared bus' : `Recorded ${selection.kind}`}</b>{close}</div>
      <div className="small mono">{selection.id}</div>
      {population ? <><div className="small">{riders.length} recorded residents aboard at +{fmt(time)}</div><div className="wrap">{riders.map(b => <button className="ghostbtn" key={b.resident_id} onClick={() => select({ kind: 'resident', id: b.resident_id })}>{population.profiles[b.resident_id]?.name ?? b.resident_id}</button>)}</div></> : <div className="small dim">Resident ownership is unavailable in this recording.</div>}
    </>}
    <div className="row wrap"><button className="ghostbtn" disabled={!pos || !!leadMap()?.cameraLocked} onClick={follow}>Follow</button>{resident && <button className="ghostbtn" onClick={() => document.getElementById('resident-details')?.focus()}>Inspect brain</button>}</div>
    <div className="small dim">{runId ? 'Recorded history' : 'Initial definition, not executed'} · inspection makes no model calls</div>
  </div>
}
