import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useStore, type ToolId } from '../store'
import { live, useLive, liveCountsAt, environmentAt } from '../live/session'
import { clock, simClock, PLAYBACK_SPEEDS } from '../world/playback'
import { cameraTo, leadMap } from '../world/registry'
import { agentPose, currentPose } from '../world/camera'
import { useDisplay } from '../babylon/display'
import type { WorldScene } from '../babylon/scene'
import TornadoPlacement from '../babylon/TornadoPlacement.tsx'
import { DEFAULT_TORNADO, placedTornado, tornadoRadius, type TornadoSettings, type GroundPoint } from '../babylon/tornadoPlacement'
import ToolPanel from '../shell/ToolPanel'
import AgentBubble from '../shell/AgentBubble'
import GodChrome from './GodChrome'
import LivePeoplePanel from './LivePeoplePanel'
import { EventMenu, EventConfigPanel, ActiveEventPanel, DisasterAlert } from './EventPanels'
import { CitizenPanel, type CitizenTab } from './PeoplePanels'
import { GlassSurface, GlassButton, GlassIconButton } from './ui'
import { GodIcon } from './icons'
import { citizenName, intensityPower, powerIntensity } from './data'
import { useGodVisuals } from './state'
import type { GodEventDraft, GodEventKind, GodEventStatus, GodTab, GodTool, GodCitizen } from './model'
import './city.css'

type Panel = 'none' | 'events' | 'event-config' | 'event-active' | 'agents' | 'analytics' | 'settings' | 'tools'
const TITLES: Record<ToolId, string> = { area: 'Area select', closure: 'Road closures', development: 'New development', population: 'Population', temperature: 'Temperature' }

function PanelBox({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <GlassSurface className="gp-utility-panel" role="dialog" aria-label={title}><header><h2>{title}</h2><GlassIconButton icon="close" label={`Close ${title}`} onClick={onClose} /></header><div className="gp-utility-body">{children}</div></GlassSurface>
}

export default function GodCityUI({ world, active, onHome }: { world: WorldScene | null; active: boolean; onHome: () => void }) {
  const view = useLive()
  const pack = useStore(s => s.pack)
  const tool = useStore(s => s.tool)
  const selection = useStore(s => s.selection)
  const t = useStore(s => s.t)
  const playing = useStore(s => s.playing)
  const error = useStore(s => s.error)
  const display = useDisplay()
  const events = useGodVisuals(s => s.events)
  const armed = useGodVisuals(s => s.armed)
  const [panel, setPanel] = useState<Panel>(() => new URLSearchParams(location.search).get('panel') === 'events' ? 'events' : 'none')
  const [command, setCommand] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [citizenTab, setCitizenTab] = useState<CitizenTab>('thoughts')
  const [draft, setDraft] = useState<GodEventDraft>({ kind: 'tornado', intensity: 'medium', radiusM: 110, durationS: 300, heading: 90, autoRespond: false })
  const [settings, setSettings] = useState<TornadoSettings>({ ...DEFAULT_TORNADO, drift: true })
  const sequence = useRef(0)
  const resume = useRef(false)
  const session = view.primary?.state
  const counts = liveCountsAt(view, t)
  const environment = session ? environmentAt(session, t) : null
  const scope = `${pack?.pack_id ?? ''}:${session?.session_id ?? ''}`
  useEffect(() => { useGodVisuals.getState().setScope(scope) }, [scope])
  useEffect(() => {
    if (!active) return
    const before = document.title
    document.title = 'God’s Plan'
    return () => { document.title = before }
  }, [active])
  useEffect(() => {
    if (!active) return
    const key = (event: KeyboardEvent) => {
      if (event.repeat || event.ctrlKey || event.metaKey || (event.target instanceof Element && event.target.closest('button,input,textarea,select,[contenteditable="true"]'))) return
      if (event.code === 'Space' && !useGodVisuals.getState().armed) { event.preventDefault(); live.toggle() }
      if (event.key === 'Escape' && !useGodVisuals.getState().armed) { setPanel('none'); useStore.getState().setTool(null); useStore.getState().select(null) }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [active])
  const cancel = () => { useGodVisuals.getState().setArmed(false); if (resume.current) void live.play(); resume.current = false }
  const close = () => { cancel(); setPanel('none'); useStore.getState().setTool(null); useStore.getState().select(null) }
  const open = (next: Panel) => { cancel(); useStore.getState().select(null); useStore.getState().setTool(null); setNotice(null); setPanel(next) }
  const openTool = (next: ToolId) => { cancel(); useStore.getState().select(null); useStore.getState().setTool(next); setPanel('tools'); setNotice(null) }
  const selectEvent = (kind: GodEventKind) => {
    if (kind === 'normal') { useGodVisuals.getState().clear(); close(); return }
    setDraft(d => ({ ...d, kind })); open('event-config')
  }
  const commandAction = (text: string) => {
    setCommand(text)
    if (/tornado/i.test(text)) selectEvent('tornado')
    else if (/weather|temperature|cold|heat/i.test(text)) openTool('temperature')
    else if (/population|people|crowd/i.test(text)) openTool('population')
    else if (/build|apartment|park|office|development/i.test(text)) openTool('development')
    else if (/road|close|traffic|bus|transit|gardiner/i.test(text)) openTool('closure')
    else setNotice('Choose a city tool to configure and apply this change. Free-form group objectives are not connected yet.')
  }
  const onTab = (tab: GodTab) => { if (tab === 'simulate') open('settings'); else open(tab === 'live' ? 'none' : tab) }
  const onTool = (next: GodTool) => {
    if (next === 'map') openTool('area')
    else if (next === 'transport') openTool('closure')
    else if (next === 'weather') openTool('temperature')
    else open(next === 'people' ? 'agents' : next === 'events' ? 'events' : next === 'layers' ? 'settings' : 'none')
  }
  const updateDraft = (patch: Partial<GodEventDraft>) => {
    const next = { ...draft, ...patch }
    if (next.kind === 'tornado') { next.radiusM = tornadoRadius(next.radiusM); next.durationS = Math.max(100, Math.min(600, next.durationS)) }
    setDraft(next)
    setSettings(s => ({ ...s, radius: next.radiusM, power: intensityPower(next.intensity), duration: next.durationS / 10, heading: next.heading }))
  }
  const arm = () => {
    if (!world || !session) { setNotice('Wait for the live city to finish loading.'); return }
    if (draft.kind !== 'tornado') { setNotice('This event interface is ready; its effect is not connected yet.'); return }
    if (events.length >= 4) { setNotice('Choose Normal Conditions to clear existing visual events first.'); return }
    resume.current = clock.playing
    void live.pause()
    useStore.getState().setTool(null)
    useStore.getState().select(null)
    useGodVisuals.getState().setArmed(true)
  }
  const cast = (point: GroundPoint, direction: [number, number], chosen: TornadoSettings) => {
    if (!world) return
    const id = `god-tornado-${++sequence.current}`
    const track = placedTornado(world.frame, point, direction, chosen, clock.t, id)
    if (useGodVisuals.getState().addEvent({ id, track, area: pack?.name.split(',')[0] ?? 'City centre', intensity: powerIntensity(chosen.power) })) { setPanel('event-active'); resume.current = false; void live.play() }
  }
  const chosen = events.at(-1)
  const status: GodEventStatus | null = chosen ? { id: chosen.id, kind: 'tornado', label: 'Tornado Event', area: chosen.area, start: chosen.track.start_s, end: chosen.track.end_s, radiusM: chosen.track.radius_m, intensity: chosen.intensity, affectedBuildings: world?.storm.storm(chosen.track)?.damage.plan.length ?? 0, failedBuildings: 0, affectedAgents: null, visualOnly: true } : null
  const focusEvent = () => { if (world && chosen) { const [x, z] = world.frame.lonLatToWorld(...chosen.track.waypoints[0]); world.camera.flyTo({ target: [x, z], radius: 1500, heading: world.camera.pose.heading, elevation: 46 }, 700, 'incident') } }
  const entity = selection?.kind === 'person' ? view.primary?.metadata.entities.find(e => e.id === selection.id) : null
  const citizen: GodCitizen | null = entity ? { id: entity.id, name: citizenName(entity.person_id ?? entity.id), role: 'Synthetic traveler', status: 'Live journey', destination: entity.destination_edge ?? 'Unknown destination', activity: 'Measured in SUMO', synthetic: true, traits: [], thoughts: [], relationships: [] } : null
  if (!active) return null
  return <>
    <GodChrome city={pack?.name ?? ''} activeTab="live" openTab={panel === 'events' || panel === 'event-config' ? 'events' : null} activeTool={panel === 'agents' ? 'people' : panel.startsWith('event') ? 'events' : tool === 'temperature' ? 'weather' : tool === 'closure' ? 'transport' : tool === 'area' ? 'map' : 'select'} dateLabel="" timeLabel={simClock(t)} weatherLabel="Clear" temperatureLabel={environment ? `${environment.temperature}°C` : '—'} weatherNote="Simulation temperature, not a weather forecast" statusLabel="" agentCount={0} playing={playing} is2D={display.projection === 'isometric'} command={command} onTab={onTab} onTool={onTool} onHome={onHome} onCommandChange={setCommand} onCommand={() => commandAction(command)} onSuggestion={commandAction} onTogglePlay={() => live.toggle()} onView={() => {}} />
    {panel === 'events' && <EventMenu onClose={close} onSelect={selectEvent} selectedEvent={chosen ? 'tornado' : 'normal'} supportedEvents={['normal','tornado']} />}
    {panel === 'event-config' && <EventConfigPanel draft={draft} supported={draft.kind === 'tornado'} placing={armed} onChange={updateDraft} onCancel={armed ? cancel : close} onPlace={arm} />}
    {armed && world && <TornadoPlacement scene={world} armed settings={settings} onSettings={patch => { setSettings(s => ({ ...s, ...patch })); setDraft(d => ({ ...d, radiusM: patch.radius ?? d.radiusM, heading: patch.heading ?? d.heading, intensity: patch.power === undefined ? d.intensity : powerIntensity(patch.power) })) }} onCast={cast} onCancel={cancel} />}
    {status && t >= status.start && t <= status.end && <DisasterAlert status={status} onFocus={() => { setPanel('event-active'); focusEvent() }} />}
    {panel === 'event-active' && status && <ActiveEventPanel status={status} currentTime={t} onClose={close} onFocus={focusEvent} onStop={() => useGodVisuals.getState().removeEvent(status.id)} onResponse={() => openTool('closure')} onViewImpact={() => { focusEvent(); close() }} />}
    {panel === 'agents' && !citizen && <LivePeoplePanel channel={view.primary} time={t} onPick={picked => useStore.getState().select(picked)} onClose={close} onCommand={commandAction} />}
    {citizen && <CitizenPanel citizen={citizen} tab={citizenTab} onTab={setCitizenTab} onClose={close} onFollow={() => { const map = leadMap(), pose = world?.traffic.poseOf(citizen.id); if (map && pose && world) cameraTo(agentPose(world.frame.worldToLonLat(pose.x, pose.z), null, currentPose(map)), 'agent') }} onGuide={() => setNotice('Individual guidance is not connected yet.')} onMessage={() => setNotice('Citizen conversations are not connected yet.')} onPerson={id => useStore.getState().select({ kind: 'person', id })} />}
    <div className={citizen ? 'gp-follow-behavior' : 'gp-selection-bubble'}><AgentBubble /></div>
    {panel === 'tools' && tool && <PanelBox title={TITLES[tool]} onClose={close}><div className="gp-inline-segment">{(['area','closure','development','population','temperature'] as ToolId[]).map(id => <GlassButton key={id} onClick={() => openTool(id)}>{id === 'development' ? 'Build' : id === 'temperature' ? 'Temp' : id === 'closure' ? 'Roads' : id === 'population' ? 'People' : 'Areas'}</GlassButton>)}</div><div className="gp-legacy-inline"><ToolPanel /></div></PanelBox>}
    {panel === 'settings' && <PanelBox title="City settings" onClose={close}><GlassButton onClick={() => live.toggle()}>{playing ? 'Pause simulation' : 'Resume simulation'}</GlassButton><div className="gp-inline-segment">{PLAYBACK_SPEEDS.map(speed => <GlassButton key={speed} onClick={() => live.setSpeed(speed)}>{speed}×</GlassButton>)}</div>{(['textures','shadows','sharp'] as const).map(key => <label key={key} className="gp-setting-row"><span>{key === 'sharp' ? 'High resolution' : key === 'textures' ? 'Building textures' : 'Shadows'}</span><input type="checkbox" checked={display[key]} onChange={event => display.set({ [key]: event.target.checked })} /></label>)}<GlassButton onClick={() => display.set({ projection: display.projection === 'perspective' ? 'isometric' : 'perspective' })}>Switch to {display.projection === 'perspective' ? '2D' : '3D'}</GlassButton><GlassButton onClick={() => openTool('development')}>Add a development</GlassButton><GlassButton onClick={() => openTool('population')}>Add travelers</GlassButton></PanelBox>}
    {panel === 'analytics' && <PanelBox title="City analytics" onClose={close}><div className="gp-kpi-grid">{([['Travelers',counts?.total],['Arrived',counts?.arrived],['Waiting',counts?.waiting]] as const).map(([label,value]) => <div key={label}><span>{label}</span><strong>{value ?? '—'}</strong></div>)}</div><div className="gp-facts"><span>Walking</span><b>{counts?.walking ?? '—'}</b><span>Driving</span><b>{counts?.driving ?? '—'}</b><span>Riding</span><b>{counts?.riding ?? '—'}</b><span>Messages passed</span><b>{session?.metrics?.swarm?.messages ?? '—'}</b><span>Informed agents</span><b>{session?.metrics?.swarm?.aware_total ?? '—'}</b></div><p className="gp-panel-note">Actual live-session measurements. Decorative tornadoes do not change these outcomes.</p></PanelBox>}
    {(notice || error || view.error) && <GlassSurface className="gp-toast" role="status"><GodIcon name="info" size={18} /><span>{notice || error || view.error}</span><GlassIconButton icon="close" label="Dismiss notification" onClick={() => { setNotice(null); useStore.getState().setError(null); live.discard() }} /></GlassSurface>}
  </>
}
