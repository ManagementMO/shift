import { useEffect, useMemo, useState } from 'react'
import { DEVELOPMENT_USES, developmentCounts, developmentLabel } from '../development'
import { live, liveClosuresAt, useLive } from '../live/session'
import { useStore } from '../store'
import { clock } from '../world/playback'
import { centroidOf, edgePath, fmt } from '../util'
import { cameraTo, leadMap } from '../world/registry'
import { agentPose, buildingPose, corridorPose, currentPose } from '../world/camera'
import { DeleteButton } from './DeleteButton'
import LivePreviewCard from './LivePreviewCard'

/** A closure card clicked near the top of the screen opens below its anchor instead of above it. */
const FLIP_PX = 300
const SIDE_PX = 170

/** Traveler states as the live frames encode them (mirrors backend/cityshift/live). */
const STATE_LABEL = ['not yet departed', 'walking', 'waiting for a shuttle', 'riding', 'driving', 'arrived', 'no route found by SUMO']
const STATE_CLASS = ['not_departed', 'walking', 'waiting', 'riding', 'driving', 'arrived', 'unroutable']

/**
 * Contextual bubble for whatever was clicked in the live city: a person / bus / car, a stop, a closure, a base-city
 * building or a development.  Anchored to the lead map's screen projection of the thing: a moving entity is followed
 * frame by frame, the rest sit still.  Closures reopen and developments demolish from here, as live commands.
 */
export default function AgentBubble() {
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const setTool = useStore((s) => s.setTool)
  const tool = useStore((s) => s.tool)
  const pack = useStore((s) => s.pack)
  const roads = useStore((s) => s.roads)
  const corridors = useStore((s) => s.corridors)
  const cameraMode = useStore((s) => s.cameraMode)
  const t = useStore((s) => s.t)
  const { primary, draft, busy } = useLive()
  const session = primary?.state ?? null
  const [pt, setPt] = useState<{ x: number; y: number } | null>(null)
  const [snapshot, setSnapshot] = useState<{ heading: number; speed: number; state: number } | null>(null)

  const kind = selection?.kind ?? null
  const selId = selection?.id ?? null
  const id = selection && (selection.kind === 'bus' || selection.kind === 'car' || selection.kind === 'person') ? selection.id : null
  const closures = useMemo(() => liveClosuresAt(session, t, (edges) => Object.values(corridors).find((c) => c.edge_ids.every((e) => edges.includes(e)))?.label ?? null), [session, t, corridors])
  const restriction = kind === 'restriction' ? closures.find((r) => r.restriction_id === selId) ?? null : null
  const clickedAt = selection?.kind === 'restriction' ? selection.at ?? null : null
  const stopSel = kind === 'stop' ? pack?.stops.find((s) => s.stop_id === selId) ?? null : null
  const building = useMemo(() => (kind === 'building' && selId ? leadMap()?.buildingFacts?.(selId) ?? null : null), [kind, selId])
  // The development panel already shows a development's details while it is open (e.g. right after confirming).
  const development = kind === 'development' && tool !== 'development' ? session?.developments?.find((d) => d.development_id === selId) ?? null : null
  const meta = id ? primary?.metadata.entities.find((e) => e.id === id) ?? null : null
  const roofHeight = building ? building.height : development ? development.spec.height_m : null

  // Keep the bubble on its anchor (per frame, off the React tree except for the final set when it moves).
  useEffect(() => {
    if (!selId) return
    // A closure can run for blocks: pin its bubble where it was clicked, else to the closed segment nearest the middle of the view.
    const path = restriction ? edgePath(roads, restriction.edge_ids) : []
    const still = (lead: ReturnType<typeof leadMap>): [number, number] | null => {
      if (stopSel) return [stopSel.lon, stopSel.lat]
      if (building) return building.lonLat
      if (development) return development.spec.position
      if (!restriction) return null
      if (clickedAt) return clickedAt
      const c = lead?.getCenter()
      return c ? nearestPoint(path, [c.lng, c.lat]) : centroidOf(path)
    }
    let last = ''
    let lastFollow = 0
    let lastInfo = ''
    const update = (follow: boolean) => {
      const lead = leadMap()
      const ent = id ? lead?.entityAt?.(id) ?? null : null
      const pos: [number, number] | null = still(lead) ?? ent?.lonLat ?? null
      if (ent) {
        const info = `${ent.state}:${Math.round(ent.speed * 3.6)}`
        if (info !== lastInfo) {
          lastInfo = info
          setSnapshot({ heading: ent.heading, speed: ent.speed, state: ent.state })
        }
      }
      if (!lead || !pos) {
        if (last !== 'none') {
          last = 'none'
          setPt(null)
        }
        return
      }
      // a building's or development's bubble floats over its roof
      const p = roofHeight !== null && lead.projectAt ? lead.projectAt([pos[0], pos[1]], roofHeight) : lead.project([pos[0], pos[1]])
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
    const onMove = () => update(false)
    const lead = leadMap()
    lead?.on('move', onMove)
    update(true)
    const off = clock.onFrame(() => update(true))
    return () => {
      off()
      lead?.off('move', onMove)
    }
  }, [id, selId, roads, restriction, clickedAt, stopSel, building, development, roofHeight, cameraMode])

  if (!selection || selection.kind === 'resident') return null
  const style = pt ? { left: pt.x, top: pt.y } : undefined
  const cls = `bubble ${pt ? '' : 'docked'}`
  const locked = leadMap()?.cameraLocked
  const close = (
    <button className="iconbtn small" onClick={() => select(null)} aria-label="Close">
      ✕
    </button>
  )

  if (building) {
    const b = building
    const floors = b.height > 4 ? Math.max(1, Math.round(b.height / 3.5)) : null
    const source = b.kind === 'massing' ? 'City of Toronto 3D massing' : b.kind === 'landmark' ? 'landmark model' : `OpenStreetMap footprint ${b.id}`
    const frame = () => {
      const lead = leadMap()
      if (lead) cameraTo(buildingPose(b.lonLat, b.height, currentPose(lead)), 'district')
    }
    return (
      <div className={`${cls} building-card`} style={style} role="dialog" aria-label={`${b.name ?? 'Building'}, building`}>
        <div className="bubble-head">
          <b>{b.name ?? (b.kind === 'landmark' ? 'Landmark' : 'Building')}</b>
          <span className="pill">{b.cat && b.cat !== 'generic' ? b.cat : 'building'}</span>
          {close}
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

  if (development) {
    const { spec } = development
    const counts = developmentCounts(spec)
    const removing = draft?.intervention.kind === 'remove_development' && draft.intervention.development_id === development.development_id
    return (
      <div className={`${cls} building-card`} style={style} role="dialog" aria-label={`${spec.name}, development`}>
        <div className="bubble-head">
          <b>{spec.name}</b>
          <span className="pill">{developmentLabel(spec).toLowerCase()}</span>
          {close}
        </div>
        <div className="small dim">
          {spec.capacity.toLocaleString()} {DEVELOPMENT_USES[spec.land_use].unit} · {counts.trips.toLocaleString()} one-way trips · standing in the city
        </div>
        {removing ? (
          <LivePreviewCard applyLabel="Demolish & play" onApplied={() => select(null)} />
        ) : (
          <div className="row">
            <DeleteButton label="Delete" busy={!!busy} prompt={`Demolish ${spec.name}? Travelers who have not set off yet are dropped; the rest finish their trips.`} onConfirm={() => void live.preview({ kind: 'remove_development', development_id: development.development_id })} />
            <button
              className="ghostbtn"
              onClick={() => {
                setTool('development')
                select({ kind: 'development', id: development.development_id })
              }}
            >
              Details
            </button>
          </div>
        )}
      </div>
    )
  }

  if (restriction) {
    // A street closure has no timer: it stays until it is reopened here, as a live command previewed by SUMO first.
    const r = restriction
    const reopening = draft?.intervention.kind === 'reopen_road' && r.edge_ids.every((e) => (draft.intervention as { edge_ids: string[] }).edge_ids.includes(e))
    const frame = () => {
      const lead = leadMap()
      const pts = edgePath(roads, r.edge_ids)
      if (lead && pts.length >= 2) cameraTo(corridorPose(pts, currentPose(lead)), 'incident')
    }
    // keep the wider card on screen: flip below a high anchor, hold it off the side edges
    const placed = pt ? { left: Math.max(SIDE_PX, Math.min(window.innerWidth - SIDE_PX, pt.x)), top: pt.y } : undefined
    return (
      <div className={`${cls} closure ${pt && pt.y < FLIP_PX ? 'below' : ''}`} style={placed} role="dialog" aria-label="Street closure">
        <div className="bubble-head">
          <b>Street closure</b>
          <span className="pill closure">closed</span>
          {close}
        </div>
        <div className="small">{r.label}</div>
        <div className="small dim">
          {r.edge_ids.length} segment{r.edge_ids.length === 1 ? '' : 's'} · cars and buses · since +{fmt(r.start_s)} · closed until you reopen it
        </div>
        {reopening && !tool ? (
          <LivePreviewCard applyLabel="Reopen & play" onApplied={() => select(null)} />
        ) : (
          <div className="row">
            <button className="primary" onClick={() => void live.preview({ kind: 'reopen_road', edge_ids: r.edge_ids })} disabled={!!busy || !session}>
              {busy ? 'Checking…' : 'Reopen street'}
            </button>
            {!locked && (
              <button className="ghostbtn" onClick={frame}>
                Frame
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  if (stopSel) {
    const s = stopSel
    const waiting = session?.metrics?.stop_queues?.[s.stop_id] ?? null
    const lines = primary?.metadata.routes.filter((r) => r.stop_ids.includes(s.stop_id)).map((r) => r.bus_id.replace('_', ' ')) ?? []
    return (
      <div className={cls} style={style}>
        <div className="bubble-head">
          <b>{s.name}</b>
          <span className="pill">stop</span>
          {close}
        </div>
        <div className="small">{waiting === null ? 'no queue recorded yet' : `${waiting} waiting now`}</div>
        <div className="small dim">{lines.length ? `served by ${lines.filter((v, i, a) => a.indexOf(v) === i).join(', ')}` : 'no shuttle serves this stop'}</div>
      </div>
    )
  }

  if (!id) return null
  const follow = () => {
    const lead = leadMap()
    const ent = lead?.entityAt?.(id)
    if (lead && ent) cameraTo(agentPose(ent.lonLat, ent.heading, currentPose(lead)), 'agent')
  }
  const speed = snapshot ? `${(snapshot.speed * 3.6).toFixed(0)} km/h` : null
  const followButton = !locked && (
    <button className="ghostbtn" onClick={follow}>
      Follow
    </button>
  )

  if (selection.kind === 'person') {
    const state = snapshot?.state ?? -1
    const zone = pack?.zones.find((z) => z.zone_id === meta?.destination_zone_id)
    const num = Number(id.replace(/\D/g, ''))
    return (
      <div className={cls} style={style}>
        <div className="bubble-head">
          <b>Traveler {Number.isFinite(num) ? num : id}</b>
          {state >= 0 && <span className={`pill ${STATE_CLASS[state] ?? ''}`}>{STATE_LABEL[state] ?? 'on the move'}</span>}
          {close}
        </div>
        <div className="small">heading to {zone?.name ?? meta?.destination_zone_id ?? 'their destination'}</div>
        <div className="small dim">
          {meta ? `set off at +${fmt(meta.depart_s)}` : 'live traveler'}
          {speed && state !== 2 && ` · ${speed}`}
        </div>
        <div className="row">{followButton}</div>
        <div className="small dim">synthetic traveler · position is SUMO's, live</div>
      </div>
    )
  }

  if (selection.kind === 'bus') {
    return (
      <div className={cls} style={style}>
        <div className="bubble-head">
          <b>{id.replace('_', ' ').toUpperCase()}</b>
          <span className="pill bus">shuttle</span>
          {close}
        </div>
        <div className="small">
          {meta?.capacity ? `${meta.capacity} seats` : 'shuttle'}
          {meta?.line ? ` · ${meta.line}` : ''}
          {speed ? ` · ${speed}` : ' · not on the road right now'}
        </div>
        <div className="row">{followButton}</div>
      </div>
    )
  }

  const owner = meta?.person_id ?? (id.startsWith('car_p') ? id.slice(4) : null)
  return (
    <div className={cls} style={style}>
      <div className="bubble-head">
        <b>{owner ? `Traveler ${Number(owner.replace(/\D/g, ''))}'s car` : 'Background car'}</b>
        <span className="pill car">car</span>
        {close}
      </div>
      <div className="small dim">{speed ?? 'not on the road right now'}</div>
      <div className="row">
        {followButton}
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
