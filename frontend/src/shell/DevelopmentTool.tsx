import type { CSSProperties } from 'react'
import { BUILDING_KIND_ORDER, BUILDING_KINDS, DEVELOPMENT_USES, developmentCounts, developmentDirection, developmentKind, developmentLabel, validDevelopmentGeometry } from '../development'
import { useStore } from '../store'
import type { BuildingKind, Development, DevelopmentSpec } from '../types'
import { fmt } from '../util'
import { currentPose, developmentPose } from '../world/camera'
import { clock } from '../world/playback'
import { cameraTo, leadMap } from '../world/registry'

function frameDevelopment(spec: DevelopmentSpec) {
  if (!validDevelopmentGeometry(spec)) return
  const map = leadMap()
  if (map) cameraTo(developmentPose(spec.position, spec.footprint_m, spec.height_m, currentPose(map)), 'development')
}

/** Little silhouettes for the four tiles; `currentColor` so the tile colour drives them. */
function KindIcon({ kind }: { kind: BuildingKind }) {
  switch (kind) {
    case 'park':
      return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M3 27h26" opacity=".35" strokeWidth="2" stroke="currentColor" fill="none" /><circle cx="11" cy="14" r="6.5" /><circle cx="21" cy="11" r="5" opacity=".75" /><rect x="10" y="18" width="2.2" height="9" rx="1" /><rect x="20" y="15" width="2" height="12" rx="1" opacity=".75" /></svg>
    case 'townhouse':
      return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M2 28V15l4.5-4.5L11 15v13zM11 28V15l4.5-4.5L20 15v13zM20 28V15l4.5-4.5L29 15v13z" /><path d="M5 19h2v3H5zM14 19h2v3h-2zM23 19h2v3h-2z" fill="#fff" opacity=".7" /></svg>
    case 'apartment':
      return <svg viewBox="0 0 32 32" aria-hidden="true"><rect x="7" y="6" width="18" height="22" rx="1.5" /><g fill="#fff" opacity=".7"><rect x="10" y="9" width="3" height="3" /><rect x="15" y="9" width="3" height="3" /><rect x="20" y="9" width="3" height="3" /><rect x="10" y="15" width="3" height="3" /><rect x="15" y="15" width="3" height="3" /><rect x="20" y="15" width="3" height="3" /><rect x="10" y="21" width="3" height="3" /><rect x="20" y="21" width="3" height="3" /></g></svg>
    case 'skyscraper':
      return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M11 29V6l10-3v26z" /><rect x="15.4" y="0.5" width="1.2" height="3" opacity=".7" /><g fill="#fff" opacity=".65"><rect x="13" y="8" width="2" height="2" /><rect x="17" y="7" width="2" height="2" /><rect x="13" y="13" width="2" height="2" /><rect x="17" y="12" width="2" height="2" /><rect x="13" y="18" width="2" height="2" /><rect x="17" y="17" width="2" height="2" /><rect x="13" y="23" width="2" height="2" /><rect x="17" y="22" width="2" height="2" /></g></svg>
  }
}

function Assumptions({ spec }: { spec: DevelopmentSpec }) {
  const counts = developmentCounts(spec)
  const first = developmentDirection(spec) === 'outbound' ? 'leave' : 'arrive'
  return <details className="small development-assumptions"><summary>Declared assumptions</summary>
    <ul>
      <li>{spec.capacity.toLocaleString()} {DEVELOPMENT_USES[spec.land_use].unit}{spec.land_use === 'residential' ? ` × ${spec.people_per_unit} people per home` : ''}</li>
      <li>{Math.round(spec.trip_rate * 100)}% travel in this horizon → {counts.participants.toLocaleString()} travellers {first} between +{fmt(spec.first_wave.start_s)} and +{fmt(spec.first_wave.end_s)} ({spec.first_wave.profile})</li>
      <li>{Math.round(spec.car_share * 100)}% by car, the rest walk or ride within {spec.walk_limit_m.toLocaleString()} m</li>
      <li>Footprint {spec.footprint_m.join(' × ')} m; geometry never sets occupancy</li>
    </ul>
  </details>
}

function DevelopmentDetails({ development }: { development: Development }) {
  const { spec } = development
  const setTool = useStore((s) => s.setTool)
  const counts = developmentCounts(spec)
  const kind = developmentKind(spec)
  return <div className="tool development-tool" style={{ '--kind-color': kind ? BUILDING_KINDS[kind].color : DEVELOPMENT_USES[spec.land_use].color } as CSSProperties}>
    <div className="development-saved-head">
      {kind && <span className="kind-glyph"><KindIcon kind={kind} /></span>}
      <div><span className="development-eyebrow">Saved in this scenario</span><h3>{spec.name}</h3></div>
    </div>
    <div className="development-summary"><b>{counts.trips.toLocaleString()} added one-way trips</b><span>{spec.capacity.toLocaleString()} {DEVELOPMENT_USES[spec.land_use].unit} · {counts.participants.toLocaleString()} travellers · {counts.cars.toLocaleString()} by car</span></div>
    <Assumptions spec={spec} />
    <details className="small"><summary>Network access</summary>
      {development.access.map((a) => <div key={a.mode}>{a.mode === 'passenger' ? 'Car' : 'Walking'} access via <span className="mono">{a.edge_id}</span> · {a.distance_m.toFixed(0)} m away</div>)}
    </details>
    <div className="row wrap">
      <button className="ghostbtn" onClick={() => frameDevelopment(spec)}>Frame building</button>
      <button className="ghostbtn" onClick={() => { clock.seek(spec.first_wave.start_s); frameDevelopment(spec) }}>Show first wave</button>
    </div>
    <button className="ghostbtn" onClick={() => setTool('development')}>Place another</button>
    <div className="small dim">Synthetic one-way trips, not a calibrated forecast. No roads or construction restrictions were added.</div>
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
  const preparing = useStore((s) => s.developmentPreparing)
  const building = useStore((s) => s.building)
  const chooseKind = useStore((s) => s.chooseDevelopmentKind)
  const applyDevelopment = useStore((s) => s.applyDevelopment)
  const setTool = useStore((s) => s.setTool)
  const existing = scenario?.developments?.find((d) => selection?.kind === 'development' && selection.id === d.development_id)
  if (existing) return <DevelopmentDetails development={existing} />
  if (!pack || !draft) return <div className="tool small dim">Loading the city…</div>
  const kind = developmentKind(draft) ?? 'apartment'
  const preset = BUILDING_KINDS[kind]
  const counts = developmentCounts(draft)
  const status = !placed ? 'aim' : previewing || preparing ? 'checking' : error ? 'blocked' : preview ? 'ready' : 'checking'
  return <div className="tool development-tool" style={{ '--kind-color': preset.color } as CSSProperties}>
    <div className="kind-grid" role="radiogroup" aria-label="Building type">
      {BUILDING_KIND_ORDER.map((k) => <button key={k} role="radio" aria-checked={kind === k} aria-label={BUILDING_KINDS[k].label} title={BUILDING_KINDS[k].blurb}
        className={`kind-tile ${kind === k ? 'on' : ''}`} style={{ '--kind-color': BUILDING_KINDS[k].color } as CSSProperties} onClick={() => chooseKind(k)}>
        <span className="kind-glyph"><KindIcon kind={k} /></span>
        <b>{BUILDING_KINDS[k].label}</b>
        <small>{BUILDING_KINDS[k].blurb}</small>
      </button>)}
    </div>

    <div key={status} className={`development-status ${status}`} role="status" aria-live="polite">
      <i aria-hidden="true" />
      {status === 'aim' && <div><b>Move over the map</b><span>The {preset.label.toLowerCase()} outline follows your cursor. Click to place it.</span></div>}
      {status === 'checking' && <div><b>{preparing ? 'Preparing the base city…' : 'Checking street access…'}</b><span>{preparing ? 'Compiling the default crowd so your building has a city to land in.' : 'Validating walking and car access from existing streets.'}</span></div>}
      {status === 'blocked' && <div><b>Can’t build here</b><span>{error}</span><span>Click another spot.</span></div>}
      {status === 'ready' && preview && <div><b>+{preview.added_trips.toLocaleString()} one-way trips</b><span>{preview.outbound_trips.toLocaleString()} leaving · {preview.inbound_trips.toLocaleString()} arriving · {preview.incumbent_trips.toLocaleString()} existing trips untouched</span>
        {preview.development.access.map((a) => <span key={a.mode}>{a.mode === 'passenger' ? 'Car' : 'Walking'} access {a.distance_m.toFixed(0)} m away</span>)}</div>}
    </div>

    <div className="development-summary"><b>{developmentLabel(draft)} · {draft.footprint_m.join(' × ')} m</b><span>{draft.capacity.toLocaleString()} {DEVELOPMENT_USES[draft.land_use].unit} · {counts.trips.toLocaleString()} one-way trips · {counts.cars.toLocaleString()} by car</span></div>
    <Assumptions spec={draft} />

    {status === 'ready' && <div className="development-confirm">
      <button className="primary confirm" disabled={!!building} onClick={() => void applyDevelopment()}>Confirm {preset.label.toLowerCase()}</button>
      <div className="small dim">Creates a new scenario branch and starts its SUMO run. The parent, base map and existing trips stay unchanged.</div>
    </div>}
    <button className="ghostbtn" onClick={() => setTool(null)}>Cancel</button>
    <div className="small dim">Synthetic experiment, not a planning forecast. Existing network access only; no new roads or construction closures.</div>
  </div>
}
