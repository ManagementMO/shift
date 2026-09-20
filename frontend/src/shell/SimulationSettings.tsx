import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import { DEFAULT_LIVE_CONFIG, newCity, useLive } from '../live/session'
import { useStore } from '../store'
import { usePreferences } from '../preferences'
import { useDisplay } from '../babylon/display'
import { SWARM_SCALES } from '../babylon/figures'
import Icon from '../components/Icon'
import './settings.css'

interface PanelProps {
  city?: boolean
  showCityAppearance?: boolean
  appearance?: { monochrome: boolean; setMonochrome: (value: boolean) => void }
  onClose?: () => void
}

interface Props extends PanelProps {
  disabled?: boolean
  /** Render the panel permanently in place instead of behind a trigger button. */
  docked?: boolean
}

export function SettingsPanel({ city = false, showCityAppearance = true, appearance, onClose, panelRef, docked = false }: PanelProps & { panelRef?: React.Ref<HTMLElement>; docked?: boolean }) {
  const [checking, setChecking] = useState(false)
  const [connectionError, setConnectionError] = useState(false)
  const titleId = useId()
  const { preferences, update, reset } = usePreferences()
  const display = useDisplay()
  const health = useStore((s) => s.health)
  const pack = useStore((s) => s.pack)
  const { busy, primary } = useLive()
  const [travelers, setTravelers] = useState(primary?.state.config.initial_population ?? DEFAULT_LIVE_CONFIG.initial_population)
  const [buses, setBuses] = useState(primary?.state.config.fleet_size ?? DEFAULT_LIVE_CONFIG.fleet_size)

  useEffect(() => {
    if (health || !docked) return
    let cancelled = false
    api.health().then((value) => { if (!cancelled) useStore.setState({ health: value }) }).catch(() => { if (!cancelled) setConnectionError(true) })
    return () => { cancelled = true }
  }, [health, docked])

  const check = async () => {
    setChecking(true)
    try { useStore.setState({ health: await api.health() }); setConnectionError(false) }
    catch { setConnectionError(true) }
    finally { setChecking(false) }
  }

  const llm = health?.providers.llm
  const elastic = health?.providers.evidence

  return (
    <aside ref={panelRef} className={`sim-settings ${docked ? 'sim-settings-docked' : ''}`} role={docked ? 'region' : 'dialog'} aria-labelledby={titleId}>
      <header><div><h2 id={titleId}>Settings</h2><p>Set the limits. Explore the consequences.</p></div>{onClose && <button className="settings-close" aria-label="Close settings" onClick={onClose}><Icon name="close" /></button>}</header>
      {city && pack && <section className="settings-section">
        <h3><Icon name="swarm" /><span>New city</span><small>{primary ? `${primary.state.config.initial_population.toLocaleString()} travelers now` : 'starting…'}</small></h3>
        <div className="settings-row"><label htmlFor={`${titleId}-travelers`}>Initial travelers</label><input id={`${titleId}-travelers`} type="number" min={0} max={10000} step={100} value={travelers} onChange={(e) => setTravelers(Number(e.target.value))} /></div>
        <div className="settings-row"><label htmlFor={`${titleId}-buses`}>Shuttle buses</label><input id={`${titleId}-buses`} type="number" min={0} max={32} step={1} value={buses} onChange={(e) => setBuses(Number(e.target.value))} /></div>
        <div className="settings-provider"><button disabled={!!busy} onClick={() => { void newCity(pack.pack_id, { initial_population: travelers, fleet_size: buses }); onClose?.() }}>{busy ? 'Working…' : 'Start a fresh city'}</button></div>
        <p className="settings-hint">Restarts SUMO from the beginning with this crowd. The current city stays saved and listed on the globe.</p>
      </section>}
      <section className="settings-section">
        <h3><Icon name="swarm" /><span>Swarm</span><small>{preferences.aiEnabled ? '3 specialists' : 'Local planning'}</small></h3>
        <div className="settings-role-list"><span>Evidence</span><span>Demand</span><span>Planning</span></div>
        <div className="settings-row"><label id={`${titleId}-plans`}>Candidate plans</label><div className="settings-segment" role="group" aria-labelledby={`${titleId}-plans`}>{([1, 2] as const).map((value) => <button key={value} aria-pressed={preferences.candidatePlans === value} onClick={() => update({ candidatePlans: value })}>{value}</button>)}</div></div>
        <p className="settings-hint">Each candidate is validated before it can run.</p>
      </section>
      <section className="settings-section">
        <h3><Icon name="ai" /><span>AI assistance</span><label className="settings-toggle"><input type="checkbox" aria-label="AI assistance" checked={preferences.aiEnabled} onChange={(e) => update({ aiEnabled: e.target.checked })} /><span /></label></h3>
        <div className="settings-provider"><span className={`connection-dot ${llm?.available ? 'available' : ''}`} /><span>{connectionError ? 'Connection unavailable' : llm ? llm.available ? llm.model : 'Model offline' : 'Checking provider…'}</span></div>
        <div className="settings-row"><label htmlFor={`${titleId}-steps`}>Reasoning depth</label><select id={`${titleId}-steps`} value={preferences.reasoningSteps} disabled={!preferences.aiEnabled} onChange={(e) => update({ reasoningSteps: Number(e.target.value) as 2 | 4 | 6 })}><option value={2}>Light · 2 steps</option><option value={4}>Balanced · 4 steps</option><option value={6}>Thorough · 6 steps</option></select></div>
        <p className="settings-hint">{preferences.aiEnabled ? 'Maximum steps per specialist, not a token or billing cap.' : 'No model calls. Uses local planning and rule-based edits.'}</p>
      </section>
      <section className="settings-section">
        <h3><Icon name="database" /><span>Elasticsearch</span><label className="settings-toggle"><input type="checkbox" aria-label="Use Elasticsearch" checked={preferences.useElasticsearch} onChange={(e) => update({ useElasticsearch: e.target.checked })} /><span /></label></h3>
        <div className="settings-provider"><span className={`connection-dot ${elastic?.available ? 'available' : ''}`} /><span>{connectionError ? 'Connection unavailable' : elastic ? elastic.available ? 'Connected' : 'Offline' : 'Checking connection…'}</span><button onClick={() => void check()} disabled={checking}>{checking ? 'Checking…' : 'Check'}</button></div>
        <p className="settings-hint">{!preferences.useElasticsearch ? 'Search the local evidence corpus only.' : elastic?.available ? 'Search indexed city evidence for each investigation.' : 'The local corpus is used while Elasticsearch is unavailable.'}</p>
      </section>
      {(appearance || showCityAppearance) && <details className="settings-section settings-visuals" open={docked}><summary><Icon name="display" /><span>Appearance</span><Icon name="chevron" size={14} /></summary>
        {appearance && <div className="settings-row"><label htmlFor={`${titleId}-appearance`}>Globe style</label><select id={`${titleId}-appearance`} value={appearance.monochrome ? 'mono' : 'natural'} onChange={(e) => appearance.setMonochrome(e.target.value === 'mono')}><option value="mono">Monochrome</option><option value="natural">Natural</option></select></div>}
        {showCityAppearance && <><div className="settings-row"><label htmlFor={`${titleId}-projection`}>City overview</label><select id={`${titleId}-projection`} value={display.projection} onChange={(e) => display.set({ projection: e.target.value as 'perspective' | 'isometric' })}><option value="perspective">Perspective</option><option value="isometric">Isometric</option></select></div>
        <div className="settings-row"><label htmlFor={`${titleId}-lighting`}>City lighting</label><select id={`${titleId}-lighting`} value={display.lighting} onChange={(e) => display.set({ lighting: e.target.value as 'afternoon' | 'golden' })}><option value="afternoon">Afternoon</option><option value="golden">Golden hour</option></select></div>
        <div className="settings-row"><label htmlFor={`${titleId}-swarm`}>Swarm size</label><select id={`${titleId}-swarm`} value={display.swarmScale} onChange={(e) => display.set({ swarmScale: Number(e.target.value) })}>{SWARM_SCALES.map((s) => <option key={s.value} value={s.value}>{s.label} · {s.value}×</option>)}</select></div>
        <label className="settings-check"><span>City shadows</span><input type="checkbox" checked={display.shadows} onChange={(e) => display.set({ shadows: e.target.checked })} /></label>
        <label className="settings-check"><span>City textures</span><input type="checkbox" checked={display.textures} onChange={(e) => display.set({ textures: e.target.checked })} /></label>
        <label className="settings-check"><span>City high resolution</span><input type="checkbox" checked={display.sharp} onChange={(e) => display.set({ sharp: e.target.checked })} /></label></>}
      </details>}
      <footer><p>Saved on this browser. Applies to new investigations and edit requests; running jobs are unchanged.</p><div><button onClick={reset}>Reset preferences</button></div></footer>
    </aside>
  )
}

export default function SimulationSettings({ disabled = false, docked = false, ...panel }: Props) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const visible = open && !disabled

  useEffect(() => {
    if (!visible) return
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      button.current?.focus()
    }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target) && !button.current?.contains(event.target)) setOpen(false)
    }
    window.addEventListener('keydown', key)
    document.addEventListener('pointerdown', outside)
    return () => { window.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside) }
  }, [visible])

  if (docked) return <SettingsPanel {...panel} docked />

  return (
    <>
      <button ref={button} className={`settings-trigger ${visible ? 'on' : ''}`} disabled={disabled} aria-label="Settings" aria-haspopup="dialog" aria-expanded={visible} onClick={() => setOpen(!open)}><Icon name="settings" size={16} /><span>Settings</span></button>
      {visible && createPortal(<SettingsPanel {...panel} panelRef={panelRef} onClose={() => { setOpen(false); button.current?.focus() }} />, document.body)}
    </>
  )
}
