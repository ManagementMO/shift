import { useState, type FormEvent } from 'react'

import type { CityPack, Corridor } from '../types'
import { elapsed, environmentAt } from './timeline'
import { alarmRadius, DEFAULT_DURATION, type IncidentSettings } from './incident'
import { HAZARDS, type Hazard, type Intervention, type LivePreview, type LiveSession } from './types'

export type LiveTool = 'road' | 'route' | 'temperature' | 'population' | 'incident'
const titles: Record<LiveTool, string> = { road: 'Change a road', route: 'Add a shuttle route', temperature: 'Change temperature', population: 'Send people downtown', incident: 'Declare an incident' }

interface Props {
  tool: LiveTool
  pack: CityPack
  session: LiveSession
  time: number
  corridors: Record<string, Corridor>
  roads: string[]
  incident: IncidentSettings
  preview: LivePreview | null
  busy: boolean
  error: string | null
  onRoads: (roads: string[]) => void
  onIncident: (settings: IncidentSettings) => void
  onPreview: (change: Intervention) => void
  onApply: () => void
  onDiscard: () => void
  onClose: () => void
}

export default function LiveControls(p: Props) {
  const environment = environmentAt(p.session, p.time)
  const hazard = HAZARDS.find(h => h.id === p.incident.hazard) ?? HAZARDS[0]
  const [roadAction, setRoadAction] = useState<'close_road' | 'reopen_road'>('close_road')
  const [duration, setDuration] = useState(0)
  const [temperature, setTemperature] = useState<number | null>(null)
  const [count, setCount] = useState(5000)
  const [destination, setDestination] = useState(() => p.pack.zones.find(z => /financial|downtown/i.test(z.name))?.zone_id ?? p.pack.zones[0]?.zone_id ?? '')
  const [origin, setOrigin] = useState('')
  const [windowS, setWindowS] = useState(300)
  const [bus, setBus] = useState('')
  const [stopIds, setStopIds] = useState<string[]>(() => {
    const available = p.pack.stops.filter(s => s.allowed)
    const pickup = available.find(s => s.stop_id === 'SB_BREMNER') ?? available[0]
    const target = p.pack.zones.find(z => /financial|downtown/i.test(z.name)) ?? p.pack.zones[0]
    const drop = target ? [...available].filter(s => s.stop_id !== pickup?.stop_id).sort((a, b) => Math.hypot(a.lon - target.lon, a.lat - target.lat) - Math.hypot(b.lon - target.lon, b.lat - target.lat))[0] : available[1]
    return [pickup?.stop_id ?? '', drop?.stop_id ?? '']
  })
  const targetTemperature = temperature ?? environment.temperature
  const fleet = (p.session.fleet ?? []).filter(v => !environment.assignedBuses.has(v.id))
  const selectedBus = fleet.some(v => v.id === bus) ? bus : fleet[0]?.id ?? ''
  const corridor = Object.entries(p.corridors).find(([, value]) => value.edge_ids.length === p.roads.length && value.edge_ids.every(id => p.roads.includes(id)))?.[0] ?? ''

  const submit = (event: FormEvent) => {
    event.preventDefault()
    let change: Intervention
    if (p.tool === 'road') change = { kind: roadAction, edge_ids: p.roads, until_s: roadAction === 'close_road' && duration > 0 ? Math.floor(p.time) + duration * 60 : null }
    else if (p.tool === 'temperature') change = { kind: 'temperature', temperature_c: targetTemperature }
    else if (p.tool === 'route') change = { kind: 'add_bus_route', bus_id: selectedBus, stop_ids: stopIds }
    else if (p.tool === 'incident') {
      if (!p.incident.place) return
      change = { kind: 'incident', hazard: p.incident.hazard, lon: p.incident.place.lon, lat: p.incident.place.lat, radius_m: p.incident.radius_m, duration_s: p.incident.duration_s, label: p.incident.label.trim() || null }
    }
    else change = { kind: 'population', count, destination_zone_id: destination, origin_zone_id: origin || null, release_window_s: windowS }
    p.onPreview(change)
  }

  return <aside className="live-panel" aria-label="Live intervention controls">
    <div className="live-panel-heading"><div><span className="live-eyebrow">At +{elapsed(p.time)}</span><h2>{titles[p.tool]}</h2></div><button className="iconbtn" onClick={p.onClose} aria-label="Close intervention controls">×</button></div>
    {!p.preview && <form onSubmit={submit}>
      {p.tool === 'road' && <>
        <p className="live-help">Choose a named street or click a segment in the city. Sidewalk access is preserved.</p>
        <label>Street<select value={corridor} onChange={e => p.onRoads(p.corridors[e.target.value]?.edge_ids ?? [])}><option value="">Pick in the city</option>{Object.entries(p.corridors).map(([id, value]) => <option key={id} value={id}>{value.label}</option>)}</select></label>
        <div className="live-selection-note">{p.roads.length ? `${p.roads.length} SUMO road segments selected` : 'Click a drivable street to select it'}</div>
        <label>Operation<select value={roadAction} onChange={e => setRoadAction(e.target.value as typeof roadAction)}><option value="close_road">Close to cars and buses</option><option value="reopen_road">Restore original permissions</option></select></label>
        {roadAction === 'close_road' && <label>Reopen after<select value={duration} onChange={e => setDuration(Number(e.target.value))}><option value={0}>Keep closed</option><option value={5}>5 simulated minutes</option><option value={10}>10 simulated minutes</option></select></label>}
      </>}
      {p.tool === 'route' && <>
        <p className="live-help">Allocate a real 60-seat bus. It drives from the venue depot and repeats the stop sequence.</p>
        <label>Available bus<select value={selectedBus} disabled={!fleet.length} onChange={e => setBus(e.target.value)}>{!fleet.length && <option value="">All buses are assigned</option>}{fleet.map(v => <option key={v.id} value={v.id}>{v.id.replace('_', ' ')} · {v.capacity} seats</option>)}</select></label>
        {stopIds.map((id, i) => <label key={i}>{i === 0 ? 'Pickup stop' : `Drop-off ${i}`}<select value={id} onChange={e => setStopIds(ids => ids.map((old, j) => j === i ? e.target.value : old))}>{p.pack.stops.filter(s => s.allowed).map(s => <option key={s.stop_id} value={s.stop_id}>{s.name} · {s.stop_id}</option>)}</select></label>)}
        <div className="live-field-actions"><button type="button" className="ghostbtn" disabled={stopIds.length >= 8} onClick={() => setStopIds(ids => [...ids, p.pack.stops.find(s => s.allowed && !ids.includes(s.stop_id))?.stop_id ?? ''])}>Add stop</button><button type="button" className="ghostbtn" disabled={stopIds.length <= 2} onClick={() => setStopIds(ids => ids.slice(0, -1))}>Remove last</button></div>
        <div className="live-selection-note">{fleet.length} of {p.session.config.fleet_size} buses available at this time</div>
      </>}
      {p.tool === 'temperature' && <>
        <p className="live-help">An explicit cold-response model changes walking speed and tolerance. It does not assume snow or ice.</p>
        <div className="live-temperature"><strong>{targetTemperature}<span>°C</span></strong><button type="button" className="ghostbtn" disabled={targetTemperature <= -40} onClick={() => setTemperature(Math.max(-40, targetTemperature - 20))}>−20°C</button></div>
        <label>Temperature in Celsius<input type="range" min={-40} max={50} step={1} value={targetTemperature} onChange={e => setTemperature(Number(e.target.value))} /></label>
        <div className="live-range-labels"><span>−40°C</span><span>Current {environment.temperature}°C</span><span>50°C</span></div>
        <p className="live-assumption">Illustrative mobility assumptions, not a calibrated weather forecast. Review the exact factors before applying.</p>
      </>}
      {p.tool === 'incident' && <>
        <p className="live-help">Click the city to place it. Travelers within the warning radius witness it; everyone else has to hear it from a neighbour.</p>
        <label>Hazard<select value={p.incident.hazard} onChange={e => p.onIncident({ ...p.incident, hazard: e.target.value as Hazard })}>{HAZARDS.map(h => <option key={h.id} value={h.id}>{h.label}</option>)}</select></label>
        <p className="live-assumption">{hazard.detail} Blocks: {hazard.blocks.toLowerCase()}.</p>
        <label>Footprint radius<input type="range" min={20} max={600} step={10} value={p.incident.radius_m} onChange={e => p.onIncident({ ...p.incident, radius_m: Number(e.target.value) })} /></label>
        <div className="live-range-labels"><span>{p.incident.radius_m} m footprint</span><span>Warning radius {alarmRadius(p.incident)} m</span></div>
        <label>Duration<select value={p.incident.duration_s ?? ''} onChange={e => p.onIncident({ ...p.incident, duration_s: e.target.value ? Number(e.target.value) : null })}><option value="">Typical for this hazard · {Math.round(DEFAULT_DURATION[p.incident.hazard] / 60)} min</option><option value={300}>5 simulated minutes</option><option value={900}>15 simulated minutes</option><option value={1800}>30 simulated minutes</option><option value={3600}>60 simulated minutes</option></select></label>
        <label>Label (optional)<input type="text" maxLength={60} value={p.incident.label} placeholder={hazard.label} onChange={e => p.onIncident({ ...p.incident, label: e.target.value.replace(/[^A-Za-z0-9 ,.'()/&-]/g, '') })} /></label>
        <div className="live-selection-note">{p.incident.place ? `Placed at ${p.incident.place.lat.toFixed(5)}, ${p.incident.place.lon.toFixed(5)}` : 'Click a spot in the city to place the incident'}</div>
      </>}
      {p.tool === 'population' && <>
        <p className="live-help">Add inbound journeys, not a visual crowd multiplier or an instant relocation.</p>
        <label>New travelers<input type="number" min={1} max={10000 - environment.population} step={1} value={count} onChange={e => setCount(Number(e.target.value))} required /></label>
        <label>Destination<select value={destination} onChange={e => setDestination(e.target.value)}>{p.pack.zones.map(z => <option key={z.zone_id} value={z.zone_id}>{z.name}</option>)}</select></label>
        <label>Origins<select value={origin} onChange={e => setOrigin(e.target.value)}><option value="">Distributed across other districts</option>{p.pack.zones.map(z => <option key={z.zone_id} value={z.zone_id}>{z.name}</option>)}</select></label>
        <label>Release window<select value={windowS} onChange={e => setWindowS(Number(e.target.value))}><option value={0}>All at once</option><option value={60}>1 simulated minute</option><option value={300}>5 simulated minutes</option><option value={600}>10 simulated minutes</option></select></label>
        <p className="live-assumption">{Math.round(p.session.config.car_share * 100)}% have car access. The rest walk or use available transit. {environment.population.toLocaleString()} existing travelers stay intact.</p>
      </>}
      <button className="primary live-submit" disabled={p.busy || (p.tool === 'road' && !p.roads.length) || (p.tool === 'route' && !selectedBus) || (p.tool === 'incident' && !p.incident.place)}>Preview change</button>
    </form>}
    {p.error && <div className="live-error" role="alert">{p.error}</div>}
    {p.preview && <section className="live-preview" aria-label="Intervention preview">
      <span className="live-eyebrow">{p.preview.branches_history ? 'Creates a new branch' : 'Applies to the live city'}</span>
      <h3>{p.preview.title}</h3><p>{p.preview.detail}</p>
      {p.tool === 'road' && <p className="live-selection-note">{corridor ? p.corridors[corridor].label : p.roads.join(', ')}</p>}
      {p.preview.stop_names && <ol className="live-stop-list">{p.preview.stop_names.map((name, i) => <li key={i}>{name}</li>)}</ol>}
      {p.preview.edges !== undefined && <dl className="live-model-factors"><div><dt>Street segments inside</dt><dd>{p.preview.edges}</dd></div><div><dt>Warning radius</dt><dd>{p.preview.alarm_radius_m} m</dd></div><div><dt>Duration</dt><dd>{Math.round((p.preview.duration_s ?? 0) / 60)} min</dd></div><div><dt>Closed to</dt><dd>{p.preview.blocks?.includes('pedestrian') ? 'Everyone' : 'Cars and buses'}</dd></div></dl>}
      {p.preview.mobility && <dl className="live-model-factors"><div><dt>Walking speed</dt><dd>×{p.preview.mobility.walk_speed_factor.toFixed(2)}</dd></div><div><dt>Walking tolerance</dt><dd>×{p.preview.mobility.walk_tolerance_factor.toFixed(2)}</dd></div><div><dt>Road speed</dt><dd>Unchanged</dd></div></dl>}
      <p className="live-assumption">{p.preview.assumption}</p>
      {p.preview.branches_history && <p className="live-branch-note">The original timeline is preserved. SUMO restores the seed and earlier commands before this edit.</p>}
      <div className="live-preview-actions"><button className="ghostbtn" disabled={p.busy} onClick={p.onDiscard}>Back to editing</button><button className="primary" disabled={p.busy} onClick={p.onApply}>{p.tool === 'incident' ? 'Declare & play' : 'Apply & play'}</button></div>
    </section>}
  </aside>
}
