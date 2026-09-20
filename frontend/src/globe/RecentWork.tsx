import { useEffect } from 'react'
import type { ScenarioSpec } from '../types'
import type { Location } from './flight'
import { relativeTime, useRecentWork } from './recentItems'

interface Props {
  disabled: boolean
  onOpen: (place: Location, scenario: ScenarioSpec) => void
}

export default function RecentWork({ disabled, onOpen }: Props) {
  const { items, failed, loadedAt, refresh } = useRecentWork()
  const active = items?.some((item) => item.run?.status === 'running' || item.run?.status === 'queued') ?? false

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => void refresh(), 4000)
    return () => window.clearInterval(id)
  }, [active, refresh])

  return (
    <aside className="recent-work" aria-labelledby="recent-work-title">
      <header><div><h2 id="recent-work-title">Recent work</h2><p>Scenarios and measured runs on this backend.</p></div><button onClick={() => void refresh()} disabled={disabled} aria-label="Refresh recent work">Refresh</button></header>
      {failed && !items && <div className="recent-empty"><b>Backend unreachable.</b><span>Start the API, then refresh.</span></div>}
      {!failed && items === null && <div className="recent-empty">Loading…</div>}
      {items?.length === 0 && <div className="recent-empty"><b>No scenarios yet.</b><span>Enter Toronto to create the first one.</span></div>}
      {items && items.length > 0 && (
        <ol className="recent-list">
          {items.map((item) => (
            <li key={item.scenario.scenario_id}>
              <button className="recent-item" disabled={disabled} onClick={() => onOpen(item.location, item.scenario)}>
                <span className="recent-title">{item.title}</span>
                {item.branch && <span className="recent-branch">Branch · {item.branch}</span>}
                <span className="recent-meta"><span>{item.location.name}</span><i /><span>{relativeTime(item.createdAt, loadedAt)}</span></span>
                <span className={`recent-status ${item.measured ? 'measured' : ''} ${item.run?.status === 'running' || item.run?.status === 'queued' ? 'busy' : ''}`}><i />{item.status}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <footer>{failed && items ? 'Showing the last successful load; the backend is currently unreachable.' : 'Selecting a scenario flies into its city with the scenario loaded.'}</footer>
    </aside>
  )
}
