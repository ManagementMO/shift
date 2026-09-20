import { lazy, Suspense, useEffect, useState } from 'react'
import { useStore } from './store'
import { shouldPollRuns } from './populationLifecycle'
import WorldMap from './world/WorldMap'
import TopStrip from './shell/TopStrip'
import SimDock from './shell/SimDock'
import ToolRail from './shell/ToolRail'
import ToolPanel from './shell/ToolPanel'
import CommandBar from './shell/CommandBar'
import AgentBubble from './shell/AgentBubble'
import CameraModes from './shell/CameraModes'
import SwarmLens from './shell/SwarmLens'
import ScenarioDrawer from './shell/ScenarioDrawer'
import CompareSplit from './shell/CompareSplit'
import './App.css'

// Babylon miniature Toronto (`/world`); loaded only when that renderer is chosen so `/` keeps its Mapbox bundle.
const WorldBabylon = lazy(() => import('./babylon/WorldBabylon'))

export type Renderer = 'mapbox' | 'babylon'

export default function App({ renderer = 'mapbox' }: { renderer?: Renderer }) {
  const boot = useStore((s) => s.boot)
  const error = useStore((s) => s.error)
  const setError = useStore((s) => s.setError)
  const building = useStore((s) => s.building)
  const compareMode = useStore((s) => s.compareMode)
  const primaryRunId = useStore((s) => s.primaryRunId)
  const runs = useStore((s) => s.runs)
  const refreshRuns = useStore((s) => s.refreshRuns)
  const openRun = useStore((s) => s.openRun)
  const scenarioId = useStore((s) => s.scenarioId)
  const population = useStore((s) => s.scenarios.find((sc) => sc.scenario_id === s.scenarioId)?.scenario_kind === 'population')
  const pack = useStore((s) => s.pack)
  const [drawer, setDrawer] = useState(false)

  useEffect(() => {
    void boot()
  }, [boot])

  // Poll while SUMO is running; when the newest run lands, show it.
  useEffect(() => {
    const active = shouldPollRuns(runs)
    if (!active) return
    const id = setInterval(() => void refreshRuns(), 1500)
    return () => clearInterval(id)
  }, [runs, refreshRuns])
  useEffect(() => {
    if (primaryRunId || shouldPollRuns(runs)) return
    const own = runs.filter((r) => r.scenario_id === scenarioId)
    if (population && !['completed', 'paused'].includes(own.at(-1)?.status ?? '')) return
    const done = own.filter((r) => r.status === 'completed' || (population && r.status === 'paused'))
    if (done.length) void openRun(done[done.length - 1].run_id, 'primary')
  }, [runs, primaryRunId, scenarioId, openRun, population])

  const noRun = pack && scenarioId && !primaryRunId && !runs.some((r) => r.status === 'running' || r.status === 'queued')

  return (
    <div className="shell">
      <div className="worlds">
        {compareMode ? (
          <CompareSplit />
        ) : renderer === 'babylon' ? (
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
      <CameraModes />
      <SwarmLens />
      <AgentBubble />

      <div className="bottom">
        <CommandBar />
        <SimDock />
      </div>

      {noRun && (
        <div className="hint">
          {population ? 'No population replay open — use ' : 'No measured run for this scenario yet — open '}<button onClick={() => setDrawer(true)}>Scenarios</button>{population ? ' to explicitly run the society or view saved artifacts.' : ' and run a plan in SUMO.'}
        </div>
      )}

      {building && (
        <div className="building">
          <div className="building-card">
            <i />
            <b>{building}</b>
            <span className="small dim">The current world is paused while the new scenario is prepared. Execution remains a separate action.</span>
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
