import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { clock } from '../world/playback'
import { entitiesAt, personStateAt, lonLatAt, seriesAt, type PersonState } from '../replay'
import { centroidOf, edgePath, fmt } from '../util'
import { cameraTo, leadMap } from '../world/registry'
import { agentPose, buildingPose, corridorPose, currentPose } from '../world/camera'

const STATE_LABEL: Record<PersonState, string> = {
  not_departed: 'still inside the venue',
  walking: 'walking',
  waiting: 'waiting for a shuttle',
  riding: 'riding',
  driving: 'driving',
  arrived: 'arrived',
  unroutable: 'no route found by SUMO',
}

/**
 * Contextual bubble for whatever was clicked: a person / bus / car, a stop, a closure or a building.  Anchored
 * to the lead map's screen projection of the thing: a moving entity is followed frame by frame, the rest sit still.
 */
export default function AgentBubble() {
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const setLens = useStore((s) => s.setLens)
  const rx = useStore((s) => (s.primaryRunId ? s.replays[s.primaryRunId] : null))
  const travelers = useStore((s) => s.travelers)
  const pack = useStore((s) => s.pack)
  const roads = useStore((s) => s.roads)
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const cameraMode = useStore((s) => s.cameraMode)
  const t = useStore((s) => s.t)
  const [pt, setPt] = useState<{ x: number; y: number } | null>(null)

  const kind = selection?.kind ?? null
  const selId = selection?.id ?? null
  const id = selection && (selection.kind === 'bus' || selection.kind === 'car' || selection.kind === 'person') ? selection.id : null
  const restriction = kind === 'restriction' ? scenario?.restrictions.find((r) => r.restriction_id === selId) ?? null : null
  const stopSel = kind === 'stop' ? pack?.stops.find((s) => s.stop_id === selId) ?? null : null
  const building = useMemo(() => (kind === 'building' && selId ? leadMap()?.buildingFacts?.(selId) ?? null : null), [kind, selId])

  // Keep the bubble on its anchor (per frame, off the React tree except for the final set when it moves).
  useEffect(() => {
    if (!selId || (id && !rx)) return
    // A closure can run for blocks: pin its bubble to the closed segment nearest the middle of the view.
    const path = restriction ? edgePath(roads, restriction.edge_ids) : []
    const still = (lead: ReturnType<typeof leadMap>): [number, number] | null => {
      if (stopSel) return [stopSel.lon, stopSel.lat]
      if (building) return building.lonLat
      if (!restriction) return null
      const c = lead?.getCenter()
      return c ? nearestPoint(path, [c.lng, c.lat]) : centroidOf(path)
    }
    let last = ''
    let lastFollow = 0
    const update = (tt: number, follow: boolean) => {
      const lead = leadMap()
      const ix = id && rx ? rx.tracks[id] : undefined
      const stop = id && rx ? pack?.stops.find((s) => s.stop_id === waitingStop(rx.personEvents[id], tt)) : undefined
      const pos: [number, number] | null = still(lead) ?? (ix ? lonLatAt(ix, tt) : stop ? [stop.lon, stop.lat] : null)
      if (!lead || !pos) {
        if (last !== 'none') {
          last = 'none'
          setPt(null)
        }
        return
      }
      // a building's bubble floats over its roof
      const p = building && lead.projectAt ? lead.projectAt([pos[0], pos[1]], building.height) : lead.project([pos[0], pos[1]])
      const key = `${p.x | 0},${p.y | 0}`
      if (key !== last) {
        last = key
        setPt({ x: p.x, y: p.y })
      }
      // Agent mode: glide the camera after the entity at most ~1.5×/s, and only once it has drifted off centre.
      const now = performance.now()
      if (follow && id && !lead.cameraLocked && cameraMode === 'agent' && now - lastFollow > 650 && !lead.isMoving()) {
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
  }, [id, selId, rx, pack, roads, restriction, stopSel, building, cameraMode])

  if (!selection) return null
  const style = pt ? { left: pt.x, top: pt.y } : undefined
  const cls = `bubble ${pt ? '' : 'docked'}`
  const locked = leadMap()?.cameraLocked

  if (building) {
    const b = building
    const floors = b.height > 4 ? Math.max(1, Math.round(b.height / 3.5)) : null
    const source = b.kind === 'massing' ? 'City of Toronto 3D massing' : b.kind === 'landmark' ? 'landmark model' : `OpenStreetMap footprint ${b.id}`
    const frame = () => {
      const lead = leadMap()
      if (lead) cameraTo(buildingPose(b.lonLat, b.height, currentPose(lead)), 'district')
    }
    return (
      <div className={cls} style={style}>
        <div className="bubble-head">
          <b>{b.name ?? (b.kind === 'landmark' ? 'Landmark' : 'Building')}</b>
          <span className="pill">{b.cat && b.cat !== 'generic' ? b.cat : 'building'}</span>
          <button className="iconbtn small" onClick={() => select(null)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="small">
          {Math.round(b.height)} m tall{floors ? ` · about ${floors} floor${floors === 1 ? '' : 's'}` : ''} · {Math.round(b.area).toLocaleString()} m² footprint
        </div>
        <div className="small dim">
          {b.sections > 1 ? `${b.sections} sections · ` : ''}
          {source}
        </div>
        <div className="row">
          {!locked && (
            <button className="ghostbtn" onClick={frame}>
              Frame
            </button>
          )}
        </div>
      </div>
    )
  }

  if (restriction) {
    const r = restriction
    const status = t < r.start_s ? `starts in ${fmt(r.start_s - t)}` : t > r.end_s ? 'over' : 'in effect now'
    const frame = () => {
      const lead = leadMap()
      const pts = edgePath(roads, r.edge_ids)
      if (lead && pts.length >= 2) cameraTo(corridorPose(pts, currentPose(lead)), 'incident')
    }
    return (
      <div className={cls} style={style}>
        <div className="bubble-head">
          <b>{r.restriction_id.startsWith('hazard') ? 'Hazard footprint' : 'Street closure'}</b>
          <span className={`pill closure ${t >= r.start_s && t <= r.end_s ? '' : 'off'}`}>{status}</span>
          <button className="iconbtn small" onClick={() => select(null)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="small">{r.label}</div>
        <div className="small dim">
          {r.edge_ids.length} segments · {r.modes.join(', ')} · +{fmt(r.start_s)}–+{fmt(r.end_s)}
        </div>
        <div className="small dim">source: {r.source_claim_id ?? 'scenario fixture, no evidence claim'}</div>
        <div className="row">
          {!locked && (
            <button className="ghostbtn" onClick={frame}>
              Frame
            </button>
          )}
          <button className="ghostbtn" onClick={() => setLens('transport')}>
            Details
          </button>
        </div>
      </div>
    )
  }

  if (stopSel) {
    const s = stopSel
    const waiting = rx ? seriesAt(rx.stopQueue[s.stop_id], t) ?? 0 : null
    const duties = rx?.bundle.compile?.duties.filter((d) => d.stop_sequence.includes(s.stop_id)) ?? []
    const allowed = scenario?.constraints.allowed_stop_ids.includes(s.stop_id)
    return (
      <div className={cls} style={style}>
        <div className="bubble-head">
          <b>{s.name}</b>
          <span className="pill">stop</span>
          <button className="iconbtn small" onClick={() => select(null)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="small">{waiting === null ? 'no replay loaded' : `${waiting} waiting now`}</div>
        <div className="small dim">
          {allowed ? 'in the scenario’s allowed set' : 'not in the allowed set'}
          {duties.length > 0 && ` · served by ${duties.map((d) => d.vehicle_id.replace('_', ' ')).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`}
        </div>
        <div className="row">
          <button className="ghostbtn" onClick={() => setLens('transport')}>
            Details
          </button>
        </div>
      </div>
    )
  }

  if (!id || !rx) return null
  const ent = entitiesAt(rx, t).find((e) => e.id === id)

  const follow = () => {
    const lead = leadMap()
    const ix = rx.tracks[id]
    const pos = ix ? lonLatAt(ix, t) : null
    if (lead && pos) cameraTo(agentPose([pos[0], pos[1]], ent?.angle ?? null, currentPose(lead)), 'agent')
  }

  if (selection.kind === 'person') {
    const ev = rx.personEvents[id]
    const state = personStateAt(ev, t, travelers[id]?.has_car ? 'car' : undefined)
    const trav = travelers[id]
    const zone = pack?.zones.find((z) => z.zone_id === trav?.dest_zone)
    const wait = waitedSoFar(ev, t)
    const num = Number(id.replace(/\D/g, ''))
    return (
      <div className={cls} style={style}>
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
          {!leadMap()?.cameraLocked && (
            <button className="ghostbtn" onClick={follow}>
              Follow
            </button>
          )}
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
    const riders = Object.entries(rx.personEvents).filter(([, ev]) => onboard(ev, t, id)).length
    return (
      <div className={cls} style={style}>
        <div className="bubble-head">
          <b>{id.replace('_', ' ').toUpperCase()}</b>
          <span className="pill bus">shuttle</span>
          <button className="iconbtn small" onClick={() => select(null)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="small">
          {occ ?? riders} aboard{cap ? ` / ${cap} seats` : ''}
          {ent ? ` · ${(ent.speed * 3.6).toFixed(0)} km/h` : ' · not on the road right now'}
        </div>
        <div className="row">
          {!leadMap()?.cameraLocked && (
            <button className="ghostbtn" onClick={follow}>
              Follow
            </button>
          )}
          <button className="ghostbtn" onClick={() => setLens('transport')}>
            Why?
          </button>
        </div>
      </div>
    )
  }

  const owner = id.startsWith('car_p') ? id.slice(4) : null
  return (
    <div className={cls} style={style}>
      <div className="bubble-head">
        <b>{owner ? `Traveler ${Number(owner.replace(/\D/g, ''))}'s car` : 'Background car'}</b>
        <span className="pill car">car</span>
        <button className="iconbtn small" onClick={() => select(null)} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="small dim">{ent ? `${(ent.speed * 3.6).toFixed(0)} km/h` : 'not on the road right now'}</div>
      <div className="row">
        {!leadMap()?.cameraLocked && (
          <button className="ghostbtn" onClick={follow}>
            Follow
          </button>
        )}
        {owner && (
          <button className="ghostbtn" onClick={() => select({ kind: 'person', id: owner })}>
            Traveler
          </button>
        )}
      </div>
    </div>
  )
}

function nearestPoint(pts: [number, number][], to: [number, number]): [number, number] | null {
  let best: [number, number] | null = null
  let bestD = Infinity
  const k = Math.cos((to[1] * Math.PI) / 180)
  for (const p of pts) {
    const d = ((p[0] - to[0]) * k) ** 2 + (p[1] - to[1]) ** 2
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  return best
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
