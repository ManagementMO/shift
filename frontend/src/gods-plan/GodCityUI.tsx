import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStore, type ToolId } from '../store'
import { DEFAULT_LIVE_CONFIG, live, useLive, liveCountsAt, environmentAt, newCity } from '../live/session'
import { clock, simClock, PLAYBACK_SPEEDS } from '../world/playback'
import { cameraTo, leadMap } from '../world/registry'
import { agentPose, currentPose } from '../world/camera'
import { useDisplay } from '../babylon/display'
import type { WorldScene } from '../babylon/scene'
import TornadoPlacement from '../babylon/TornadoPlacement.tsx'
import OrbitalLaserPlacement from '../babylon/OrbitalLaserPlacement'
import { LASER_DURATION, laserRadius, MAX_LASER_STRIKES } from '../babylon/orbitalLaserModel'
import { DEFAULT_TORNADO, placedTornado, tornadoRadius, type TornadoSettings, type GroundPoint } from '../babylon/tornadoPlacement'
import ToolPanel from '../shell/ToolPanel'
import AgentBubble from '../shell/AgentBubble'
import GodChrome from './GodChrome'
import LivePeoplePanel from './LivePeoplePanel'
import CityLogPanel from './CityLog'
import { EventMenu, EventConfigPanel, ActiveEventPanel, DisasterAlert, OrbitalLaserPanel } from './EventPanels'
import { CitizenPanel, type CitizenTab } from './PeoplePanels'
import { GlassSurface, GlassButton, GlassIconButton } from './ui'
import { GodIcon } from './icons'
import { intensityPower, powerIntensity } from './data'
import { personaFor } from './persona'
import { useGodVisuals } from './state'
import type { Hazard } from '../live/types'
import { AGENT_DEMO_LOCKED, AGENT_UNAVAILABLE_MESSAGE } from './demo'
import { cityCommand } from './commands'
import { sendPopulationStimulus, stimulusFromPrompt } from '../populationStimuli'
import { populationEnvironmentAt } from '../populationHazards'
import { usePopulationPlayback } from '../populationLifecycle'
import PopulationPanel from '../shell/PopulationPanel'
import PopulationEvents from '../shell/PopulationEvents'
import PopulationTemperature from '../shell/PopulationTemperature'
import { populationDistrictBounds } from '../babylon/populationDistrict'
import type { GodEventDraft, GodEventKind, GodEventStatus, GodTab, GodTool, GodCitizen } from './model'
import './city.css'

type Panel = 'none' | 'log' | 'events' | 'event-config' | 'event-active' | 'agents' | 'analytics' | 'settings' | 'tools'
/** Menu events that are real live incidents, measured by SUMO (the tornado stays a visual event for now). */
const LIVE_HAZARD: Partial<Record<GodEventKind, Hazard>> = { rain: 'rain', storm: 'storm', flood: 'flood', wildfire: 'fire' }
const LIVE_EVENT_KIND: Partial<Record<Hazard, GodEventKind>> = { rain: 'rain', storm: 'storm', flood: 'flood', fire: 'wildfire' }
const TITLES: Record<ToolId, string> = { area: 'Area select', closure: 'Road closures', development: 'New development', population: 'Population', temperature: 'Temperature', residents: 'AI residents' }

function PanelBox({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <GlassSurface className="gp-utility-panel" role="dialog" aria-label={title}><header><h2>{title}</h2><GlassIconButton icon="close" label={`Close ${title}`} onClick={onClose} /></header><div className="gp-utility-body">{children}</div></GlassSurface>
}

export default function GodCityUI({ world, active, onHome, recordingControls }: { world: WorldScene | null; active: boolean; onHome: () => void; recordingControls?: ReactNode }) {
  const view = useLive()
  const pack = useStore(s => s.pack)
  const tool = useStore(s => s.tool)
  const corridors = useStore(s => s.corridors)
  const selection = useStore(s => s.selection)
  const t = useStore(s => s.t)
  const playing = useStore(s => s.playing)
  const populationActive = useStore(s => s.populationActive)
  const populationDefinition = useStore(s => s.populationDefinition)
  const populationRun = useStore(s => s.runs.find(r => r.run_id === s.primaryRunId))
  const populationReplay = useStore(s => s.primaryRunId ? s.replays[s.primaryRunId] : null)
  const error = useStore(s => s.error)
  const display = useDisplay()
  const events = useGodVisuals(s => s.events)
  const lasers = useGodVisuals(s => s.lasers)
  const lastKind = useGodVisuals(s => s.lastKind)
  const armed = useGodVisuals(s => s.armed)
  const weatherAim = useGodVisuals(s => s.weather)
  const [panelState, setPanel] = useState<Panel>(() => new URLSearchParams(location.search).get('panel') === 'events' ? 'events' : 'none')
  const panel: Panel = tool === 'residents' ? 'tools' : panelState
  const [command, setCommand] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [citizenTab, setCitizenTab] = useState<CitizenTab>('thoughts')
  const [draft, setDraft] = useState<GodEventDraft>({ kind: 'tornado', intensity: 'medium', radiusM: 110, durationS: 300, heading: 90, autoRespond: false })
  const [settings, setSettings] = useState<TornadoSettings>({ ...DEFAULT_TORNADO, drift: true })
  const [crowd, setCrowd] = useState<{ travelers: number; buses: number } | null>(null)
  const [nativeTemperature, setNativeTemperature] = useState(false)
  const sequence = useRef(0)
  const resume = useRef(false)
  const session = populationActive ? null : view.primary?.state
  const counts = liveCountsAt(view, t)
  const environment = session ? environmentAt(session, t) : null
  const residentEnvironment = populationActive ? populationEnvironmentAt(populationReplay?.population?.artifact, t) : null
  const weatherLabel = residentEnvironment?.weatherLabel ?? 'Clear'
  const temperature = populationActive ? residentEnvironment?.temperature : environment?.temperature
  const ready = !!session && !['starting', 'restoring', 'failed'].includes(session.status) && !view.busy
  // SUMO itself alternates between running and paused as it is stepped; the user's play state is what matters
  const statusLabel = view.error ? 'SUMO problem' : view.busy ? view.busy : !session ? 'Starting the city' : session.status === 'starting' || session.status === 'restoring' ? 'Starting SUMO' : session.status === 'completed' ? 'Horizon reached' : session.status === 'failed' ? 'SUMO stopped' : playing ? 'Live · simulating' : 'Live · paused'
  const fresh = crowd ?? { travelers: session?.config.initial_population ?? DEFAULT_LIVE_CONFIG.initial_population, buses: session?.config.fleet_size ?? DEFAULT_LIVE_CONFIG.fleet_size }
  const scope = `${pack?.pack_id ?? ''}:${populationActive ? populationDefinition?.population_id ?? 'native' : session?.session_id ?? ''}`
  useEffect(() => { useGodVisuals.getState().setScope(scope) }, [scope])
  useEffect(() => { world?.plane.clear() }, [world, scope, active])
  useEffect(() => {
    if (!world || !active || !populationActive || !populationDefinition) return
    const bounds = populationDistrictBounds(populationDefinition, world.frame)
    if (bounds) world.camera.flyTo({ target: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2], radius: Math.max(500, Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]) * 1.5), heading: world.camera.pose.heading, elevation: 50 }, 700, 'district')
  }, [world, active, populationActive, populationDefinition])
  useEffect(() => {
    if (!active) return
    const before = document.title
    document.title = 'God’s Plan'
    return () => { document.title = before }
  }, [active])
  useEffect(() => {
    if (!active) return
    const key = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey) return
      const inControl = event.target instanceof Element && !!event.target.closest('button,input,textarea,select,[contenteditable="true"]')
      if (event.code === 'Space' && !inControl && !useGodVisuals.getState().armed && !useStore.getState().populationActive) { event.preventDefault(); live.toggle() }
      // Escape closes whatever is open even while a tab or tool button keeps focus after being clicked
      if (event.key === 'Escape' && !useGodVisuals.getState().armed) { useGodVisuals.getState().setWeather(null); setPanel('none'); useStore.getState().setTool(null); useStore.getState().select(null) }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [active])
  const cancel = () => { useGodVisuals.getState().setArmed(false); useGodVisuals.getState().setWeather(null); if (resume.current && !populationActive) void live.play(); resume.current = false }
  const close = () => { cancel(); setPanel('none'); setNativeTemperature(false); useStore.getState().setTool(null); useStore.getState().select(null) }
  const open = (next: Panel) => { cancel(); setNativeTemperature(false); useStore.getState().select(null); useStore.getState().setTool(null); setNotice(null); setPanel(next) }
  const openTool = (next: ToolId) => {
    cancel(); setNativeTemperature(populationActive && next === 'temperature'); useStore.getState().select(null)
    if (populationActive && next === 'temperature') useStore.getState().setTool(null)
    else useStore.getState().setTool(next)
    setPanel('tools'); setNotice(null)
  }
  const selectEvent = (kind: GodEventKind) => {
    if (kind === 'normal') { useGodVisuals.getState().clear(); world?.plane.clear(); close(); return }
    // road closures and developments are live city tools, reached from the Events menu
    if (kind === 'closure') {
      if (populationActive) { setNotice('Native road closures are not connected yet. Weather warnings and messages can be sent to residents.'); return }
      openTool('closure'); return
    }
    if (kind === 'development') { openTool('development'); return }
    setDraft(d => ({ ...d, kind, radiusM: kind === 'orbital' ? laserRadius(d.radiusM) : kind === 'tornado' ? tornadoRadius(d.radiusM) : d.radiusM, durationS: kind === 'orbital' ? LASER_DURATION : d.kind === 'orbital' ? 300 : d.durationS }))
    open('event-config')
    if (kind === 'orbital') void world?.orbital.prepare().catch(() => setNotice('The laser could not be prepared. Reload the city and try again.'))
  }
  const commandAction = (text: string) => {
    setCommand(text)
    if (/\b(orbital|laser)\b/i.test(text)) { selectEvent('orbital'); return }
    const action = cityCommand(text, AGENT_DEMO_LOCKED)
    if (action === 'plane') {
      if (!world) { setNotice('Wait for the city to finish loading, then send the plane again.'); return }
      close()
      display.set({ shadows: true })
      const pose = world.plane.start(world.camera.pose, world.engine.getAspectRatio(world.camera.cam))
      useStore.getState().setCameraMode('city')
      world.camera.flyTo(pose, 900, 'city')
      setNotice(null)
    } else if (populationActive) {
      if (/^(?:show |open )?(?:agents|residents|swarms|population)$/i.test(text.trim())) openTool('residents')
      else if (action === 'tornado' || action === 'storm' || action === 'rain' || action === 'flood' || action === 'wildfire') selectEvent(action)
      else if (text.trim()) void sendPopulationStimulus(stimulusFromPrompt(text.trim())).then(ok => { if (ok) openTool('residents') })
    } else if (action === 'agents') openTool('residents')
    else if (action === 'tornado' || action === 'storm' || action === 'rain' || action === 'flood' || action === 'wildfire') selectEvent(action)
    else if (action !== 'unsupported') openTool(action)
    else setNotice('Choose a city tool to configure and apply this change. Free-form group objectives are not connected yet.')
  }
  const onTab = (tab: GodTab) => tab === 'agents' ? openTool('residents') : open(tab === 'live' ? 'none' : tab)
  const onTool = (next: GodTool) => {
    if (next === 'map') openTool('area')
    else if (next === 'population') openTool('residents')
    else if (next === 'weather') openTool('temperature')
    else if (next === 'people') openTool('residents')
    else open(next === 'events' ? 'events' : next === 'layers' ? 'settings' : 'none')
  }
  const updateDraft = (patch: Partial<GodEventDraft>) => {
    if (AGENT_DEMO_LOCKED && patch.autoRespond) { setNotice(AGENT_UNAVAILABLE_MESSAGE); return }
    const next = { ...draft, ...patch }
    if (next.kind === 'tornado') { next.radiusM = tornadoRadius(next.radiusM); next.durationS = Math.max(100, Math.min(600, next.durationS)) }
    if (next.kind === 'orbital') { next.radiusM = laserRadius(next.radiusM); next.durationS = LASER_DURATION }
    setDraft(next)
    setSettings(s => ({ ...s, radius: next.radiusM, power: intensityPower(next.intensity), duration: next.durationS / 10, heading: next.heading }))
  }
  const arm = () => {
    if (useGodVisuals.getState().armed) return
    if (!world || (draft.kind !== 'orbital' && (populationActive ? !populationDefinition : !session))) { setNotice(populationActive ? 'Create or select a native swarm before placing an event.' : 'Wait for the live city to finish loading.'); return }
    const hazard = LIVE_HAZARD[draft.kind]
    if (hazard) {
      // a real incident: the cloud follows the cursor and the next click on the city posts it to SUMO
      useStore.getState().setTool(null)
      useStore.getState().select(null)
      useGodVisuals.getState().setWeather({ hazard, radius_m: draft.radiusM, duration_s: draft.durationS, label: '' })
      return
    }
    if (draft.kind !== 'tornado' && draft.kind !== 'orbital') { setNotice('This event interface is ready; its effect is not connected yet.'); return }
    if (draft.kind === 'orbital' ? lasers.length >= MAX_LASER_STRIKES : events.length >= 4) { setNotice('Choose Normal Conditions to clear existing visual events first.'); return }
    if (draft.kind === 'tornado') {
      setSettings(s => ({ ...s, radius: draft.radiusM, power: intensityPower(draft.intensity), duration: draft.durationS / 10, heading: draft.heading }))
      resume.current = !populationActive && clock.playing
      if (populationActive) clock.pause()
      else void live.pause()
    }
    useStore.getState().setTool(null)
    useStore.getState().select(null)
    useGodVisuals.getState().setArmed(true)
  }
  const cast = (point: GroundPoint, direction: [number, number], chosen: TornadoSettings) => {
    if (!world) return
    if (populationActive) {
      const [lon, lat] = world.frame.worldToLonLat(point.x, point.z)
      useGodVisuals.getState().setArmed(false)
      void sendPopulationStimulus({ kind: 'incident', hazard: 'tornado', text: 'A tornado has been reported in this area.', lon, lat, radius_m: chosen.radius, duration_s: Math.round(draft.durationS) }).then(ok => { if (ok) openTool('residents') })
      return
    }
    const id = `god-tornado-${++sequence.current}`
    const track = placedTornado(world.frame, point, direction, chosen, clock.t, id)
    if (useGodVisuals.getState().addEvent({ id, track, area: pack?.name.split(',')[0] ?? 'City centre', intensity: powerIntensity(chosen.power) })) { setPanel('event-active'); resume.current = false; void live.play() }
  }
  const fireLaser = (point: GroundPoint) => {
    if (!world || !useGodVisuals.getState().armed || draft.kind !== 'orbital' || !world.frame.contains(point.x, point.z)) return
    const strike = { id: `god-laser-${crypto.randomUUID()}`, ...point, radius: laserRadius(draft.radiusM), firedAt: performance.now() / 1000 }
    if (useGodVisuals.getState().addLaser({ strike, area: pack?.name.split(',')[0] ?? 'City centre' })) setPanel('event-active')
    else setNotice('Restore an existing laser strike or choose Normal Conditions before firing again.')
  }
  const liveIncident = [...(session?.incidents ?? [])].reverse().find(i => i.hazard in LIVE_EVENT_KIND && t >= i.start_s && t < i.end_s) ?? null
  const laser = lastKind === 'orbital' ? lasers.at(-1) : undefined
  const chosen = lastKind === 'tornado' ? events.at(-1) : undefined
  const liveStatus: GodEventStatus | null = liveIncident ? { id: liveIncident.event_id, kind: LIVE_EVENT_KIND[liveIncident.hazard] ?? 'custom', label: liveIncident.label, area: pack?.name.split(',')[0] ?? 'City centre', start: liveIncident.start_s, end: liveIncident.end_s, radiusM: liveIncident.radius_m, intensity: liveIncident.radius_m >= 300 ? 'high' : liveIncident.radius_m >= 150 ? 'medium' : 'low', affectedBuildings: 0, failedBuildings: 0, affectedAgents: session?.metrics?.swarm?.aware_total ?? null, visualOnly: false } : null
  const status: GodEventStatus | null = liveStatus ?? (chosen ? { id: chosen.id, kind: 'tornado', label: 'Tornado Event', area: chosen.area, start: chosen.track.start_s, end: chosen.track.end_s, radiusM: chosen.track.radius_m, intensity: chosen.intensity, affectedBuildings: world?.storm.storm(chosen.track)?.damage.plan.length ?? 0, failedBuildings: 0, affectedAgents: null, visualOnly: true } : null)
  const focusEvent = () => {
    if (!world) return
    if (liveIncident) { world.camera.flyTo({ target: [liveIncident.x, liveIncident.z], radius: Math.max(600, liveIncident.radius_m * 5), heading: world.camera.pose.heading, elevation: 46 }, 700, 'incident'); return }
    if (chosen) { const [x, z] = world.frame.lonLatToWorld(...chosen.track.waypoints[0]); world.camera.flyTo({ target: [x, z], radius: 1500, heading: world.camera.pose.heading, elevation: 46 }, 700, 'incident') }
  }
  const lastIncidentId = useRef<string | null>(null)
  useEffect(() => {
    // a cast weather event opens its status panel once SUMO reports it
    if (liveIncident && liveIncident.event_id !== lastIncidentId.current) { lastIncidentId.current = liveIncident.event_id; if (panel === 'event-config' || panel === 'none') setPanel('event-active') }
  }, [liveIncident, panel])
  // clicking any traveler opens a hard-coded example persona (name, job, relationships); its activity is SUMO's live state
  const entities = populationActive ? undefined : view.primary?.metadata.entities
  const entity = selection && (selection.kind === 'person' || selection.kind === 'car' || selection.kind === 'bus') ? entities?.find(e => e.id === selection.id) : null
  const citizen: GodCitizen | null = useMemo(() => entity && entities ? personaFor(entity, world?.traffic.poseOf(entity.id) ?? null, pack, entities) : null, [entity, entities, pack, world, t])
  if (!active) return null
  const residentsOpen = tool === 'residents' && (panel === 'none' || panel === 'tools' || panel === 'agents')
  const nativeStatus = populationRun ? `JiuwenSwarm · ${populationRun.status}` : 'Native residents · ready to configure'
  return <>
    <GodChrome recordingControls={recordingControls} city={pack?.name ?? ''} activeTab="live" openTab={panel === 'events' || panel === 'event-config' ? 'events' : panel === 'log' ? 'log'  : panel === 'analytics' ? 'analytics' : null} activeTool={panel === 'agents' || tool === 'residents' ? 'population' : panel.startsWith('event') || tool === 'closure' || tool === 'development' ? 'events' : tool === 'temperature' || nativeTemperature ? 'weather' : tool === 'population' ? 'population' : tool === 'area' ? 'map' : 'select'} dateLabel="" timeLabel={simClock(t)} weatherLabel={weatherLabel} temperatureLabel={temperature == null ? '—' : `${temperature}°C`} weatherNote={populationActive ? 'Applied native observations at the inspected time, not a weather forecast' : 'Simulation temperature, not a weather forecast'} statusLabel={populationActive ? nativeStatus : statusLabel} agentCount={populationActive ? populationDefinition?.spec.count ?? 0 : counts?.total ?? 0} playing={populationActive ? playing : playing || !ready} speed={useStore.getState().speed} speeds={PLAYBACK_SPEEDS} ready={populationActive ? !!populationReplay && populationReplay.tMax > 0 : ready} onSpeed={speed => populationActive ? clock.setSpeed(speed) : live.setSpeed(speed)} is2D={display.projection === 'isometric'} command={command} onTab={onTab} onTool={onTool} onHome={onHome} onCommandChange={setCommand} onCommand={() => commandAction(command)} onSuggestion={commandAction} onTogglePlay={() => { if (populationActive) { usePopulationPlayback.getState().setFollowLive(false); clock.toggle() } else live.toggle() }} onView={() => {}} />
    {panel === 'log' && populationActive && <PanelBox title="Swarm events" onClose={close}><PopulationEvents /></PanelBox>}
    {panel === 'log' && !populationActive && <CityLogPanel session={session ?? null} pack={pack} corridors={corridors} visuals={events} time={t} onClose={close} />}
    {panel === 'events' && <EventMenu onClose={close} onSelect={selectEvent} selectedEvent={liveStatus ? liveStatus.kind : lastKind ?? 'normal'} supportedEvents={populationActive ? ['tornado','rain','storm','flood','wildfire'] : ['normal','closure','development','tornado','orbital','rain','storm','flood','wildfire']} />}
    {panel === 'event-config' && !(armed && draft.kind === 'orbital') && <EventConfigPanel draft={draft} supported={draft.kind === 'tornado' || draft.kind === 'orbital' || draft.kind in LIVE_HAZARD} placing={armed || !!weatherAim} onChange={updateDraft} onCancel={armed || weatherAim ? cancel : close} onPlace={arm} />}
    {armed && world && draft.kind === 'tornado' && <TornadoPlacement scene={world} armed settings={settings} onSettings={patch => { setSettings(s => ({ ...s, ...patch })); setDraft(d => ({ ...d, radiusM: patch.radius ?? d.radiusM, heading: patch.heading ?? d.heading, intensity: patch.power === undefined ? d.intensity : powerIntensity(patch.power) })) }} onCast={cast} onCancel={cancel} />}
    {armed && world && draft.kind === 'orbital' && <OrbitalLaserPlacement scene={world} radius={draft.radiusM} onRadius={radiusM => updateDraft({ radiusM })} onFire={fireLaser} onCancel={cancel} />}
    {panel === 'event-active' && laser && <OrbitalLaserPanel event={laser} onClose={close} onAgain={() => selectEvent('orbital')} onRestore={() => { useGodVisuals.getState().removeLaser(laser.strike.id); setPanel('events') }} />}
    {status && t >= status.start && t <= status.end && <DisasterAlert status={status} onFocus={() => { setPanel('event-active'); focusEvent() }} />}
    {panel === 'event-active' && status && !laser && <ActiveEventPanel status={status} currentTime={t} showControls={status.visualOnly} paused={!playing} onClose={close} onFocus={focusEvent}
      onStop={() => { if (liveStatus) setNotice('A live event runs for its declared duration; it cannot be stopped early.'); else { useGodVisuals.getState().removeEvent(status.id); if (useGodVisuals.getState().events.length === 0) close() } }}
      responsesEnabled onResponse={action => { if (action === 'pause' || action === 'resume') { if (populationActive) clock.toggle(); else live.toggle() } else if (AGENT_DEMO_LOCKED && action !== 'close-roads' && action !== 'redirect-traffic') setNotice(AGENT_UNAVAILABLE_MESSAGE); else openTool('closure') }} onViewImpact={() => { focusEvent(); close() }} />}
    {!populationActive && AGENT_DEMO_LOCKED && panel === 'agents' && !citizen && <PanelBox title="Agents & swarms" onClose={close}><p role="status">{AGENT_UNAVAILABLE_MESSAGE}</p><p className="gp-panel-note">Agent features are unavailable in this demo.</p></PanelBox>}
    {!populationActive && !AGENT_DEMO_LOCKED && panel === 'agents' && !citizen && <LivePeoplePanel channel={view.primary} time={t} onPick={picked => useStore.getState().select(picked)} onClose={close} onCommand={commandAction} />}
    {!populationActive && citizen && <CitizenPanel citizen={citizen} tab={citizenTab} onTab={setCitizenTab} onClose={close} onFollow={() => { const map = leadMap(), pose = world?.traffic.poseOf(citizen.id); if (map && pose && world) cameraTo(agentPose(world.frame.worldToLonLat(pose.x, pose.z), null, currentPose(map)), 'agent') }} onGuide={() => setNotice('Individual guidance is not connected yet.')} onMessage={() => setNotice('Citizen conversations are not connected yet.')} onPerson={id => useStore.getState().select({ kind: 'person', id })} />}
    <div className={citizen ? 'gp-follow-behavior' : 'gp-selection-bubble'}><AgentBubble /></div>
    {residentsOpen && <PanelBox title="Native swarms" onClose={close}><div className="gp-legacy-inline"><PopulationPanel /></div></PanelBox>}
    {nativeTemperature && panel === 'tools' && <PanelBox title="Resident temperature" onClose={close}><PopulationTemperature /><PopulationEvents /></PanelBox>}
    {panel === 'tools' && tool && tool !== 'residents' && <PanelBox title={TITLES[tool]} onClose={close}><div className="gp-legacy-inline"><ToolPanel /></div></PanelBox>}
    {panel === 'settings' && <PanelBox title="City settings" onClose={close}><GlassButton onClick={() => populationActive ? clock.toggle() : live.toggle()}>{playing ? 'Pause playback' : 'Resume playback'}</GlassButton><div className="gp-inline-segment">{PLAYBACK_SPEEDS.map(speed => <GlassButton key={speed} onClick={() => populationActive ? clock.setSpeed(speed) : live.setSpeed(speed)}>{speed}×</GlassButton>)}</div>
      {!populationActive && <><h3 className="gp-section-title">New city</h3>
      <label className="gp-setting-row"><span>Initial travelers</span><input type="number" min={0} max={10000} step={100} value={fresh.travelers} onChange={event => setCrowd({ ...fresh, travelers: Number(event.target.value) })} /></label>
      <label className="gp-setting-row"><span>Shuttle buses</span><input type="number" min={0} max={32} step={1} value={fresh.buses} onChange={event => setCrowd({ ...fresh, buses: Number(event.target.value) })} /></label>
      <GlassButton variant="primary" disabled={!pack || !!view.busy} onClick={() => { if (pack) { void newCity(pack.pack_id, { initial_population: fresh.travelers, fleet_size: fresh.buses }); close() } }}>{view.busy ? 'Working…' : 'Start a fresh city'}</GlassButton>
      <p className="gp-panel-note">Restarts SUMO from the beginning with this crowd. The current city stays saved and listed on the globe.</p></>}
      {populationActive && <GlassButton onClick={() => openTool('residents')}>Configure native swarms</GlassButton>}
      <h3 className="gp-section-title">Appearance</h3>{(['textures','shadows','sharp'] as const).map(key => <label key={key} className="gp-setting-row"><span>{key === 'sharp' ? 'High resolution' : key === 'textures' ? 'Building textures' : 'Shadows'}</span><input type="checkbox" checked={display[key]} onChange={event => display.set({ [key]: event.target.checked })} /></label>)}<GlassButton onClick={() => display.set({ projection: display.projection === 'perspective' ? 'isometric' : 'perspective' })}>Switch to {display.projection === 'perspective' ? '2D' : '3D'}</GlassButton>{!populationActive && <GlassButton onClick={() => openTool('development')}>Add a development</GlassButton>}<GlassButton onClick={() => openTool('residents')}>Native residents</GlassButton></PanelBox>}
    {panel === 'analytics' && populationActive && <PanelBox title="Swarm activity" onClose={close}><p>{populationDefinition?.spec.count ?? 0} native residents · {populationRun?.status ?? 'not started'}</p><PopulationEvents /><GlassButton onClick={() => openTool('residents')}>Inspect residents and model decisions</GlassButton></PanelBox>}
    {panel === 'analytics' && !populationActive && <PanelBox title="City analytics" onClose={close}><div className="gp-kpi-grid">{([['Travelers',counts?.total],['Arrived',counts?.arrived],['Waiting',counts?.waiting]] as const).map(([label,value]) => <div key={label}><span>{label}</span><strong>{value ?? '—'}</strong></div>)}</div><div className="gp-facts"><span>Walking</span><b>{counts?.walking ?? '—'}</b><span>Driving</span><b>{counts?.driving ?? '—'}</b><span>Riding</span><b>{counts?.riding ?? '—'}</b><span>Messages passed</span><b>{session?.metrics?.swarm?.messages ?? '—'}</b><span>Informed agents</span><b>{session?.metrics?.swarm?.aware_total ?? '—'}</b></div><p className="gp-panel-note">Actual live-session measurements. Decorative tornadoes do not change these outcomes.</p></PanelBox>}
    {(notice || error || (!populationActive && view.error)) && <GlassSurface className="gp-toast" role="status"><GodIcon name="info" size={18} /><span>{notice || error || (!populationActive && view.error)}</span><GlassIconButton icon="close" label="Dismiss notification" onClick={() => { setNotice(null); useStore.getState().setError(null); live.discard() }} /></GlassSurface>}
  </>
}
