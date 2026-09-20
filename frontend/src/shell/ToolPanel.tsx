import { useEffect, useMemo, useState } from 'react'
import { applyNow, environmentAt, live, liveClosuresAt, useLive } from '../live/session'
import { useStore, type ToolId } from '../store'
import { AREAS, startPick } from '../world/areaSelect'
import { corridorPose, currentPose } from '../world/camera'
import { cameraTo, leadMap } from '../world/registry'
import { edgePath } from '../util'
import DevelopmentTool from './DevelopmentTool'
import LivePreviewCard from './LivePreviewCard'
import PopulationPanel from './PopulationPanel'

const TITLES: Record<ToolId, string> = {
  area: 'Area select',
  closure: 'Road closures',
  development: 'New development',
  population: 'Population',
  temperature: 'Temperature',
  residents: 'AI residents',
}

export default function ToolPanel() {
  const tool = useStore((s) => s.tool)
  const setTool = useStore((s) => s.setTool)
  if (!tool) return null
  return (
    <aside className={`toolpanel ${tool === 'development' ? 'toolpanel-development' : ''}`}>
      <div className="toolpanel-head">
        <b>{TITLES[tool]}</b>
        <button className="iconbtn small" onClick={() => setTool(null)} aria-label="Close">
          ✕
        </button>
      </div>
      {tool === 'area' && <AreaTool />}
      {tool === 'closure' && <ClosureTool />}
      {tool === 'development' && <DevelopmentTool />}
      {tool === 'population' && <PopulationTool />}
      {tool === 'temperature' && <TemperatureTool />}
      {tool === 'residents' && <PopulationPanel />}
      {tool !== 'development' && tool !== 'closure' && tool !== 'residents' && <LivePreviewCard onApplied={() => useStore.getState().setGhost(null)} />}
    </aside>
  )
}

/**
 * District / Corridor pickers.  Choosing one closes this panel, frames every candidate and opens the pick: the
 * cursor turns to a crosshair, the city outlines the regions and tints the one under the pointer, and a click
 * flies in and closes the pick.  Escape, choosing the active picker again, or another tool ends it where the
 * camera is.
 */
function AreaTool() {
  const picking = useStore((s) => s.picking)
  const cameraMode = useStore((s) => s.cameraMode)
  const setPicking = useStore((s) => s.setPicking)
  const pack = useStore((s) => s.pack)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const update = () => {
      const lead = leadMap()
      setReady(Boolean(lead && (!lead.cameraLocked || lead.setCameraPreset)))
    }
    update()
    const id = setInterval(update, 500)
    return () => clearInterval(id)
  }, [pack])
  const open = picking ? AREAS.find((a) => a.id === cameraMode) ?? null : null
  return (
    <div className="tool">
      <div className="small dim">Zoom to a part of the city by pointing at it.</div>
      <div className="list">
        {AREAS.map((a) => {
          const on = open?.id === a.id
          return (
            <button key={a.id} className={`listitem ${on ? 'on' : ''}`} aria-pressed={on} disabled={!ready || !pack} onClick={() => (on ? setPicking(false) : startPick(a.id))} title={`${a.label} (${a.key})`}>
              <span>
                {a.label} <span className="dim">· {a.key}</span>
              </span>
              <span className="dim">{a.hint}</span>
            </button>
          )
        })}
      </div>
      <div className="small dim">{open ? `Choosing a ${open.label.toLowerCase()} — point at one on the map and click to zoom, Esc to stop.` : 'Districts are the pack’s destination zones and the venue; corridors are its named streets.'}</div>
    </div>
  )
}

/**
 * Close a street in the running city. Pick a named street here (the camera flies to it) or click a drivable
 * segment on the map, then Apply: SUMO validates and applies the closure in one step. It stays closed until it is
 * reopened from the barricaded street's card. Sidewalks stay open.
 */
function ClosureTool() {
  const corridors = useStore((s) => s.corridors)
  const roads = useStore((s) => s.roads)
  const ghost = useStore((s) => s.ghost)
  const setGhost = useStore((s) => s.setGhost)
  const select = useStore((s) => s.select)
  const { busy, error, primary } = useLive()
  const t = useStore((s) => s.t)
  const picked = ghost?.edges ?? []
  const closures = useMemo(() => liveClosuresAt(primary?.state ?? null, t, (edges) => Object.values(corridors).find((c) => c.edge_ids.every((e) => edges.includes(e)))?.label ?? null), [primary, t, corridors])
  const closedBy = useMemo(() => {
    const out = new Map<string, string>()
    for (const [k, c] of Object.entries(corridors)) {
      const r = closures.find((x) => c.edge_ids.some((e) => x.edge_ids.includes(e)))
      if (r) out.set(k, r.restriction_id)
    }
    return out
  }, [corridors, closures])
  const pickedKey = Object.keys(corridors).find((k) => corridors[k].edge_ids.length === picked.length && corridors[k].edge_ids.every((e) => picked.includes(e))) ?? ''

  const pick = (k: string) => {
    const rid = closedBy.get(k)
    if (rid) {
      select({ kind: 'restriction', id: rid })
      return
    }
    live.discard()
    setGhost({ edges: corridors[k].edge_ids, stops: [], hazard: null })
    const lead = leadMap()
    const path = edgePath(roads, corridors[k].edge_ids)
    if (lead && !lead.cameraLocked && path.length >= 2) cameraTo(corridorPose(path, currentPose(lead)), 'corridor')
  }
  const apply = async () => {
    if (await applyNow({ kind: 'close_road', edge_ids: picked, until_s: null })) setGhost(null)
  }

  return (
    <div className="tool">
      <div className="small dim">Choose a street below or click a drivable segment on the map, then apply. Closed streets get barricades; click one to reopen it.</div>
      <div className="list">
        {Object.entries(corridors).map(([k, c]) => (
          <button key={k} className={`listitem ${pickedKey === k ? 'on' : ''}`} onClick={() => pick(k)} aria-pressed={pickedKey === k}>
            <span>{c.label}</span>
            <span className={closedBy.has(k) ? 'closed' : 'dim'}>
              {c.edge_ids.length} seg{closedBy.has(k) ? ' · closed — click to manage' : ''}
            </span>
          </button>
        ))}
      </div>
      <div className="small dim">{picked.length ? `${picked.length} road segment${picked.length === 1 ? '' : 's'} selected` : 'Nothing selected yet'}</div>
      {error && <div className="small bad">{error}</div>}
      <button className="primary" disabled={!picked.length || !!busy || !primary} onClick={() => void apply()}>
        {busy ? 'Closing…' : picked.length ? 'Apply closure' : 'Choose a street'}
      </button>
    </div>
  )
}

/** Add travelers to the running city: real journeys, routed by SUMO like everyone else's. */
function PopulationTool() {
  const pack = useStore((s) => s.pack)
  const t = useStore((s) => s.t)
  const { busy, draft, primary } = useLive()
  const session = primary?.state ?? null
  const environment = session ? environmentAt(session, t) : null
  const [count, setCount] = useState(500)
  const [destination, setDestination] = useState(() => [...(pack?.zones ?? [])].sort((a, b) => b.share - a.share)[0]?.zone_id ?? '')
  const [origin, setOrigin] = useState('')
  const [windowS, setWindowS] = useState(300)
  const ceiling = 10000 - (environment?.population ?? 0)
  return (
    <div className="tool">
      <div className="population-head small">
        <span>People in the city</span>
        <span className="dim">{environment ? `${environment.population.toLocaleString()} travelers so far` : 'starting the city…'}</span>
      </div>
      <label className="small">
        add travelers: <b>{count.toLocaleString()}</b>
        <input type="range" min={50} max={Math.max(50, Math.min(5000, ceiling))} step={50} value={count} onChange={(e) => setCount(Number(e.target.value))} disabled={!!draft} />
      </label>
      <label className="small">
        heading to
        <select value={destination} onChange={(e) => setDestination(e.target.value)} disabled={!!draft}>
          {pack?.zones.map((z) => (
            <option key={z.zone_id} value={z.zone_id}>
              {z.name}
            </option>
          ))}
        </select>
      </label>
      <label className="small">
        starting from
        <select value={origin} onChange={(e) => setOrigin(e.target.value)} disabled={!!draft}>
          <option value="">spread across the other districts</option>
          {pack?.zones.map((z) => (
            <option key={z.zone_id} value={z.zone_id}>
              {z.name}
            </option>
          ))}
        </select>
      </label>
      <label className="small">
        leaving over
        <select value={windowS} onChange={(e) => setWindowS(Number(e.target.value))} disabled={!!draft}>
          <option value={0}>all at once</option>
          <option value={60}>1 minute</option>
          <option value={300}>5 minutes</option>
          <option value={600}>10 minutes</option>
        </select>
      </label>
      {!draft && (
        <button className="primary" disabled={!!busy || !session || !destination || count < 1} onClick={() => void live.preview({ kind: 'population', count, destination_zone_id: destination, origin_zone_id: origin || null, release_window_s: windowS })}>
          {busy ? 'Checking…' : `Preview +${count.toLocaleString()} travelers`}
        </button>
      )}
      <div className="small dim">{session ? `${Math.round(session.config.car_share * 100)}% have a car; the rest walk or ride. Existing travelers keep their trips.` : ''}</div>
    </div>
  )
}

/** Change the temperature: an explicit cold-response model alters walking speed and tolerance. */
function TemperatureTool() {
  const t = useStore((s) => s.t)
  const { busy, draft, primary } = useLive()
  const session = primary?.state ?? null
  const current = session ? environmentAt(session, t).temperature : 20
  const [target, setTarget] = useState<number | null>(null)
  const value = target ?? current
  return (
    <div className="tool">
      <div className="population-head small">
        <span>Temperature</span>
        <span className="dim">now {current}°C</span>
      </div>
      <label className="small">
        set to <b>{value}°C</b>
        <input type="range" min={-40} max={50} step={1} value={value} onChange={(e) => setTarget(Number(e.target.value))} disabled={!!draft} />
      </label>
      <div className="row">
        <button className="ghostbtn" disabled={!!draft || value <= -40} onClick={() => setTarget(Math.max(-40, value - 20))}>
          −20°C
        </button>
        <button className="ghostbtn" disabled={!!draft || value >= 50} onClick={() => setTarget(Math.min(50, value + 20))}>
          +20°C
        </button>
      </div>
      {!draft && (
        <button className="primary" disabled={!!busy || !session || value === current} onClick={() => void live.preview({ kind: 'temperature', temperature_c: value })}>
          {busy ? 'Checking…' : value === current ? 'Temperature unchanged' : `Preview ${value}°C`}
        </button>
      )}
      <div className="small dim">Illustrative mobility assumptions, not a weather forecast. It does not assume snow or ice.</div>
    </div>
  )
}
