import { useId, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import type { GodEventCategory, GodEventDraft, GodEventKind, GodEventStatus } from './model'
import { EventGlyph, GodIcon } from './icons'
import { LASER_DURATION, LASER_MAX_RADIUS, LASER_MIN_RADIUS, LASER_RADIUS_STEP } from '../babylon/orbitalLaserModel'
import type { VisualLaserEvent } from './state'
import { GlassButton, GlassIconButton, GlassPill, GlassSurface } from './ui'
import './events.css'

export interface EventMenuProps {
  onSelect: (kind: GodEventKind) => void
  onClose: () => void
  category?: GodEventCategory
  onCategoryChange?: (category: GodEventCategory) => void
  selectedEvent?: GodEventKind | null
  onCustomEvent?: () => void
  supportedEvents?: readonly GodEventKind[]
  className?: string
}

export interface EventConfigPanelProps {
  draft: GodEventDraft
  onChange: (patch: Partial<GodEventDraft>) => void
  onPlace: () => void
  onCancel: () => void
  supported: boolean
  placing?: boolean
  className?: string
}

export type EventResponseAction =
  | 'evacuate'
  | 'close-roads'
  | 'redirect-traffic'
  | 'send-rescue'
  | 'toggle-auto-respond'
  | 'pause'
  | 'resume'

export interface EventResponseOption {
  action: EventResponseAction
  label: string
  disabled?: boolean
}

export interface ActiveEventPanelProps {
  status: GodEventStatus
  onClose: () => void
  onFocus: () => void
  onStop: () => void
  onResponse: (action: EventResponseAction) => void
  onViewImpact: () => void
  currentTime?: number
  autoRespond?: boolean
  paused?: boolean
  showControls?: boolean
  responsesEnabled?: boolean
  responseOptions?: readonly EventResponseOption[]
  areaDescription?: string
  impactDescription?: string
  className?: string
}

export interface DisasterAlertProps {
  status: GodEventStatus
  onFocus: () => void
  onAction?: () => void
  message?: string
  className?: string
}

interface EventDefinition {
  label: string
  description: string
  alert: string
}

const eventDefinitions: Record<GodEventKind, EventDefinition> = {
  normal: { label: 'Normal Conditions', description: 'Baseline city conditions', alert: 'City Conditions' },
  closure: { label: 'Road Closure', description: 'Close a street; barricades go up and traffic re-plans', alert: 'Road Closure' },
  development: { label: 'New Development', description: 'Place a building that adds real trips', alert: 'New Development' },
  orbital: { label: 'Orbital Laser', description: 'Fire a green sky beam and clear its radius', alert: 'Orbital Laser' },
  tornado: { label: 'Tornado', description: 'Extreme weather event', alert: 'Severe Weather Event' },
  earthquake: { label: 'Earthquake', description: 'Seismic activity', alert: 'Seismic Event' },
  flood: { label: 'Flood', description: 'Heavy rain and flooding', alert: 'Severe Weather Event' },
  wildfire: { label: 'Wildfire', description: 'Spreading fire', alert: 'Wildfire Warning' },
  outage: { label: 'Power Outage', description: 'Grid disruption', alert: 'Infrastructure Event' },
  riot: { label: 'Riot', description: 'Civil unrest', alert: 'Social Event' },
  transit: { label: 'Transit Disruption', description: 'Service delays', alert: 'Transit Disruption' },
  custom: { label: 'Custom Event', description: 'Tell the city what happens...', alert: 'City Event' },
}

const categories: {
  id: Exclude<GodEventCategory, 'all'>
  label: string
  description: string
  icon: string
  events: readonly GodEventKind[]
}[] = [
  { id: 'natural', label: 'Natural Disasters', description: 'Weather and natural hazards', icon: 'cloud', events: ['tornado', 'earthquake', 'flood', 'wildfire'] },
  { id: 'infrastructure', label: 'Infrastructure', description: 'Roads, buildings, power and transit', icon: 'bolt', events: ['closure', 'development', 'outage', 'transit', 'orbital'] },
  { id: 'social', label: 'Social Events', description: 'Crowds and civil unrest', icon: 'people', events: ['riot'] },
  { id: 'custom', label: 'Custom Event', description: 'Tell the city what happens...', icon: 'sparkles', events: [] },
]

const referenceEvents: readonly GodEventKind[] = ['normal', 'closure', 'development', 'tornado', 'orbital', 'earthquake', 'outage', 'riot', 'transit', 'flood']

const eventIconNames: Record<GodEventKind, string> = {
  normal: 'sun',
  closure: 'route',
  development: 'building',
  tornado: 'tornado',
  earthquake: 'activity',
  flood: 'flood',
  wildfire: 'wildfire',
  outage: 'bolt',
  riot: 'people',
  transit: 'bus',
  orbital: 'warning',
  custom: 'sparkles',
}

const defaultResponses: readonly EventResponseOption[] = [
  { action: 'evacuate', label: 'Evacuate vulnerable areas' },
  { action: 'close-roads', label: 'Close roads in the impacted area' },
  { action: 'redirect-traffic', label: 'Redirect traffic and transit' },
  { action: 'send-rescue', label: 'Send rescue teams to impacted area' },
]

const intensities: readonly GodEventDraft['intensity'][] = ['low', 'medium', 'high']
const numberFormat = new Intl.NumberFormat('en-CA')

function classNames(...values: (string | undefined | false)[]) {
  return values.filter(Boolean).join(' ')
}

function count(value: number) {
  return Number.isFinite(value) && value >= 0 ? numberFormat.format(Math.round(value)) : '—'
}

function duration(seconds: number) {
  if (!Number.isFinite(seconds)) return '—'
  const whole = Math.max(0, Math.ceil(seconds))
  const minutes = Math.floor(whole / 60)
  return `${minutes.toString().padStart(2, '0')}:${(whole % 60).toString().padStart(2, '0')}`
}

function distance(metres: number) {
  if (!Number.isFinite(metres)) return '—'
  return metres >= 1000 ? `${numberFormat.format(Math.round(metres / 100) / 10)} km` : `${count(metres)} m`
}

function dismissOnEscape(event: KeyboardEvent<HTMLDivElement>, onClose: () => void) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  onClose()
}

function sliderStyle(value: number, min: number, max: number): CSSProperties {
  return { '--gp-event-range-fill': `${Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100))}%` } as CSSProperties
}

function EventSwitch({ checked, disabled, label, onChange }: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (checked: boolean) => void
}) {
  return (
    <GlassButton
      type="button"
      variant="ghost"
      className="gp-event-switch"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span>{label}</span>
      <span className="gp-event-switch-track" aria-hidden="true"><span /></span>
    </GlassButton>
  )
}

export function EventMenu({
  onSelect,
  onClose,
  category,
  onCategoryChange,
  selectedEvent,
  onCustomEvent,
  supportedEvents,
  className,
}: EventMenuProps) {
  const id = useId()
  const [expandedCategory, setExpandedCategory] = useState<GodEventCategory>('natural')
  const [browsingCategories, setBrowsingCategories] = useState(false)
  const activeCategory = category ?? expandedCategory
  const showCategories = browsingCategories || (category !== undefined && category !== 'all')

  function selectCategory(next: GodEventCategory) {
    const value = activeCategory === next ? 'all' : next
    setBrowsingCategories(true)
    setExpandedCategory(value)
    onCategoryChange?.(value)
  }

  function toggleCategories() {
    setBrowsingCategories(!showCategories)
    if (showCategories) onCategoryChange?.('all')
  }

  function eventRow(kind: GodEventKind) {
    const definition = eventDefinitions[kind]
    const preview = kind !== 'normal' && supportedEvents !== undefined && !supportedEvents.includes(kind)
    const selected = selectedEvent === undefined ? kind === 'normal' : selectedEvent === kind
    return (
      <GlassButton
        type="button"
        variant="ghost"
        className={classNames('gp-event-menu-row gp-event-choice', !showCategories && 'gp-event-reference-choice', selected && 'gp-event-row-selected')}
        key={kind}
        aria-pressed={selected}
        onClick={() => onSelect(kind)}
      >
        {kind === 'normal' || kind === 'earthquake' || kind === 'outage' || kind === 'closure' || kind === 'development'
          ? <GodIcon name={eventIconNames[kind]} size={36} className={`gp-event-glyph gp-event-glyph-${kind}`} />
          : <EventGlyph kind={kind} size={40} className={`gp-event-glyph gp-event-glyph-${kind}`} />}
        <span className="gp-event-row-copy"><span className="gp-event-row-title">{definition.label}</span><span className="gp-event-row-description">{definition.description}</span></span>
        <span className="gp-event-row-end">{preview && <span className="gp-event-preview-label">Preview</span>}<GodIcon name="chevron-right" size={17} /></span>
      </GlassButton>
    )
  }

  return (
    <GlassSurface
      tone="light"
      className={classNames('gp-event-menu gp-event-popover', className)}
      role="dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-intro`}
      onKeyDown={(event) => dismissOnEscape(event, onClose)}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <header className="gp-event-menu-heading">
        <div className="gp-event-heading-line">
          <h2 id={`${id}-title`}>{showCategories ? 'Create an event' : 'Events'}</h2>
          <div className="gp-event-menu-heading-actions">
            <GlassButton type="button" variant="ghost" className="gp-event-browse-categories" aria-controls={`${id}-choices`} aria-expanded={showCategories} onClick={toggleCategories}>{showCategories ? 'All events' : 'Categories'}<GodIcon name={showCategories ? 'chevron-left' : 'chevron-down'} size={13} /></GlassButton>
            <GlassIconButton icon="close" label="Close events" size={22} className="gp-event-close" autoFocus onClick={onClose} />
          </div>
        </div>
        <p id={`${id}-intro`}>Introduce real-world events to the simulation.</p>
      </header>
      <nav className="gp-event-menu-scroll" id={`${id}-choices`} aria-label={showCategories ? 'Event categories' : 'Events'}>
        {showCategories ? categories.map((item) => {
          const expanded = item.id !== 'custom' && activeCategory === item.id
          return (
            <div className="gp-event-category" key={item.id}>
              <GlassButton
                type="button"
                variant="ghost"
                className={classNames('gp-event-menu-row gp-event-category-row', expanded && 'gp-event-row-selected')}
                aria-expanded={item.id === 'custom' ? undefined : expanded}
                aria-controls={item.id === 'custom' ? undefined : `${id}-${item.id}`}
                onClick={() => item.id === 'custom' ? (onCustomEvent ? onCustomEvent() : onSelect('custom')) : selectCategory(item.id)}
              >
                <span className={`gp-event-category-icon gp-event-category-icon-${item.id}`}><GodIcon name={item.icon} size={34} /></span>
                <span className="gp-event-row-copy"><span className="gp-event-row-title">{item.label}</span><span className="gp-event-row-description">{item.description}</span></span>
                <GodIcon name="chevron-right" size={18} className={classNames('gp-event-row-chevron', expanded && 'gp-event-chevron-open')} />
              </GlassButton>
              {item.id !== 'custom' && <div className="gp-event-submenu" id={`${id}-${item.id}`} hidden={!expanded}>{item.events.map(eventRow)}</div>}
            </div>
          )
        }) : referenceEvents.map(eventRow)}
      </nav>
    </GlassSurface>
  )
}

export function EventConfigPanel({ draft, onChange, onPlace, onCancel, supported, placing = false, className }: EventConfigPanelProps) {
  const id = useId()
  const definition = eventDefinitions[draft.kind]
  const orbital = draft.kind === 'orbital'
  const radiusMin = orbital ? LASER_MIN_RADIUS : draft.kind === 'tornado' ? 30 : 25
  const radiusMax = orbital ? LASER_MAX_RADIUS : draft.kind === 'tornado' ? 240 : 5000
  const radiusStep = orbital ? LASER_RADIUS_STEP : draft.kind === 'tornado' ? 5 : 25
  const durationMin = draft.kind === 'tornado' ? 100 : 15
  const durationMax = draft.kind === 'tornado' ? 600 : 1800

  function changeNumber(key: 'radiusM' | 'durationS', value: number) {
    if (Number.isFinite(value) && value > 0) onChange({ [key]: value })
  }

  return (
    <GlassSurface
      tone="light"
      className={classNames('gp-event-config gp-event-popover', orbital && 'gp-laser-config', className)}
      role="dialog"
      aria-labelledby={`${id}-title`}
      onKeyDown={(event) => dismissOnEscape(event, onCancel)}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <header className="gp-event-config-heading">
        <EventGlyph kind={draft.kind} size={38} className={`gp-event-glyph gp-event-glyph-${draft.kind}`} />
        <div><h2 id={`${id}-title`}>{definition.label}</h2><p>{definition.description}</p></div>
        <GlassIconButton icon="close" label="Cancel event" size={22} className="gp-event-close" autoFocus onClick={onCancel} />
      </header>
      {!supported && <p className="gp-event-preview-notice"><GlassPill>Preview</GlassPill><span>Not connected to the simulation.</span></p>}
      <form className="gp-event-config-form" onSubmit={(event) => { event.preventDefault(); onPlace() }}>
        <div className="gp-event-config-fields">
          <div className="gp-event-field">
            <div className="gp-event-field-heading">
              <label htmlFor={`${id}-radius`}>Size<span>Affected radius</span></label>
              <div className="gp-event-number"><input id={`${id}-radius-number`} type="number" aria-label="Affected radius in metres" min={radiusMin} max={radiusMax} step={radiusStep} value={draft.radiusM} onChange={(event) => changeNumber('radiusM', event.currentTarget.valueAsNumber)} /><span>m</span></div>
            </div>
            <input className="gp-event-range" id={`${id}-radius`} type="range" min={radiusMin} max={radiusMax} step={radiusStep} value={draft.radiusM} aria-valuetext={distance(draft.radiusM)} style={sliderStyle(draft.radiusM, radiusMin, radiusMax)} onChange={(event) => changeNumber('radiusM', event.currentTarget.valueAsNumber)} />
            <div className="gp-event-range-labels" aria-hidden="true"><span>{distance(radiusMin)}</span><span>{distance(radiusMax)}</span></div>
          </div>
          {!orbital && <><fieldset className="gp-event-field gp-event-power">
            <legend>Power</legend>
            <div className="gp-event-segments" aria-label="Event intensity">
              {intensities.map((intensity) => <GlassButton type="button" variant="ghost" key={intensity} aria-pressed={draft.intensity === intensity} onClick={() => onChange({ intensity })}>{intensity}</GlassButton>)}
            </div>
            <p className="gp-event-field-help">Controls the intensity of the event.</p>
          </fieldset>
          <div className="gp-event-field">
            <div className="gp-event-field-heading">
              <label htmlFor={`${id}-duration`}>Lifetime<span>How long the event lasts</span></label>
              <div className="gp-event-number"><input id={`${id}-duration-number`} type="number" aria-label="Event lifetime in seconds" min={durationMin} max={durationMax} step={5} value={draft.durationS} onChange={(event) => changeNumber('durationS', event.currentTarget.valueAsNumber)} /><span>sec</span></div>
            </div>
            <input className="gp-event-range" id={`${id}-duration`} type="range" min={durationMin} max={durationMax} step={5} value={draft.durationS} aria-valuetext={`${draft.durationS} seconds`} style={sliderStyle(draft.durationS, durationMin, durationMax)} onChange={(event) => changeNumber('durationS', event.currentTarget.valueAsNumber)} />
            <div className="gp-event-range-labels" aria-hidden="true"><span>{duration(durationMin)}</span><span>{duration(draft.durationS)}</span><span>{duration(durationMax)}</span></div>
          </div>
          <EventSwitch label="Auto-respond" checked={draft.autoRespond} disabled={!supported} onChange={(autoRespond) => onChange({ autoRespond })} /></>}
          {orbital && <p className="gp-event-field-help">A {LASER_DURATION}-second green beam clears this part of the scene. Saved city and transport data stay unchanged. Normal Conditions restores the area.</p>}
        </div>
        <div className="gp-event-placement-hint" id={`${id}-hint`}>
          <GodIcon name="pin" size={21} />
          <div><strong>{orbital ? 'Choose your target' : placing ? 'Choose a location on the map' : 'Place it anywhere in the city'}</strong><p>{orbital ? 'Choose a radius, click a target on the map, then fire when ready.' : supported ? 'Choose a spot on the map, then click to place your event.' : 'Preview placement only. Simulation effects are not connected.'}</p></div>
        </div>
        <div className="gp-event-config-actions">
          <GlassButton type="button" variant="secondary" onClick={onCancel}>Cancel</GlassButton>
          <GlassButton type="submit" variant="primary" disabled={placing} aria-describedby={`${id}-hint`}><GodIcon name="pin" size={18} />{orbital ? 'Choose target' : placing ? 'Choose location' : supported ? 'Place event' : 'Preview on map'}</GlassButton>
        </div>
      </form>
    </GlassSurface>
  )
}

export function OrbitalLaserPanel({ event, onClose, onRestore, onAgain }: {
  event: VisualLaserEvent
  onClose: () => void
  onRestore: () => void
  onAgain: () => void
}) {
  const { strike, impact } = event
  return <GlassSurface className="gp-utility-panel gp-laser-result" role="dialog" aria-label="Orbital laser result" onKeyDown={event => dismissOnEscape(event, onClose)}>
    <header><EventGlyph kind="orbital" size={28} /><h2>Orbital Laser</h2><GlassIconButton icon="close" label="Close laser details" onClick={onClose} /></header>
    <div className="gp-utility-body">
      <p className="gp-laser-status" role="status">{impact ? 'Strike complete — area cleared' : 'Firing from orbit…'}</p>
      <div className="gp-facts"><span>Radius</span><b>{distance(strike.radius)}</b>{impact && <><span>Buildings cleared</span><b>{count(impact.buildings + impact.developments)}</b><span>People / vehicles cleared</span><b>{count(impact.entities)}</b></>}</div>
      <p className="gp-panel-note">Local visual event. Transport keeps simulating; saved city data stays unchanged. Restore this strike or choose Normal Conditions to bring the scene back.</p>
      <div className="gp-laser-actions"><GlassButton onClick={onRestore}>{impact ? 'Restore area' : 'Cancel strike'}</GlassButton><GlassButton variant="primary" disabled={!impact} onClick={onAgain}>Fire another</GlassButton></div>
    </div>
  </GlassSurface>
}

export function ActiveEventPanel({
  status,
  onClose,
  onFocus,
  onStop,
  onResponse,
  onViewImpact,
  currentTime,
  autoRespond = false,
  paused = false,
  showControls = false,
  responsesEnabled,
  responseOptions = defaultResponses,
  areaDescription,
  impactDescription,
  className,
}: ActiveEventPanelProps) {
  const id = useId()
  const definition = eventDefinitions[status.kind]
  const totalDuration = Math.max(0, status.end - status.start)
  const remaining = currentTime === undefined ? totalDuration : Math.min(totalDuration, Math.max(0, status.end - currentTime))
  const ended = currentTime !== undefined && currentTime >= status.end
  const canRespond = (responsesEnabled ?? !status.visualOnly) && !ended
  const label = ended ? 'Ended' : paused ? 'Paused' : 'Active'
  const hasPeopleEstimate = status.affectedAgents !== null && Number.isFinite(status.affectedAgents) && status.affectedAgents >= 0
  const impact = status.visualOnly
    ? `${count(status.affectedBuildings)} buildings in radius`
    : hasPeopleEstimate
      ? `~${count(status.affectedAgents!)} ${status.affectedAgents === 1 ? 'person' : 'people'}`
      : `${count(status.affectedBuildings)} buildings`
  const impactDetail = impactDescription ?? (status.visualOnly
    ? 'Visual preview · population impact unavailable'
    : `${count(status.affectedBuildings)} affected · ${count(status.failedBuildings)} disrupted buildings`)

  return (
    <GlassSurface
      tone="dark"
      className={classNames('gp-event-active', className)}
      role="dialog"
      aria-labelledby={`${id}-title`}
      data-preview={status.visualOnly || undefined}
      onKeyDown={(event) => dismissOnEscape(event, onClose)}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <header className="gp-event-active-heading">
        <GodIcon name={eventIconNames[status.kind]} size={34} className="gp-event-active-glyph" />
        <h2 id={`${id}-title`}>{status.label || `${definition.label} Event`}</h2>
        <GlassPill className="gp-event-status" data-state={label.toLowerCase()}><span className="gp-event-status-dot" aria-hidden="true" />{label}</GlassPill>
        <GlassIconButton icon="close" label="Close event details" size={18} className="gp-event-close" onClick={onClose} />
      </header>
      <div className="gp-event-active-scroll">
        <dl className="gp-event-facts">
          <div className="gp-event-fact gp-event-area">
            <dt><GodIcon name="pin" size={25} /><span>Impacted Area</span></dt>
            <dd><GlassButton type="button" variant="ghost" className="gp-event-area-focus" onClick={onFocus} title="View live map">{status.area || 'Selected area'}<GodIcon name="locate" size={15} /></GlassButton>{areaDescription && <span className="gp-event-fact-detail">{areaDescription}</span>}</dd>
          </div>
          <div className="gp-event-fact gp-event-severity">
            <dt><GodIcon name="chart" size={25} /><span>Severity</span></dt>
            <dd><strong className="gp-event-intensity" data-intensity={status.intensity}>{status.intensity}</strong><span className="gp-event-fact-detail">{definition.description}</span></dd>
          </div>
        </dl>
        {showControls && <div className="gp-event-live-metrics">
          <div><GodIcon name="clock" size={17} /><span>{currentTime === undefined ? 'Duration' : 'Time remaining'}</span><strong>{duration(remaining)}</strong></div>
          <div><GodIcon name="radius" size={17} /><span>Radius</span><strong>{distance(status.radiusM)}</strong></div>
        </div>}
        <dl className="gp-event-facts">
          <div className="gp-event-fact gp-event-impact">
            <dt><GodIcon name="people" size={25} /><span>Estimated Impact</span></dt>
            <dd><strong>{impact}</strong><span className="gp-event-fact-detail">{impactDetail}</span></dd>
          </div>
        </dl>
        <section className="gp-event-responses" aria-labelledby={`${id}-responses`}>
          <div className="gp-event-response-heading"><GodIcon name="clipboard" size={23} /><h3 id={`${id}-responses`}>Recommended Actions</h3>{!canRespond && <span className="gp-event-response-unavailable">{ended ? 'Ended' : 'Not connected'}</span>}</div>
          <ul>
            {responseOptions.map((response) => (
              <li key={response.action}><GlassButton type="button" variant="ghost" className="gp-event-response-action" disabled={!canRespond || response.disabled} onClick={() => onResponse(response.action)}><span className="gp-event-response-bullet" aria-hidden="true">•</span><span>{response.label}</span><GodIcon name="arrow-right" size={15} /></GlassButton></li>
            ))}
          </ul>
          {showControls && <EventSwitch label="Auto-respond" checked={autoRespond} disabled={!canRespond} onChange={() => onResponse('toggle-auto-respond')} />}
        </section>
      </div>
      <footer className="gp-event-active-footer">
        {showControls && <div className="gp-event-control-actions">
          <GlassButton type="button" variant="secondary" disabled={ended} onClick={() => onResponse(paused ? 'resume' : 'pause')}><GodIcon name={paused ? 'play' : 'pause'} size={16} />{paused ? 'Resume' : 'Pause'}</GlassButton>
          <GlassButton type="button" variant="danger" onClick={onStop}><GodIcon name="stop" size={15} />End event</GlassButton>
        </div>}
        <GlassButton type="button" variant="secondary" className="gp-event-view-impact" onClick={onViewImpact}><span>View live map</span><GodIcon name="arrow-right" size={21} /></GlassButton>
      </footer>
    </GlassSurface>
  )
}

export function DisasterAlert({ status, onFocus, onAction, message, className }: DisasterAlertProps) {
  const definition = eventDefinitions[status.kind]
  const area = status.area ? ` in ${status.area}` : ''
  const description = message ?? `${definition.label} ${status.visualOnly ? 'preview' : 'reported'}${area}`

  return (
    <GlassSurface
      tone="dark"
      className={classNames('gp-event-alert', className)}
      role="status"
      aria-live="polite"
      data-preview={status.visualOnly || undefined}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <GlassButton type="button" variant="ghost" className="gp-event-alert-action" onClick={onAction ?? onFocus} aria-label={`${description}. View event on map.`}>
        <GodIcon name="warning" size={31} className="gp-event-alert-icon" />
        <strong className="gp-event-alert-title">{definition.alert}</strong>
        <span className="gp-event-alert-divider" aria-hidden="true" />
        <span className="gp-event-alert-message">{description}</span>
        <span className="gp-event-alert-live"><span className="gp-event-status-dot" />{status.visualOnly ? 'Visual' : 'Live'}</span>
        <GodIcon name="chevron-right" size={23} className="gp-event-alert-chevron" />
      </GlassButton>
    </GlassSurface>
  )
}
