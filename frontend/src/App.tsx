import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { useLive } from './live/session'
import { useStore } from './store'
import type { WorldScene } from './babylon/scene'
import GodCityUI from './gods-plan/GodCityUI'
import { GlassSurface } from './gods-plan/ui'
import './App.css'

const WorldBabylon = lazy(() => import('./babylon/WorldBabylon'))

/** The live city: one running SUMO simulation under the shell; every tool changes it in place. */
export default function App({ active = true, onGlobe, onWorldReady, onWorldError }: { active?: boolean; onGlobe?: () => void; onWorldReady?: (scene: WorldScene) => void; onWorldError?: (message: string) => void }) {
  const boot = useStore((s) => s.boot)
  const { busy } = useLive()
  const [world, setWorld] = useState<WorldScene | null>(null)
  const ready = useCallback((scene: WorldScene) => { setWorld(scene); onWorldReady?.(scene) }, [onWorldReady])

  useEffect(() => {
    void boot(new URLSearchParams(window.location.search).get('pack') ?? undefined)
  }, [boot])

  return (
    <div className="shell gp-shell">
      <div className="worlds">
        <Suspense fallback={null}>
          <WorldBabylon side="solo" active={active} onWorldReady={ready} onWorldError={onWorldError} />
        </Suspense>
      </div>
      <GodCityUI world={world} active={active} onHome={onGlobe ?? (() => { window.location.href = '/' })} />
      {busy && active && <div className="gp-busy-cover"><GlassSurface><b>{busy}</b><p>SUMO is working on the running city.</p></GlassSurface></div>}
    </div>
  )
}
