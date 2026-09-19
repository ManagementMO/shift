import { lazy, Suspense, useEffect, useState } from 'react'
import { useStore } from './store'
import WorldMap from './world/WorldMap'
import TopStrip from './shell/TopStrip'
import SimDock from './shell/SimDock'
import ToolRail from './shell/ToolRail'
import ToolPanel from './shell/ToolPanel'
import AgentBubble from './shell/AgentBubble'
import SwarmLens from './shell/SwarmLens'
import ScenarioDrawer from './shell/ScenarioDrawer'
import './App.css'

// Babylon miniature Toronto (`/world`); loaded only when that renderer is chosen so `/` keeps its Mapbox bundle.
const WorldBabylon = lazy(() => import('./babylon/WorldBabylon'))

export type Renderer = 'mapbox' | 'babylon'

export default function App({ renderer = 'mapbox' }: { renderer?: Renderer }) {
  const boot = useStore((s) => s.boot)
  const error = useStore((s) => s.error)
  const setError = useStore((s) => s.setError)
  const building = useStore((s) => s.building)
  const primaryRunId = useStore((s) => s.primaryRunId)
  const runs = useStore((s) => s.runs)
  const refreshRuns = useStore((s) => s.refreshRuns)
  const scenarioId = useStore((s) => s.scenarioId)
  const pack = useStore((s) => s.pack)
  const [drawer, setDrawer] = useState(false)

  useEffect(() => {
    void boot()
  }, [boot])

  // Poll while SUMO is running; when the newest run lands, show it.
  useEffect(() => {
    const active = runs.some((r) => r.status === 'running' || r.status === 'queued')
    if (!active) return
    const id = setInterval(() => void refreshRuns(), 1500)
    return () => clearInterval(id)
  }, [runs, refreshRuns])

  const noRun = pack && scenarioId && !primaryRunId && !runs.some((r) => r.status === 'running' || r.status === 'queued')

  return (
    <div className="shell">
      <div className="worlds">
        {renderer === 'babylon' ? (
          <Suspense fallback={null}>
            <WorldBabylon runId={primaryRunId} side="solo" />
          </Suspense>
        ) : (
          <WorldMap runId={primaryRunId} side="solo" />
        )}
      </div>

      <TopStrip onOpenScenarios={() => setDrawer((d) => !d)} />
      {drawer && <ScenarioDrawer onClose={() => setDrawer(false)} />}

      <ToolRail />
      <ToolPanel />
      <SwarmLens />
      <AgentBubble />

      <div className="bottom">
        <SimDock />
      </div>

      {noRun && (
        <div className="hint">
          No measured run for this scenario yet — open <button onClick={() => setDrawer(true)}>Scenarios</button> and run a plan in SUMO.
        </div>
      )}

      {building && (
        <div className="building">
          <div className="building-card">
            <i />
            <b>{building}</b>
            <span className="small dim">The current world is frozen. A new compiled scenario will load when the branch is ready.</span>
          </div>
        </div>
      )}

      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
    </div>
  )
}
