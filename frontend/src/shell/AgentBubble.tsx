import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { clock } from '../world/playback'
import { entitiesAt, personStateAt, lonLatAt, seriesAt, type PersonState } from '../replay'
import { fmt } from '../util'
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

  const id = selection && selection.kind !== 'restriction' && selection.kind !== 'stop' ? selection.id : null

  // Follow the entity on screen (per frame, off the React tree except for the final set when it moves).
  useEffect(() => {
    if (!id || !rx) return
    let last = ''
    let lastFollow = 0
    const update = (tt: number, follow: boolean) => {
      const lead = leadMap()
      const ix = rx.tracks[id]
      const stop = pack?.stops.find((s) => s.stop_id === waitingStop(rx.personEvents[id], tt))
      const pos: [number, number] | null = ix ? lonLatAt(ix, tt) : stop ? [stop.lon, stop.lat] : null
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
      if (follow && !lead.cameraLocked && cameraMode === 'agent' && now - lastFollow > 650 && !lead.isMoving()) {
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
  }, [id, rx, pack, cameraMode])

  if (!selection || !id || !rx) return null
  const ent = entitiesAt(rx, t).find((e) => e.id === id)
  const style = pt ? { left: pt.x, top: pt.y } : undefined
  const cls = `bubble ${pt ? '' : 'docked'}`

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
