import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { clock } from '../world/playback'
import { entitiesAt, personStateAt, seriesAt, type PersonState } from '../replay'
import { bindingsForEntityAt, brainColor, residentViewAt } from '../population'
import { selectedResidentId, selectionEntityId, selectionPosition } from '../selection'
import { bubblePlacement, fmt } from '../util'
import { cameraTo, leadMap } from '../world/registry'
import { agentPose, currentPose } from '../world/camera'

const STATE_LABEL: Record<PersonState, string> = {
  not_departed: 'still inside the venue',
  walking: 'walking',
  waiting: 'waiting for a shuttle',
  riding: 'riding',
  driving: 'driving',
  arrived: 'arrived',
  unroutable: 'no route found by SUMO',
}

/** Contextual bubble for the selected person / bus / car. Anchored to the lead map's screen projection. */
export default function AgentBubble() {
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const setLens = useStore((s) => s.setLens)
  const rx = useStore((s) => (s.primaryRunId ? s.replays[s.primaryRunId] : null))
  const travelers = useStore((s) => s.travelers)
  const pack = useStore((s) => s.pack)
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const cameraMode = useStore((s) => s.cameraMode)
  const t = useStore((s) => s.t)
  const [pt, setPt] = useState<{ x: number; y: number } | null>(null)
  const bubble = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState({ width: 300, height: 300, viewportWidth: 1024, viewportHeight: 768 })

  const id = selection && selection.kind !== 'restriction' && selection.kind !== 'stop' ? selection.id : null

  useLayoutEffect(() => {
    const element = bubble.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      const next = { width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight }
      setBounds((previous) => Object.keys(next).every((key) => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [id, rx])

  // Follow the entity on screen (per frame, off the React tree except for the final set when it moves).
  useEffect(() => {
    if (!id || !rx) return
    let last = ''
    let lastFollow = 0
    const update = (tt: number, follow: boolean) => {
      const lead = leadMap()
      const stop = rx.bundle.run.run_kind !== 'population' ? pack?.stops.find((s) => s.stop_id === waitingStop(rx.personEvents[id], tt)) : null
      const pos: [number, number] | null = selectionPosition(rx, selection, tt) ?? (stop ? [stop.lon, stop.lat] : null)
      if (!lead || !pos) {
        if (last !== 'none') {
          last = 'none'
          setPt(null)
        }
        return
      }
      const p = lead.project([pos[0], pos[1]])
      const key = `${p.x | 0},${p.y | 0}`
      if (key !== last) {
        last = key
        setPt({ x: p.x, y: p.y })
      }
      // Agent mode: glide the camera after the entity at most ~1.5×/s, and only once it has drifted off centre.
      const now = performance.now()
      if (follow && cameraMode === 'agent' && now - lastFollow > 650 && !lead.isMoving()) {
        const c = lead.getCenter()
        const drift = Math.hypot((pos[0] - c.lng) * 80_000, (pos[1] - c.lat) * 111_000)
        if (drift > 12) {
          lastFollow = now
          const cur = currentPose(lead)
          lead.easeTo({ ...cur, center: [pos[0], pos[1]], duration: 700, easing: (x) => x })
        }
      }
    }
    // Re-project while paused too: the camera may move under a still clock.
    const onMove = () => update(clock.t, false)
    const lead = leadMap()
    lead?.on('move', onMove)
    update(clock.t, true)
    const off = clock.onFrame((tt) => update(tt, true))
    return () => {
      off()
      lead?.off('move', onMove)
    }
  }, [id, rx, pack, cameraMode, selection])

  if (!selection || !id || !rx) return null
  const entityId = selectionEntityId(rx, selection, t)
  const ent = entitiesAt(rx, t).find((e) => e.id === entityId)
  const placement = pt ? bubblePlacement(pt, bounds, { width: bounds.viewportWidth, height: bounds.viewportHeight }) : null
  const style = placement ? { left: placement.left, top: placement.top, transform: 'translateX(-50%)' } : undefined
  const cls = `bubble ${pt ? placement?.shifted ? 'shifted' : '' : 'docked'}`

  const follow = () => {
    const lead = leadMap()
    const pos = selectionPosition(rx, selection, t)
    if (lead && pos) cameraTo(agentPose([pos[0], pos[1]], ent?.angle ?? null, currentPose(lead)), 'agent')
  }

  const residentId = selectedResidentId(rx, selection, t)
  const resident = rx.population && residentId ? residentViewAt(rx.population, residentId, t) : null
  if (resident) {
    const { profile, state, assignment, decision, provenance, binding } = resident
    return <div ref={bubble} className={`${cls} population-bubble`} style={style}>
      <div className="bubble-head"><i className="brain-dot" style={{ background: `rgb(${brainColor(assignment).join(',')})` }} /><b>{profile.name}</b><button className="iconbtn small" onClick={() => select(null)} aria-label="Close">×</button></div>
      <div className="small">{state?.role.replaceAll('_', ' ') ?? profile.roles.join(', ')} · <b>{state?.activity ?? 'no state'}</b> · {binding?.mode ?? state?.mobility_mode ?? '—'}</div>
      <div className="small population-persona">{profile.persona}</div>
      <div className="small dim">{binding?.ownership === 'abstract' ? `Abstract presence · ${rx.population?.anchors[binding.anchor_id ?? '']?.name ?? binding.anchor_id}` : binding?.ownership === 'shared' ? `Shared vehicle ${binding.entity_id}` : ent ? `Measured ${ent.kind} · ${(ent.speed * 3.6).toFixed(0)} km/h` : 'No recorded position at this time'}</div>
      <div className="small">{state?.commitments.length ?? 0} commitments · {resident.tasks.length} relevant tasks</div>
      <div className="small dim population-ellipsis" title={`Assigned ${assignment?.model_family} / ${provenance.assignedModel}`}>Assigned {assignment?.model_family} / {provenance.assignedModel}</div>
      <div className="small population-ellipsis" title={`Actual source ${provenance.source} / ${provenance.actualModel ?? 'no model recorded'}`}>Actual: <b>{provenance.source === 'none' ? 'no decision yet' : provenance.source}</b>{provenance.actualModel ? ` / ${provenance.actualModel}` : ''}{decision ? ` · +${fmt(decision.t)}` : ''}</div>
      {decision && <div className="small population-summary"><b>{decision.source === 'jiuwenswarm' ? 'Recorded generated summary' : 'Recorded summary'}:</b> {decision.summary}</div>}
      {decision?.proposal && <div className="small">Proposal: {decision.proposal.action} · {decision.accepted ? 'accepted' : 'not accepted'} (not proof of completion)</div>}
      {provenance.fallbackReason && <div className="small warn">Fallback: {provenance.fallbackReason}</div>}
      <div className="row"><button className="ghostbtn" onClick={follow} disabled={!selectionPosition(rx, selection, t)}>Follow</button><button className="ghostbtn" onClick={() => setLens('people')}>Inspect brain</button></div>
      <div className="small dim">Replay-only records · no new inference</div>
    </div>
  }
  if (selection.kind === 'resident') return null

  if (selection.kind === 'person' && rx.bundle.run.run_kind !== 'population') {
    const ev = rx.personEvents[id]
    const state = personStateAt(ev, t, travelers[id]?.has_car ? 'car' : undefined)
    const trav = travelers[id]
    const zone = pack?.zones.find((z) => z.zone_id === trav?.dest_zone)
    const wait = waitedSoFar(ev, t)
    const num = Number(id.replace(/\D/g, ''))
    return (
      <div ref={bubble} className={cls} style={style}>
        <div className="bubble-head">
          <b>Traveler {Number.isFinite(num) ? num : id}</b>
          <span className={`pill ${state}`}>{STATE_LABEL[state]}</span>
          <button className="iconbtn small" onClick={() => select(null)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="small">heading to {zone?.name ?? trav?.dest_zone ?? 'unknown'}</div>
        <div className="small dim">
          {trav?.has_car ? 'drove here' : 'no car'} · leaves at +{fmt(trav?.depart_s ?? 0)}
          {wait > 0 && ` · waited ${fmt(wait)}`}
          {ent?.speed !== undefined && state !== 'waiting' && ` · ${(ent.speed * 3.6).toFixed(0)} km/h`}
        </div>
        <div className="row">
          <button className="ghostbtn" onClick={follow}>
            Follow
          </button>
          <button className="ghostbtn" onClick={() => setLens('people')}>
            Why?
          </button>
        </div>
        <div className="small dim">synthetic traveler · positions are recorded SUMO samples</div>
      </div>
    )
  }

  if (selection.kind === 'bus') {
    const occ = seriesAt(rx.occupancy[id], t)
    const cap = scenario?.constraints.fleet.find((f) => f.vehicle_id === id)?.capacity
    const bindings = rx.population ? bindingsForEntityAt(rx.population, id, t) : []
    const riders = rx.population ? bindings.length : Object.entries(rx.personEvents).filter(([, ev]) => onboard(ev, t, id)).length
    return (
      <div ref={bubble} className={cls} style={style}>
        <div className="bubble-head">
          <b>{id.replace('_', ' ').toUpperCase()}</b>
          <span className="pill bus">{rx.bundle.run.run_kind === 'population' ? 'shared bus' : 'shuttle'}</span>
          <button className="iconbtn small" onClick={() => select(null)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="small">
          {occ ?? riders} aboard{cap ? ` / ${cap} seats` : ''}
          {ent ? ` · ${(ent.speed * 3.6).toFixed(0)} km/h` : ' · not on the road right now'}
        </div>
        {rx.population && <div className="wrap">{bindings.slice(0, 6).map((b) => <button key={b.resident_id} className="tiny" onClick={() => select({ kind: 'resident', id: b.resident_id })}>{rx.population?.profiles[b.resident_id]?.name ?? b.resident_id}</button>)}</div>}
        <div className="row">
          <button className="ghostbtn" onClick={follow}>
            Follow
          </button>
          <button className="ghostbtn" onClick={() => setLens('transport')}>
            Why?
          </button>
        </div>
      </div>
    )
  }

  const owner = rx.bundle.run.run_kind !== 'population' && selection.kind === 'car' && id.startsWith('car_p') ? id.slice(4) : null
  return (
    <div ref={bubble} className={cls} style={style}>
      <div className="bubble-head">
        <b>{owner ? `Traveler ${Number(owner.replace(/\D/g, ''))}'s car` : rx.bundle.run.run_kind === 'population' ? `Unowned ${selection.kind}` : selection.kind === 'car' ? 'Background car' : `Recorded ${selection.kind}`}</b>
        <span className="pill car">{selection.kind}</span>
        <button className="iconbtn small" onClick={() => select(null)} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="small dim">{ent ? `${(ent.speed * 3.6).toFixed(0)} km/h` : 'not on the road right now'}</div>
      <div className="row">
        <button className="ghostbtn" onClick={follow}>
          Follow
        </button>
        {owner && (
          <button className="ghostbtn" onClick={() => select({ kind: 'person', id: owner })}>
            Traveler
          </button>
        )}
      </div>
    </div>
  )
}

function waitingStop(ev: { t: number; event: string; stop_id: string | null }[] | undefined, t: number): string | null {
  if (!ev) return null
  let stop: string | null = null
  for (const e of ev) {
    if (e.t > t) break
    if (e.event === 'wait_start') stop = e.stop_id
    else if (e.event === 'board' || e.event === 'arrive') stop = null
  }
  return stop
}

function waitedSoFar(ev: { t: number; event: string }[] | undefined, t: number): number {
  if (!ev) return 0
  let total = 0
  let since: number | null = null
  for (const e of ev) {
    if (e.t > t) break
    if (e.event === 'wait_start') since = e.t
    else if (e.event === 'board' && since !== null) {
      total += e.t - since
      since = null
    }
  }
  if (since !== null) total += t - since
  return Math.max(0, Math.round(total))
}

function onboard(ev: { t: number; event: string; vehicle_id: string | null }[], t: number, bus: string): boolean {
  let on = false
  for (const e of ev) {
    if (e.t > t) break
    if (e.event === 'board' && e.vehicle_id === bus) on = true
    else if (e.event === 'alight' || e.event === 'arrive') on = false
  }
  return on
}
