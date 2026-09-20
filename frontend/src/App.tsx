import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { useLive } from './live/session'
import { useStore } from './store'
import { shouldPollRuns } from './populationLifecycle'
import type { WorldScene } from './babylon/scene'
import GodCityUI from './gods-plan/GodCityUI'
import { GlassSurface } from './gods-plan/ui'
import PopulationDock from './shell/PopulationDock'
import ResidentDetails from './shell/ResidentDetails'
import './App.css'

const WorldBabylon = lazy(() => import('./babylon/WorldBabylon'))

/**
 * The live city: one running SUMO simulation under the shell; every tool changes it in place.  With an AI-resident
 * population active, the recorded resident history is played back instead and the resident panels take over.
 */
export default function App({ active = true, onGlobe, onWorldReady, onWorldError }: { active?: boolean; onGlobe?: () => void; onWorldReady?: (scene: WorldScene) => void; onWorldError?: (message: string) => void }) {
  const boot = useStore((s) => s.boot)
  const { busy } = useLive()
  const populationActive = useStore((s) => s.populationActive)
  const runs = useStore((s) => s.runs)
  const refreshRuns = useStore((s) => s.refreshRuns)
  const populationBusy = useStore((s) => s.building)
  const [world, setWorld] = useState<WorldScene | null>(null)
  const ready = useCallback((scene: WorldScene) => { setWorld(scene); onWorldReady?.(scene) }, [onWorldReady])

  useEffect(() => {
    if (!shouldPollRuns(runs)) return
    const timer = setInterval(() => void refreshRuns(), 1500)
    return () => clearInterval(timer)
  }, [runs, refreshRuns])

  useEffect(() => {
    void boot(new URLSearchParams(window.location.search).get('pack') ?? undefined)
  }, [boot])

  const working = populationBusy ?? (populationActive ? null : busy)

  return (
    <div className="shell gp-shell" data-population-active={populationActive || undefined}>
      <div className="worlds">
        <Suspense fallback={null}>
          <WorldBabylon side="solo" active={active} onWorldReady={ready} onWorldError={onWorldError} />
        </Suspense>
      </div>
      <GodCityUI world={world} active={active} onHome={onGlobe ?? (() => { window.location.href = '/' })} />
      <ResidentDetails />
      {populationActive && active && <div className="gp-population-dock"><PopulationDock active={active} /></div>}
      {working && active && <div className="gp-busy-cover"><GlassSurface><b>{working}</b><p>{populationBusy ? 'Preparing the declared population; model execution remains a separate action.' : 'SUMO is working on the running city.'}</p></GlassSurface></div>}
    </div>
  )
}
