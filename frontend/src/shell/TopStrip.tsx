import { environmentAt, useLive } from '../live/session'
import { useStore } from '../store'
import SimulationSettings from './SimulationSettings'
import { BrandMark } from '../components/Icon'

const CITY_NAMES: Record<string, string> = { toronto: 'Toronto', waterloo: 'Waterloo', waterloo_e7: 'Waterloo · E7' }

function sessionStatus(status: string | undefined, playing: boolean, busy: string | null, error: string | null): { label: string; cls: string } {
  if (error) return { label: 'SUMO problem', cls: 'bad' }
  if (busy) return { label: busy, cls: 'busy' }
  if (!status) return { label: 'Starting the city', cls: 'busy' }
  if (status === 'starting' || status === 'restoring') return { label: 'Starting SUMO', cls: 'busy' }
  if (status === 'completed') return { label: 'Horizon reached', cls: 'idle' }
  if (status === 'failed') return { label: 'SUMO stopped', cls: 'bad' }
  // SUMO itself alternates between running and paused as it is advanced in steps; the user's play state is what matters
  return { label: playing ? 'Live · simulating' : 'Live · paused', cls: 'ok' }
}

export default function TopStrip({ onGlobe, active = true }: { onGlobe?: () => void; active?: boolean }) {
  const pack = useStore((s) => s.pack)
  const t = useStore((s) => s.t)
  const playing = useStore((s) => s.playing)
  const { primary, busy, error } = useLive()
  const session = primary?.state ?? null
  const environment = session ? environmentAt(session, t) : null
  const st = sessionStatus(session?.status, playing, busy, error)

  return (
    <header className="strip">
      {onGlobe && <button className="ghostbtn globe-return" onClick={onGlobe} title="Return to the global view"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></svg>Globe</button>}
      <div className="brand">
        <BrandMark size={22} />
        <span className="wordmark">Concrete Consequences</span>
        <span className="city">{pack ? CITY_NAMES[pack.pack_id] ?? pack.name : '—'}</span>
      </div>
      <div className="scenario-name" title={session?.session_id}>
        {environment ? `${environment.population.toLocaleString()} travelers · ${environment.temperature}°C` : 'Live city'}
      </div>
      <div className={`status ${st.cls}`}>
        <i />
        {st.label}
      </div>
      <div className="strip-actions">
        {pack?.pack_id === 'toronto' && <a className="ghostbtn" href="/showcase">Cityscape</a>}
        <SimulationSettings city disabled={!active} showCityAppearance />
      </div>
    </header>
  )
}
