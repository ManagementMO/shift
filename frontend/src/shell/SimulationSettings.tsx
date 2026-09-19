import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import { useStore } from '../store'
import { usePreferences } from '../preferences'
import { useDisplay } from '../babylon/display'
import Icon from '../components/Icon'
import './settings.css'

interface Props {
  disabled?: boolean
  city?: boolean
  showCityAppearance?: boolean
  appearance?: { monochrome: boolean; setMonochrome: (value: boolean) => void }
}

export default function SimulationSettings({ disabled = false, city = false, showCityAppearance = true, appearance }: Props) {
  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [connectionError, setConnectionError] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const titleId = useId()
  const { preferences, update, reset } = usePreferences()
  const display = useDisplay()
  const health = useStore((s) => s.health)
  const visible = open && !disabled

  useEffect(() => {
    if (!visible) return
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      button.current?.focus()
    }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !button.current?.contains(event.target)) setOpen(false)
    }
    window.addEventListener('keydown', key)
    document.addEventListener('pointerdown', outside)
    return () => { window.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside) }
  }, [visible])

  const check = async () => {
    setChecking(true)
    try { useStore.setState({ health: await api.health() }); setConnectionError(false) }
    catch { setConnectionError(true) }
    finally { setChecking(false) }
  }

  const llm = health?.providers.llm
  const elastic = health?.providers.evidence

  return (
    <>
      <button ref={button} className={`settings-trigger ${visible ? 'on' : ''}`} disabled={disabled} aria-label="Settings" aria-haspopup="dialog" aria-expanded={visible} onClick={() => setOpen(!open)}><Icon name="settings" size={16} /><span>Settings</span></button>
      {visible && createPortal(
        <aside ref={panel} className="sim-settings" role="dialog" aria-labelledby={titleId}>
          <header><div><h2 id={titleId}>Settings</h2><p>Set the limits. Explore the consequences.</p></div><button className="settings-close" aria-label="Close settings" onClick={() => { setOpen(false); button.current?.focus() }}><Icon name="close" /></button></header>
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
          {(appearance || showCityAppearance) && <details className="settings-section settings-visuals"><summary><Icon name="display" /><span>Appearance</span><Icon name="chevron" size={14} /></summary>
            {appearance && <div className="settings-row"><label htmlFor={`${titleId}-appearance`}>Globe style</label><select id={`${titleId}-appearance`} value={appearance.monochrome ? 'mono' : 'natural'} onChange={(e) => appearance.setMonochrome(e.target.value === 'mono')}><option value="mono">Monochrome</option><option value="natural">Natural</option></select></div>}
            {showCityAppearance && <><label className="settings-check"><span>City shadows</span><input type="checkbox" checked={display.shadows} onChange={(e) => display.set({ shadows: e.target.checked })} /></label>
            <label className="settings-check"><span>City textures</span><input type="checkbox" checked={display.textures} onChange={(e) => display.set({ textures: e.target.checked })} /></label>
            <label className="settings-check"><span>City high resolution</span><input type="checkbox" checked={display.sharp} onChange={(e) => display.set({ sharp: e.target.checked })} /></label></>}
          </details>}
          <footer><p>Saved on this browser. Applies to new investigations and edit requests; running jobs are unchanged.</p><div><button onClick={reset}>Reset preferences</button>{city && <button onClick={() => { useStore.getState().setLens('diagnostics'); setOpen(false) }}>Diagnostics</button>}</div></footer>
        </aside>, document.body,
      )}
    </>
  )
}
