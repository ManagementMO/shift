import { lazy, Suspense, useEffect } from 'react'
import { useLive } from './live/session'
import { useStore } from './store'
import type { WorldScene } from './babylon/scene'
import TopStrip from './shell/TopStrip'
import SimDock from './shell/SimDock'
import ToolRail from './shell/ToolRail'
import ToolPanel from './shell/ToolPanel'
import AgentBubble from './shell/AgentBubble'
import './App.css'

const WorldBabylon = lazy(() => import('./babylon/WorldBabylon'))

/** The live city: one running SUMO simulation under the shell; every tool changes it in place. */
export default function App({ active = true, onGlobe, onWorldReady, onWorldError }: { active?: boolean; onGlobe?: () => void; onWorldReady?: (scene: WorldScene) => void; onWorldError?: (message: string) => void }) {
  const boot = useStore((s) => s.boot)
  const error = useStore((s) => s.error)
  const setError = useStore((s) => s.setError)
  const { busy, error: liveError } = useLive()

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

      <div className="bottom">
        <SimDock active={active} />
      </div>

      {busy && (
        <div className="building">
          <div className="building-card">
            <i />
            <b>{busy}</b>
            <span className="small dim">SUMO is working on the running city.</span>
          </div>
        </div>
      )}

      {(error ?? liveError) && (
        <div className="error" onClick={() => setError(null)}>
          {error ?? liveError}
        </div>
      )}
    </div>
  )
}
