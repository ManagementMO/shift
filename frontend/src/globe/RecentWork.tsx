import { useEffect } from 'react'
import type { LiveSession } from '../live/types'
import type { Location } from './flight'
import { useRecentWork } from './recentItems'

interface Props {
  disabled: boolean
  onOpen: (place: Location, session: LiveSession) => void
}

export default function RecentWork({ disabled, onOpen }: Props) {
  const { items, failed, refresh } = useRecentWork()
  const active = items?.some((item) => item.live) ?? false

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => void refresh(), 4000)
    return () => window.clearInterval(id)
  }, [active, refresh])

  return (
    <aside className="recent-work" aria-labelledby="recent-work-title">
      <header><div><h2 id="recent-work-title">Live cities</h2><p>SUMO cities running or paused on this backend.</p></div><button onClick={() => void refresh()} disabled={disabled} aria-label="Refresh live cities">Refresh</button></header>
      {failed && !items && <div className="recent-empty"><b>Backend unreachable.</b><span>Start the API, then refresh.</span></div>}
      {!failed && items === null && <div className="recent-empty">Loading…</div>}
      {items?.length === 0 && <div className="recent-empty"><b>No cities yet.</b><span>Enter Toronto to start the first one.</span></div>}
      {items && items.length > 0 && (
        <ol className="recent-list">
          {items.map((item) => (
            <li key={item.session.session_id}>
              <button className="recent-item" disabled={disabled} onClick={() => onOpen(item.location, item.session)}>
                <span className="recent-title">{item.title}</span>
                <span className="recent-meta"><span>{item.location.name}</span><i /><span>{item.session.session_id.slice(-6)}</span></span>
                <span className={`recent-status ${item.live ? 'measured' : ''}`}><i />{item.status}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <footer>{failed && items ? 'Showing the last successful load; the backend is currently unreachable.' : 'Selecting a city flies in and continues that simulation.'}</footer>
    </aside>
  )
}
