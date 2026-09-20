import { lazy, Suspense, useEffect } from 'react'
import { useLive } from './live/session'
import { useStore } from './store'
import { shouldPollRuns } from './populationLifecycle'
import type { WorldScene } from './babylon/scene'
import TopStrip from './shell/TopStrip'
import SimDock from './shell/SimDock'
import ToolRail from './shell/ToolRail'
import ToolPanel from './shell/ToolPanel'
import AgentBubble from './shell/AgentBubble'
import PopulationDock from './shell/PopulationDock'
import ResidentDetails from './shell/ResidentDetails'
import './App.css'

const WorldBabylon = lazy(() => import('./babylon/WorldBabylon'))

/** The live city: one running SUMO simulation under the shell; every tool changes it in place. */
export default function App({ active = true, onGlobe, onWorldReady, onWorldError }: { active?: boolean; onGlobe?: () => void; onWorldReady?: (scene: WorldScene) => void; onWorldError?: (message: string) => void }) {
  const boot = useStore((s) => s.boot)
  const error = useStore((s) => s.error)
  const setError = useStore((s) => s.setError)
  const { busy, error: liveError } = useLive()
  const populationActive = useStore(s => s.populationActive)
  const runs = useStore(s => s.runs)
  const refreshRuns = useStore(s => s.refreshRuns)
  const populationBusy = useStore(s => s.building)

  useEffect(() => {
    if (!shouldPollRuns(runs)) return
    const timer = setInterval(() => void refreshRuns(), 1500)
    return () => clearInterval(timer)
  }, [runs, refreshRuns])

  useEffect(() => {
    void boot(new URLSearchParams(window.location.search).get('pack') ?? undefined)
  }, [boot])

  return (
    <div className="shell">
      <div className="worlds">
        <Suspense fallback={null}>
          <WorldBabylon side="solo" active={active} onWorldReady={onWorldReady} onWorldError={onWorldError} />
        </Suspense>
      </div>

      <TopStrip onGlobe={onGlobe} active={active} />

      <ToolRail active={active} />
      <ToolPanel />
      <AgentBubble />
      <ResidentDetails />

      <div className="bottom">
        {populationActive ? <PopulationDock active={active} /> : <SimDock active={active} />}
      </div>

      {(populationBusy || (!populationActive && busy)) && (
        <div className="building">
          <div className="building-card">
            <i />
            <b>{populationBusy ?? busy}</b>
            <span className="small dim">{populationBusy ? 'Preparing the declared population; model execution remains a separate action.' : 'SUMO is working on the running city.'}</span>
          </div>
        </div>
      )}

      {(error ?? (populationActive ? null : liveError)) && (
        <div className="error" onClick={() => setError(null)}>
          {error ?? (populationActive ? null : liveError)}
        </div>
      )}
    </div>
  )
}
