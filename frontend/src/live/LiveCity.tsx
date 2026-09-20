import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'

import { api } from '../api'
import { BrandMark } from '../components/Icon'
import type { Pose } from '../babylon/camera'
import type { BabylonSyncMap } from '../babylon/mapAdapter'
import type { WorldScene } from '../babylon/scene'
import type { Picked } from '../babylon/traffic'
import type { CityPack, Corridor } from '../types'
import { liveApi } from './api'
import { LiveController } from './controller'
import LiveCanvas from './LiveCanvas'
import LiveControls, { type LiveTool } from './LiveControls'
import LiveTimeline from './LiveTimeline'
import SwarmPanel from './SwarmPanel'
import { elapsed, environmentAt, interventionLabel } from './timeline'
import type { LiveSession } from './types'
import { useDisplay } from '../babylon/display'
import { SWARM_SCALES } from '../babylon/figures'
import { alarmRadius, DEFAULT_INCIDENT, type IncidentSettings } from './incident'
import '../App.css'
import './live.css'

type Side = 'primary' | 'baseline'
type Selected = Picked & { side: Side; follow: boolean }
// Every tool here changes the running SUMO city in place; there is no scenario building.
const TOOLS: { id: LiveTool; label: string; mark: string }[] = [
  { id: 'road', label: 'Road closures', mark: 'M5 2 3 18M15 2l2 16M10 3v3m0 3v3m0 3v2' },
  { id: 'population', label: 'Population', mark: 'M7 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM2 17v-3a4 4 0 0 1 8 0v3m3-12a2 2 0 0 1 0 4m0 2a4 4 0 0 1 4 4v2' },
  { id: 'temperature', label: 'Temperature', mark: 'M8 12V4a2 2 0 0 1 4 0v8a4 4 0 1 1-4 0ZM10 8v6' },
]
const PERSON_STATE = ['Not departed', 'Walking', 'Waiting for transport', 'On transit', 'Driving', 'Arrived', 'Unroutable']
const NO_ROADS: string[] = []

function rememberSession(id: string): void {
  try { localStorage.setItem('cityshift-live:v1', JSON.stringify({ version: 1, session_id: id })) }
  catch { return }
}

export default function LiveCity() {
  const [controller] = useState(() => new LiveController())
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [packs, setPacks] = useState<{ pack_id: string; name: string }[]>([])
  const [chosenPack, setChosenPack] = useState('toronto')
  const [loadedPack, setPack] = useState<CityPack | null>(null)
  const [corridors, setCorridors] = useState<Record<string, Corridor>>({})
  const [sessions, setSessions] = useState<LiveSession[]>([])
  const [localError, setLocalError] = useState<string | null>(null)
  const [tool, setTool] = useState<LiveTool | null>(null)
  const [roads, setRoads] = useState<string[]>([])
  const [incident, setIncident] = useState<IncidentSettings>(DEFAULT_INCIDENT)
  const swarmScale = useDisplay(s => s.swarmScale)
  const setDisplay = useDisplay(s => s.set)
  const [selected, setSelected] = useState<Selected | null>(null)
  const [setup, setSetup] = useState(false)
  const [initialPopulation, setInitialPopulation] = useState(1000)
  const [fleet, setFleet] = useState(2)
  const [split, setSplit] = useState(50)
  const [performance, setPerformance] = useState({ fps: 0, actors: 0, alerted: 0, ready: false })
  const worlds = useRef<Partial<Record<Side, { world: WorldScene; map: BabylonSyncMap }>>>({})
  const lastCamera = useRef<{ pack: string; pose: Pose; projection: 'isometric' | 'perspective' } | null>(null)
  const session = view.primary?.state
  const packId = session?.pack_id ?? chosenPack
  const pack = loadedPack?.pack_id === packId ? loadedPack : null
  const environment = session ? environmentAt(session, view.t) : null
  const active = !!session && !['starting', 'restoring', 'failed'].includes(session.status)
  const blocked = !!view.busy || !active
  const primarySelection = useMemo(() => selected ? { id: selected.id, follow: selected.follow && selected.side === 'primary' } : null, [selected])
  const baselineSelection = useMemo(() => selected ? { id: selected.id, follow: selected.follow && selected.side === 'baseline' } : null, [selected])
  const incidentDraft = useMemo(() => tool === 'incident' && incident.place ? { lon: incident.place.lon, lat: incident.place.lat, radius_m: incident.radius_m, alarm_radius_m: alarmRadius(incident), label: incident.label } : null, [tool, incident])
  const placeIncident = useCallback((lon: number, lat: number) => setIncident(current => ({ ...current, place: { lon, lat } })), [])

  useEffect(() => {
    controller.start()
    const query = new URLSearchParams(window.location.search)
    let id = query.get('session')
    if (!id) {
      try { const saved = JSON.parse(localStorage.getItem('cityshift-live:v1') ?? 'null'); if (saved?.version === 1) id = saved.session_id } catch { id = null }
    }
    if (id && /^live-[a-f0-9]{12}$/.test(id)) void controller.open(id, query.has('t') ? Number(query.get('t')) : undefined)
    if (window.__cityshift) window.__cityshift.live = { controller, worlds: {} }
    return () => { controller.stop(); if (window.__cityshift?.live?.controller === controller) delete window.__cityshift.live }
  }, [controller])

  useEffect(() => {
    let cancelled = false
    api.packs().then(value => { if (!cancelled) setPacks(value) }).catch(error => { if (!cancelled) setLocalError(String(error)) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([api.pack(packId), api.corridors(packId)]).then(([value, streets]) => {
      if (!cancelled) { setPack(value); setCorridors(streets); setLocalError(null) }
    }).catch(error => { if (!cancelled) setLocalError(String(error)) })
    return () => { cancelled = true }
  }, [packId])

  useEffect(() => {
    let cancelled = false
    liveApi.list().then(value => { if (!cancelled) setSessions(value) }).catch(error => { if (!cancelled) setLocalError(String(error)) })
    if (session?.session_id) {
      rememberSession(session.session_id)
      const url = new URL(window.location.href)
      if (url.searchParams.get('session') !== session.session_id) url.searchParams.delete('t')
      url.searchParams.set('session', session.session_id)
      window.history.replaceState(null, '', url)
    }
    return () => { cancelled = true }
  }, [session?.session_id, session?.revision])

  useEffect(() => {
    const timer = setInterval(() => {
      const ws = worlds.current.primary?.world
      setSelected(current => current?.follow && worlds.current[current.side]?.world.camera.mode !== 'agent' ? { ...current, follow: false } : current)
      setPerformance({ fps: ws ? Math.round(ws.engine.getFps()) : 0, actors: ws ? ws.traffic.stats.people + ws.traffic.stats.cars + ws.traffic.stats.buses : 0, alerted: ws?.traffic.stats.alerted ?? 0, ready: !!ws })
    }, 750)
    return () => clearInterval(timer)
  }, [])

  const closeTool = useCallback(() => { setTool(null); setRoads([]); setIncident(current => ({ ...current, place: null })); controller.discard() }, [controller])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('input, select, textarea, [contenteditable="true"]')) return
      if (event.repeat || event.metaKey || event.ctrlKey) return
      if (event.code === 'Space') { event.preventDefault(); controller.toggle() }
      if (event.key === 'Escape') { closeTool(); setSelected(null) }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [controller, closeTool])

  const bindWorld = useCallback((side: Side, world: WorldScene, map: BabylonSyncMap) => {
    const remembered = lastCamera.current
    if (remembered?.pack === world.world.pack_id) { world.camera.setProjection(remembered.projection); world.camera.apply(remembered.pose) }
    worlds.current[side] = { world, map }
    const sync = () => {
      lastCamera.current = { pack: world.world.pack_id, pose: world.camera.pose, projection: world.camera.projection }
      for (const [otherSide, other] of Object.entries(worlds.current)) if (otherSide !== side) other?.map.syncFrom(map)
    }
    map.on('move', sync)
    const other = worlds.current[side === 'primary' ? 'baseline' : 'primary']
    if (other) map.syncFrom(other.map)
    if (window.__cityshift?.live) window.__cityshift.live.worlds[side] = world
    if (side === 'primary' && window.__cityshift) window.__cityshift.babylon = world
    return () => {
      map.off('move', sync)
      lastCamera.current = { pack: world.world.pack_id, pose: world.camera.pose, projection: world.camera.projection }
      if (worlds.current[side]?.world === world) delete worlds.current[side]
      if (window.__cityshift?.live?.worlds[side] === world) delete window.__cityshift.live.worlds[side]
    }
  }, [])
  const primaryWorld = useCallback((ws: WorldScene, map: BabylonSyncMap) => bindWorld('primary', ws, map), [bindWorld])
  const baselineWorld = useCallback((ws: WorldScene, map: BabylonSyncMap) => bindWorld('baseline', ws, map), [bindWorld])
  const primaryPick = useCallback((picked: Picked) => setSelected({ ...picked, side: 'primary', follow: false }), [])
  const baselinePick = useCallback((picked: Picked) => setSelected({ ...picked, side: 'baseline', follow: false }), [])
  const pickRoad = useCallback((ids: string[]) => setRoads(ids), [])

  const openTool = async (next: LiveTool) => {
    if (blocked) return
    controller.discard()
    await controller.pause()
    setSetup(false)
    setTool(next)
    if (next === 'road' && !roads.length) setRoads(Object.values(corridors).find(c => c.flagship_closure)?.edge_ids ?? [])
  }
  const create = (event: FormEvent) => {
    event.preventDefault()
    closeTool()
    setSelected(null)
    setSetup(false)
    void controller.create({ pack_id: chosenPack, initial_population: initialPopulation, fleet_size: fleet, seed: 7, horizon_s: 3600, temperature_c: 20, car_share: 0.35 })
  }
  const camera = (mode: 'city' | 'downtown' | 'swarm') => {
    const ws = worlds.current.primary?.world
    if (!ws || !pack) return
    setSelected(old => old ? { ...old, follow: false } : null)
    if (mode === 'city') { ws.camera.city(); return }
    const latest = session?.incidents?.filter(i => i.start_s <= view.t && view.t < i.end_s).at(-1)
    const zone = pack.zones.find(z => /financial|downtown/i.test(z.name)) ?? pack.zones[0]
    const focus = mode === 'swarm' && latest ? [latest.x, latest.z] : zone ? ws.frame.lonLatToWorld(zone.lon, zone.lat) : null
    if (!focus) return
    if (mode === 'swarm') ws.camera.swarm(focus[0], focus[1], latest ? Math.max(700, latest.alarm_radius_m * 2.4) : 700)
    else ws.camera.district(focus[0], focus[1])
  }
  const inspectChannel = selected?.side === 'baseline' ? view.baseline : view.primary
  const entity = selected ? inspectChannel?.metadata.entities.find(e => e.id === selected.id) : null
  const pose = useMemo<ReturnType<WorldScene['traffic']['poseOf']>>(() => {
    if (!entity || !inspectChannel) return null
    let value: { x: number; z: number; yaw: number; speed: number; state: number; kind: typeof entity.kind } | null = null
    inspectChannel.replay.forEachAt(view.t, (index, x, z, heading, speed, _kind, state) => {
      if (index === entity.index) value = { x, z, yaw: heading * Math.PI / 180, speed, state, kind: entity.kind }
    })
    return value
  }, [entity, inspectChannel, view.t])
  const statusText = view.busy ?? (session?.status === 'starting' ? 'Starting the SUMO city' : session?.status === 'restoring' ? 'Restoring the recorded simulation state' : view.loading ? 'Loading measured history' : null)
  const readySessions = sessions.filter(s => s.status !== 'failed' && s.available_until_s >= 0)

  return <main className="live-shell">
    {pack && <div className={view.baseline ? 'split' : 'live-worlds'} style={{ ['--split' as string]: `${split}%` }}>
      {view.baseline && <div className="split-pane left" data-side="baseline"><LiveCanvas pack={pack} channel={view.baseline} clock={controller.clock} quality="balanced" preview={null} pickedRoads={NO_ROADS} pickMode="inspect" incidentDraft={null} selected={baselineSelection} onPick={baselinePick} onRoad={pickRoad} onPlace={placeIncident} onWorld={baselineWorld} /></div>}
      <div className={view.baseline ? 'split-pane right' : 'live-world'} data-side="primary"><LiveCanvas pack={pack} channel={view.primary} clock={controller.clock} quality={view.baseline ? 'balanced' : 'high'} preview={view.draft} pickedRoads={roads} pickMode={tool === 'road' ? 'road' : tool === 'incident' && !view.draft ? 'incident' : 'inspect'} incidentDraft={incidentDraft} selected={primarySelection} onPick={primaryPick} onRoad={pickRoad} onPlace={placeIncident} onWorld={primaryWorld} /></div>
      {view.baseline && <><div className="split-divider live-divider" onPointerDown={e => e.currentTarget.setPointerCapture(e.pointerId)} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) setSplit(Math.max(15, Math.min(85, e.clientX / window.innerWidth * 100))) }} onPointerUp={e => e.currentTarget.releasePointerCapture(e.pointerId)}><i /></div><div className="split-label left"><span className="tag">Original</span><b>Preserved history</b></div><div className="split-label right"><span className="tag">Edited</span><b>Live branch</b></div></>}
    </div>}

    <header className="live-topbar">
      <a className="live-wordmark" href="/"><BrandMark size={22} /><span>Concrete Consequences</span></a>
      <div className="live-mode"><i />Live city</div>
      <span className="live-city-name">{pack?.name.split(',')[0] ?? 'Loading city'}</span>
      {environment && <span className="live-weather">{environment.temperature}°C</span>}
      <div className="live-topbar-actions">
        <select aria-label="Open a recorded live session" value={session?.session_id ?? ''} disabled={!!view.busy} onChange={event => { if (event.target.value) { closeTool(); setSetup(false); void controller.open(event.target.value) } }}><option value="">Recorded sessions</option>{readySessions.map(s => <option key={s.session_id} value={s.session_id}>{s.pack_id} · {s.counts.total.toLocaleString()} travelers · {s.session_id.slice(-6)}</option>)}</select>
        <button className="ghostbtn" disabled={!!view.busy} onClick={() => { void controller.pause(); closeTool(); setSetup(true) }}>New city</button>
        <button className={`ghostbtn ${view.baseline ? 'on' : ''}`} disabled={!session?.parent_session_id || !!view.busy} onClick={() => void controller.compare(!view.baseline)}>Compare original</button>
        {view.baseline && <label className="live-wipe">Split<input aria-label="Comparison divider" type="range" min={15} max={85} value={split} onChange={event => setSplit(Number(event.target.value))} /></label>}
        <a className="ghostbtn live-classic-link" href="/world">Recorded experiments</a>
      </div>
    </header>

    <nav className="live-tools" aria-label="City interventions">{TOOLS.map(item => <button key={item.id} className={tool === item.id ? 'on' : ''} disabled={blocked} aria-pressed={tool === item.id} onClick={() => void openTool(item.id)}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={item.mark} /></svg>{item.label}</button>)}</nav>
    <div className="live-camera-controls"><button className="ghostbtn" disabled={!performance.ready} onClick={() => camera('city')}>City view</button><button className="ghostbtn" disabled={!performance.ready} onClick={() => camera('downtown')}>Downtown</button><button className="ghostbtn" disabled={!performance.ready} onClick={() => camera('swarm')}>Swarm view</button></div>

    {pack && (!session || setup) && <aside className="live-panel live-setup" aria-label="Start a live city">
      <div className="live-panel-heading"><div><span className="live-eyebrow">Microscopic simulation</span><h1>Start a live city</h1></div>{session && <button className="iconbtn" onClick={() => setSetup(false)} aria-label="Close city setup">×</button>}</div>
      <p className="live-help">Change streets, service, weather, and demand. Watch actual SUMO journeys unfold, then scrub through their recorded history.</p>
      <form onSubmit={create}>
        <label>City<select value={chosenPack} onChange={e => setChosenPack(e.target.value)}>{packs.map(p => <option key={p.pack_id} value={p.pack_id}>{p.name.split(' — ')[0]}</option>)}</select></label>
        <label>Initial travelers<input type="number" min={0} max={10000} step={100} value={initialPopulation} onChange={e => setInitialPopulation(Number(e.target.value))} required /></label>
        <label>Available shuttle buses<input type="number" min={0} max={32} step={1} value={fleet} onChange={e => setFleet(Number(e.target.value))} required /></label>
        <p className="live-assumption">20°C baseline · seed 7 · 60 seats per bus · one simulated hour. Demand and mobility preferences are synthetic. Movement is measured in SUMO on the OSM road network.</p>
        <button className="primary live-submit" disabled={!!view.busy}>Start simulation</button>
      </form>
    </aside>}

    {pack && session && tool && !setup && <LiveControls key={session.session_id} tool={tool} pack={pack} session={session} time={view.t} corridors={corridors} roads={roads} incident={incident} preview={view.draft} busy={!!view.busy} error={view.error} onRoads={pickRoad} onIncident={setIncident} onPreview={change => void controller.preview(change)} onApply={() => void controller.apply().then(() => {
      const snapshot = controller.getSnapshot()
      if (snapshot.error) return
      const declared = tool === 'incident' ? snapshot.primary?.state.incidents?.at(-1) : undefined
      closeTool()
      const ws = worlds.current.primary?.world
      if (declared && ws) { setSelected(null); ws.camera.incident(declared.x, declared.z, declared.alarm_radius_m) }
    })} onDiscard={() => controller.discard()} onClose={closeTool} />}

    {session && !tool && !setup && !selected && <SwarmPanel session={session} time={view.t} onSeek={t => { controller.beginScrub(); void controller.seek(t) }} />}

    {selected && entity && <aside className="live-inspector" aria-label="Selected simulated agent">
      <div className="live-panel-heading"><div><span className="live-eyebrow">{selected.side === 'baseline' ? 'Original' : 'Current'} · measured in SUMO</span><h2>{entity.kind === 'bus' ? entity.id.replace('_', ' ') : `Traveler ${entity.person_id?.slice(-5) ?? entity.id.slice(-5)}`}</h2></div><button className="iconbtn" aria-label="Close traveler inspection" onClick={() => setSelected(null)}>×</button></div>
      <dl className="live-model-factors"><div><dt>Status</dt><dd>{pose?.state !== undefined && entity.kind !== 'bus' ? PERSON_STATE[pose.state] : entity.kind === 'bus' ? 'Shuttle vehicle' : 'Not visible at this time'}</dd></div><div><dt>Measured speed</dt><dd>{pose?.speed !== undefined ? `${(pose.speed * 3.6).toFixed(1)} km/h` : '—'}</dd></div>{entity.capacity && <div><dt>Capacity</dt><dd>{entity.capacity} seats</dd></div>}{entity.destination_zone_id && <div><dt>Destination</dt><dd>{pack?.zones.find(z => z.zone_id === entity.destination_zone_id)?.name ?? entity.destination_zone_id}</dd></div>}<div><dt>Scheduled departure</dt><dd>+{elapsed(entity.depart_s)}</dd></div></dl>
      <button className="primary live-submit" disabled={!pose} onClick={() => {
        const ws = worlds.current[selected.side]?.world
        if (!ws || !pose) return
        if (!selected.follow) ws.camera.agent(pose.x, pose.z, pose.kind === 'person' ? null : pose.yaw * 180 / Math.PI)
        setSelected({ ...selected, follow: !selected.follow })
      }}>{selected.follow ? 'Stop following' : 'Follow traveler'}</button>
    </aside>}

    {statusText && <div className="live-progress" role="status">{statusText}<span>Only recorded positions are displayed.</span></div>}
    {(localError || (view.error && !tool)) && <div className="live-global-error" role="alert">{localError ?? view.error}<button className="ghostbtn" onClick={() => { setLocalError(null); controller.discard() }}>Dismiss</button></div>}
    <div className="live-legend"><span><i className="walk" />Walking</span><span><i className="wait" />Waiting</span><span><i className="drive" />Cars / buses</span><span><i className="saw" />Saw it</span><span><i className="heard" />Heard about it</span><label className="live-swarm-size">Swarm size<select value={swarmScale} onChange={e => setDisplay({ swarmScale: Number(e.target.value) })}>{SWARM_SCALES.map(s => <option key={s.value} value={s.value}>{s.label} · {s.value}×</option>)}</select></label><span className="live-provenance">OSM geometry · synthetic demand · SUMO motion</span></div>
    <div className="live-performance">{performance.ready ? `${performance.fps} FPS · ${performance.actors.toLocaleString()} rendered agents · ${performance.alerted.toLocaleString()} informed` : 'Building miniature city'}{view.primary && ` · ${(view.primary.replay.residentBytes / 1048576).toFixed(1)} MB replay cache`}</div>
    {session && <details className="live-event-log"><summary>Interventions · {session.commands.length}</summary><div>{session.commands.length ? session.commands.map(command => <button key={command.command_id} disabled={command.at_s > controller.recordedUntil()} onClick={() => { controller.beginScrub(); void controller.seek(command.at_s) }}><time>+{elapsed(command.at_s)}</time>{interventionLabel(command.intervention)}</button>) : <p>No interventions yet.</p>}</div></details>}
    <LiveTimeline controller={controller} view={view} />
  </main>
}
