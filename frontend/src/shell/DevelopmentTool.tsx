import { useState } from 'react'
import { api } from '../api'
import { DEVELOPMENT_USES, developmentCounts, developmentDirection, developmentError, developmentPreset, validDevelopmentGeometry } from '../development'
import { useStore } from '../store'
import type { Development, DevelopmentSpec, DevelopmentUse, DevelopmentWave } from '../types'
import { fmt } from '../util'
import { currentPose, developmentPose } from '../world/camera'
import { clock } from '../world/playback'
import { cameraTo, leadMap } from '../world/registry'

function frameDevelopment(spec: DevelopmentSpec) {
  if (!validDevelopmentGeometry(spec)) return
  const map = leadMap()
  if (map) cameraTo(developmentPose(spec.position, spec.footprint_m, spec.height_m, currentPose(map)), 'development')
}

function NumberField({ label, value, onChange, min, max, step = 1 }: {
  label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number
}) {
  return <label className="small">{label}<input aria-label={label} type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} /></label>
}

function WaveFields({ label, wave, horizon, onChange }: { label: string; wave: DevelopmentWave; horizon: number; onChange: (wave: DevelopmentWave) => void }) {
  return <fieldset className="development-fields">
    <legend>{label}</legend>
    <div className="development-grid">
      <NumberField label={`${label} start (s)`} value={wave.start_s} min={0} max={horizon - 1} onChange={(start_s) => onChange({ ...wave, start_s })} />
      <NumberField label={`${label} end (s)`} value={wave.end_s} min={1} max={horizon} onChange={(end_s) => onChange({ ...wave, end_s })} />
    </div>
    <label className="small">Departure profile<select value={wave.profile} onChange={(e) => onChange({ ...wave, profile: e.target.value as DevelopmentWave['profile'] })}>
      <option value="uniform">Uniform across window</option><option value="triangular">Triangular, midpoint peak</option>
    </select></label>
  </fieldset>
}

function DevelopmentDetails({ development }: { development: Development }) {
  const { spec } = development
  const setTool = useStore((s) => s.setTool)
  const submitRun = useStore((s) => s.submitRun)
  const counts = developmentCounts(spec)
  return <div className="tool development-tool">
    <span className="development-eyebrow">Persistent scenario development</span>
    <h3>{spec.name}</h3>
    <div className="development-summary"><b>{spec.capacity.toLocaleString()} {DEVELOPMENT_USES[spec.land_use].unit}</b><span>{counts.participants.toLocaleString()} participants · {counts.trips.toLocaleString()} added one-way trips</span></div>
    <div className="small">{spec.capacity} × {spec.people_per_unit} people per unit × {Math.round(spec.trip_rate * 100)}% participation. {Math.round(spec.car_share * 100)}% car share; {spec.walk_limit_m} m walking limit.</div>
    <div className="small">First wave: {developmentDirection(spec)} · +{fmt(spec.first_wave.start_s)}–+{fmt(spec.first_wave.end_s)} · {spec.first_wave.profile}</div>
    {spec.return_wave && <div className="small">Return/dismissal: {developmentDirection(spec, true)} · +{fmt(spec.return_wave.start_s)}–+{fmt(spec.return_wave.end_s)}</div>}
    <div className="small dim">Footprint {spec.footprint_m.join(' × ')} m · display height {spec.height_m} m. Geometry does not imply occupancy.</div>
    <details className="small"><summary>Saved access and assumptions</summary>
      <div>Position: {spec.position.map((n) => n.toFixed(6)).join(', ')} · seed {spec.seed}</div>
      {development.access.map((a) => <div key={a.mode}>{a.mode}: {a.edge_id} ({a.distance_m.toFixed(0)} m from placement)</div>)}
      {Object.entries(spec.zone_shares).map(([zone, share]) => <div key={zone}>{zone}: {(share * 100).toFixed(1)}%</div>)}
    </details>
    <div className="row wrap">
      <button className="ghostbtn" onClick={() => frameDevelopment(spec)}>Frame building</button>
      <button className="ghostbtn" onClick={() => { clock.seek(spec.first_wave.start_s); frameDevelopment(spec) }}>Show first wave</button>
    </div>
    <button className="primary" onClick={() => void submitRun('baseline')}>Run this scenario in SUMO</button>
    <button className="ghostbtn" onClick={() => setTool('development')}>Place another development</button>
    <div className="small dim">Synthetic one-way trips, not a calibrated forecast. Return legs are independent trips. No roads or construction restrictions were added.</div>
  </div>
}

export default function DevelopmentTool() {
  const pack = useStore((s) => s.pack)
  const scenario = useStore((s) => s.scenarios.find((sc) => sc.scenario_id === s.scenarioId) ?? null)
  const selection = useStore((s) => s.selection)
  const draft = useStore((s) => s.developmentDraft)
  const placed = useStore((s) => s.developmentPlaced)
  const preview = useStore((s) => s.developmentPreview)
  const error = useStore((s) => s.developmentError)
  const previewing = useStore((s) => s.developmentPreviewing)
  const building = useStore((s) => s.building)
  const setDraft = useStore((s) => s.setDevelopmentDraft)
  const place = useStore((s) => s.placeDevelopment)
  const previewDevelopment = useStore((s) => s.previewDevelopment)
  const applyDevelopment = useStore((s) => s.applyDevelopment)
  const setTool = useStore((s) => s.setTool)
  const createFlagship = useStore((s) => s.createFlagship)
  const [runAfter, setRunAfter] = useState(false)
  const existing = scenario?.developments?.find((d) => selection?.kind === 'development' && selection.id === d.development_id)
  if (existing) return <DevelopmentDetails development={existing} />
  if (!pack || !scenario || !draft) return <div className="tool">
    <p className="small">Select or create a scenario before placing a development. The development will be saved in a new branch, not in the base city.</p>
    {pack && <button className="primary" onClick={() => void createFlagship(240, 7).then(() => setTool('development'))}>Create base scenario</button>}
  </div>
  const horizon = scenario.constraints.horizon_s
  const update = (changes: Partial<DevelopmentSpec>) => setDraft({ ...draft, ...changes })
  const counts = developmentCounts(draft)
  const problem = developmentError(draft, horizon)
  const firstLabel = draft.land_use === 'residential' ? 'Departures' : 'Arrival-bound trips'
  const returnLabel = draft.land_use === 'residential' ? 'Returns' : draft.land_use === 'school' ? 'Dismissal' : 'Departures'
  const confirm = async () => {
    const child = await applyDevelopment()
    if (child && runAfter) {
      try {
        await api.submitRun(child.scenario_id, 'baseline')
        await useStore.getState().refreshRuns()
      } catch (e) { useStore.getState().setError(String(e)) }
    }
  }
  return <div className="tool development-tool">
    <div className="development-steps"><b>1 Place</b><span>2 Review trips</span><span>3 Confirm</span></div>
    <div className={`development-placement ${placed ? 'placed' : ''}`} role="status">
      <b>{placed ? 'Footprint placed' : 'Click the map to place a building'}</b>
      <span>{placed ? 'Click another location to move it. Nothing is saved yet.' : 'Choose land beside an existing street or walking edge.'}</span>
      {placed && <button className="ghostbtn" onClick={() => frameDevelopment(draft)}>Zoom to placement</button>}
    </div>
    <div className="seg development-presets">
      {(Object.keys(DEVELOPMENT_USES) as DevelopmentUse[]).map((use) => <button key={use} className={draft.land_use === use ? 'on' : ''} onClick={() => setDraft({ ...developmentPreset(pack, horizon, use), position: draft.position })}>{DEVELOPMENT_USES[use].label}</button>)}
    </div>
    <label className="small">Name<input aria-label="Development name" value={draft.name} maxLength={80} onChange={(e) => update({ name: e.target.value })} /></label>
    <NumberField label={`Capacity (${DEVELOPMENT_USES[draft.land_use].unit})`} value={draft.capacity} min={1} max={5000} onChange={(capacity) => update({ capacity })} />
    <details className="small development-section"><summary>Footprint and location</summary>
      <div className="development-grid">
        <NumberField label="Width (m)" value={draft.footprint_m[0]} min={1} max={250} onChange={(width) => update({ footprint_m: [width, draft.footprint_m[1]] })} />
        <NumberField label="Depth (m)" value={draft.footprint_m[1]} min={1} max={250} onChange={(depth) => update({ footprint_m: [draft.footprint_m[0], depth] })} />
        <NumberField label="Display height (m)" value={draft.height_m} min={1} max={300} onChange={(height_m) => update({ height_m })} />
      </div>
      <div className="development-grid">
        <NumberField label="Longitude" value={draft.position[0]} step={0.00001} onChange={(lon) => update({ position: [lon, draft.position[1]] })} />
        <NumberField label="Latitude" value={draft.position[1]} step={0.00001} onChange={(lat) => update({ position: [draft.position[0], lat] })} />
      </div>
      <div className="row"><button className="ghostbtn" onClick={() => place(draft.position)}>Use coordinates</button><button className="ghostbtn" disabled={!placed} onClick={() => frameDevelopment(draft)}>Frame</button></div>
      <p className="dim">Height and footprint are visual only. They never set occupancy or trip counts.</p>
    </details>
    <details className="small development-section" open><summary>Travel assumptions · editable synthetic inputs</summary>
      <div className="development-grid">
        {draft.land_use === 'residential' && <NumberField label="People per unit" value={draft.people_per_unit} min={0.1} max={10} step={0.1} onChange={(people_per_unit) => update({ people_per_unit })} />}
        <NumberField label="Participation (%)" value={draft.trip_rate * 100} min={0.1} max={100} step={0.1} onChange={(n) => update({ trip_rate: n / 100 })} />
        <NumberField label="Car share (%)" value={draft.car_share * 100} min={0} max={100} step={1} onChange={(n) => update({ car_share: n / 100 })} />
        <NumberField label="Walking limit (m)" value={draft.walk_limit_m} min={0} max={10000} step={50} onChange={(walk_limit_m) => update({ walk_limit_m })} />
      </div>
      <WaveFields label={firstLabel} wave={draft.first_wave} horizon={horizon} onChange={(first_wave) => update({ first_wave })} />
      <label className="small check"><input type="checkbox" checked={!!draft.return_wave} onChange={(e) => update({ return_wave: e.target.checked ? { start_s: Math.max(draft.first_wave.end_s, Math.floor(horizon * 0.65)), end_s: horizon, profile: draft.first_wave.profile } : null })} />Include {returnLabel.toLowerCase()} in this horizon</label>
      {draft.return_wave && <WaveFields label={returnLabel} wave={draft.return_wave} horizon={horizon} onChange={(return_wave) => update({ return_wave })} />}
      <p className="dim">Seconds after simulation start, within +{fmt(horizon)}. These are origin departure windows, not guaranteed arrivals. Return legs are separate trips.</p>
      <details><summary>Counterpart zones and seed</summary>
        <p className="dim">{draft.land_use === 'residential' ? 'Where residents travel to' : 'Where commuters or students come from'}. Shares must sum to 100%.</p>
        {pack.zones.map((zone) => <NumberField key={zone.zone_id} label={`${zone.name} (%)`} value={Number(((draft.zone_shares[zone.zone_id] ?? 0) * 100).toFixed(4))} min={0} max={100} step={1} onChange={(n) => update({ zone_shares: { ...draft.zone_shares, [zone.zone_id]: n / 100 } })} />)}
        <NumberField label="Demand seed" value={draft.seed} min={0} max={2147483647} onChange={(seed) => update({ seed })} />
      </details>
    </details>
    <div className="development-summary"><b>{counts.trips.toLocaleString()} added one-way trips</b><span>{counts.participants.toLocaleString()} participants · {counts.cars.toLocaleString()} car trips · not inferred from height</span></div>
    {(problem || error) && <div className="small bad development-error" role="alert">{problem ?? error}</div>}
    {!preview && <button className="primary" disabled={!placed || !!problem || previewing || !!building} onClick={() => void previewDevelopment()}>{previewing ? 'Checking network access…' : 'Preview development'}</button>}
    {preview && <div className="proposal development-confirm">
      <div className="proposal-head"><span className="kind">Validated placement · not applied</span><b>{preview.added_trips.toLocaleString()} new trips, {preview.incumbent_trips.toLocaleString()} existing trips preserved</b></div>
      <div className="small">{preview.outbound_trips} outbound · {preview.inbound_trips} inbound</div>
      {preview.development.access.map((a) => <div className="small" key={a.mode}>{a.mode === 'passenger' ? 'Car' : 'Walking'} access: {a.distance_m.toFixed(0)} m · <span className="mono">{a.edge_id}</span></div>)}
      <details className="small"><summary>Model limits and rounding</summary>{preview.warnings.map((warning) => <p key={warning} className="dim">{warning}</p>)}</details>
      <label className="small check"><input type="checkbox" checked={runAfter} onChange={(e) => setRunAfter(e.target.checked)} />Run the new branch in SUMO after confirming</label>
      <button className="primary" disabled={!!building || !!problem} onClick={() => void confirm()}>Confirm development</button>
      <div className="small dim">Creates a new scenario branch. The parent, base map and existing trips stay unchanged.</div>
    </div>}
    <button className="ghostbtn" onClick={() => setTool(null)}>Cancel placement</button>
    <div className="small dim">Synthetic experiment, not a planning forecast. Existing network access only; no new roads or construction closures.</div>
  </div>
}
