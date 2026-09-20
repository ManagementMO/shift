import { useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import SimulationSettings from './SimulationSettings'
import Icon, { BrandMark } from '../components/Icon'
import type { Renderer } from '../types'

const CITY_NAMES: Record<string, string> = { toronto: 'Toronto', waterloo: 'Waterloo', waterloo_e7: 'Waterloo · E7' }

function runStatus(status: string | undefined, progress: number | undefined, loading: boolean): { label: string; cls: string } {
  if (loading) return { label: 'Loading replay', cls: 'busy' }
  if (!status) return { label: 'No run', cls: 'idle' }
  if (status === 'completed') return { label: 'Measured replay', cls: 'ok' }
  if (status === 'running') return { label: `Simulating ${Math.round((progress ?? 0) * 100)}%`, cls: 'busy' }
  if (status === 'queued') return { label: 'Queued', cls: 'busy' }
  return { label: status, cls: 'bad' }
}

export default function TopStrip({ onOpenScenarios, onGlobe, active = true, renderer = 'babylon' }: { onOpenScenarios: () => void; onGlobe?: () => void; active?: boolean; renderer?: Renderer }) {
  const pack = useStore((s) => s.pack)
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const run = useStore((s) => s.runs.find((r) => r.run_id === s.primaryRunId) ?? s.runs.find((r) => r.status === 'running' || r.status === 'queued'))
  const loading = useStore((s) => s.loadingReplay !== null)
  const hazardPreview = useStore((s) => Boolean(s.ghost?.hazard))
  const lens = useStore((s) => s.lens)
  const setLens = useStore((s) => s.setLens)
  const primaryRunId = useStore((s) => s.primaryRunId)
  const setError = useStore((s) => s.setError)
  const [shared, setShared] = useState<{ href: string; label: string } | null>(null)

  const st = runStatus(run?.status, run?.progress, loading)
  const title = scenario?.parent_scenario_id ? `Branch · ${(scenario.change_set.at(-1) ?? scenario.label).slice(0, 64)}` : scenario ? shortLabel(scenario.label) : 'No scenario'

  const share = async () => {
    if (!primaryRunId) return
    try {
      const r = await api.exportReplay(primaryRunId)
      const href = r.url ?? `/api/exports/${primaryRunId}.zip`
      setShared({ href, label: r.url ? 'Uploaded to R2 — open link' : `Replay bundle ready (${(r.bytes / 1e6).toFixed(1)} MB) — download` })
      setTimeout(() => setShared(null), 12000)
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <header className="strip">
      {onGlobe && <button className="ghostbtn globe-return" onClick={onGlobe} title="Return to the global view"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></svg>Globe</button>}
      <div className="brand">
        <BrandMark size={22} />
        <span className="wordmark">Concrete Consequences</span>
        <span className="city">{pack ? CITY_NAMES[pack.pack_id] ?? pack.name : '—'}</span>
      </div>
      <button className="scenario-name" onClick={onOpenScenarios} title={scenario?.label}>
        {title}
        <span className="chev"><Icon name="chevron" size={13} /></span>
      </button>
      <div className={`status ${st.cls}`}>
        <i />
        {hazardPreview ? 'Visual hazard preview' : st.label}
      </div>
      <div className="strip-actions">
        <a className="ghostbtn" href="/live">Live city</a>
        <a className="ghostbtn" href="/tornado" title="Tornado sandbox · visual effects, separate from measured runs">Tornado</a>
        {pack?.pack_id === 'toronto' && <a className="ghostbtn" href="/showcase">Cityscape</a>}
        <button className="ghostbtn" onClick={() => void share()} disabled={!primaryRunId}>
          {shared ? 'Exported' : 'Share'}
        </button>
        <button className={`ghostbtn ${lens && lens !== 'diagnostics' ? 'on' : ''}`} onClick={() => setLens(lens && lens !== 'diagnostics' ? null : 'people')}>
          Inspect
        </button>
        <SimulationSettings city disabled={!active} showCityAppearance={renderer === 'babylon'} />
      </div>
      {shared && (
        <div className="toast">
          <a href={shared.href} target="_blank" rel="noreferrer">
            {shared.label}
          </a>
        </div>
      )}
    </header>
  )
}

function shortLabel(label: string): string {
  // "Event egress (Toronto, ON (Downtown / Waterfront)) during the X closure; two extra buses for 35 minutes"
  // Branches carry " · edit: <reason>" suffixes; keep the last one visible so a branch never reads as its parent.
  const [head, ...edits] = label.split(' · edit: ')
  const m = head.match(/^(.*?)\s*\(.*?\)\)?\s*(during .*?)(;|$)/)
  let out = m ? `${m[1]} ${m[2]}`.replace(/\s+/g, ' ').trim() : head
  if (out.length > 72) out = `${out.slice(0, 70)}…`
  if (edits.length) {
    const last = edits[edits.length - 1].replace(/\s*\(.*?\)\s*$/, '')
    out += ` · branch: ${last.length > 44 ? `${last.slice(0, 42)}…` : last}`
  }
  return out
}
