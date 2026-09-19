import { useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'

const CITY_NAMES: Record<string, string> = { toronto: 'Toronto', waterloo: 'Waterloo' }

function runStatus(status: string | undefined, progress: number | undefined, loading: boolean): { label: string; cls: string } {
  if (loading) return { label: 'Loading replay', cls: 'busy' }
  if (!status) return { label: 'No run', cls: 'idle' }
  if (status === 'completed') return { label: 'Measured replay', cls: 'ok' }
  if (status === 'running') return { label: `Simulating ${Math.round((progress ?? 0) * 100)}%`, cls: 'busy' }
  if (status === 'queued') return { label: 'Queued', cls: 'busy' }
  return { label: status, cls: 'bad' }
}

export default function TopStrip({ onOpenScenarios }: { onOpenScenarios: () => void }) {
  const pack = useStore((s) => s.pack)
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const run = useStore((s) => s.runs.find((r) => r.run_id === s.primaryRunId) ?? s.runs.find((r) => r.status === 'running' || r.status === 'queued'))
  const loading = useStore((s) => s.loadingReplay !== null)
  const compareMode = useStore((s) => s.compareMode)
  const setCompareMode = useStore((s) => s.setCompareMode)
  const lens = useStore((s) => s.lens)
  const setLens = useStore((s) => s.setLens)
  const primaryRunId = useStore((s) => s.primaryRunId)
  const setError = useStore((s) => s.setError)
  const [shared, setShared] = useState<{ href: string; label: string } | null>(null)

  const st = runStatus(run?.status, run?.progress, loading)
  const title = scenario ? shortLabel(scenario.label) : 'No scenario'

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
      <div className="brand">
        <span className="wordmark">CITY<span className="slash">//</span>SHIFT</span>
        <span className="city">{pack ? CITY_NAMES[pack.pack_id] ?? pack.name : '—'}</span>
      </div>
      <button className="scenario-name" onClick={onOpenScenarios} title={scenario?.label}>
        {title}
        <span className="chev">▾</span>
      </button>
      <div className={`status ${st.cls}`}>
        <i />
        {st.label}
      </div>
      <div className="strip-actions">
        {pack?.pack_id === 'toronto' && <a className="ghostbtn" href="/showcase">Cityscape ↗</a>}
        <button className={`ghostbtn ${compareMode ? 'on' : ''}`} onClick={() => setCompareMode(!compareMode)}>
          Compare
        </button>
        <button className="ghostbtn" onClick={() => void share()} disabled={!primaryRunId}>
          {shared ? 'Exported' : 'Share'}
        </button>
        <button className={`ghostbtn ${lens && lens !== 'diagnostics' ? 'on' : ''}`} onClick={() => setLens(lens && lens !== 'diagnostics' ? null : 'people')}>
          Lens
        </button>
        <button className={`ghostbtn ${lens === 'diagnostics' ? 'on' : ''}`} onClick={() => setLens(lens === 'diagnostics' ? null : 'diagnostics')}>
          Developer
        </button>
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
