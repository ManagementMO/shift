import { useEffect } from 'react'
import { useStore } from './store'
import MapView from './components/MapView'
import Timeline from './components/Timeline'
import ScenarioPanel from './components/ScenarioPanel'
import Inspector from './components/Inspector'
import ComparePanel from './components/ComparePanel'
import EditPanel from './components/EditPanel'
import './App.css'

export default function App() {
  const boot = useStore((s) => s.boot)
  const health = useStore((s) => s.health)
  const error = useStore((s) => s.error)
  const setError = useStore((s) => s.setError)
  const toggle = useStore((s) => s.toggle)
  const showCars = useStore((s) => s.showCars)
  const showPersons = useStore((s) => s.showPersons)
  const showRoads = useStore((s) => s.showRoads)
  const pack = useStore((s) => s.pack)

  useEffect(() => {
    void boot()
  }, [boot])

  return (
    <div className="app">
      <header>
        <div className="brand">
          CITY<span>//</span>SHIFT <span className="dim small">finite-fleet scenario lab</span>
        </div>
        <div className="row small">
          {pack && <span className="chip">{pack.name}</span>}
          {health && (
            <>
              <span className="chip">{health.sumo}</span>
              <span className={`chip ${health.providers.llm.available ? '' : 'warn'}`}>
                LLM {health.providers.llm.provider}
              </span>
              <span className={`chip ${health.providers.evidence.available ? '' : 'warn'}`}>
                evidence {health.providers.evidence.available ? health.providers.evidence.provider : 'offline'}
              </span>
              <span className="chip">sentry {health.providers.sentry.enabled ? 'on' : 'off (no DSN)'}</span>
              <span className="chip">share {health.providers.share.mode}</span>
            </>
          )}
          <label className="chip">
            <input type="checkbox" checked={showRoads} onChange={() => toggle('showRoads')} /> roads
          </label>
          <label className="chip">
            <input type="checkbox" checked={showCars} onChange={() => toggle('showCars')} /> cars
          </label>
          <label className="chip">
            <input type="checkbox" checked={showPersons} onChange={() => toggle('showPersons')} /> travelers
          </label>
        </div>
      </header>
      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error} (click to dismiss)
        </div>
      )}
      <main>
        <ScenarioPanel />
        <section className="center">
          <MapView />
          <Timeline />
          <EditPanel />
        </section>
        <aside className="panel right">
          <Inspector />
          <ComparePanel />
        </aside>
      </main>
    </div>
  )
}
