import { useEffect, useRef, useState, type ReactNode } from 'react'

import { WorldScene } from './scene'
import { useDisplay } from './display'
import { loadWorld, type WorldData } from './worldData'

export interface WorldCanvasProps {
  packId: string
  onReady?: (scene: WorldScene) => void
  onError?: (message: string) => void
  className?: string
  fixedCamera?: boolean
  quality?: 'high' | 'balanced'
  children?: ReactNode
}

/**
 * Mounts one Babylon engine on one canvas.  React owns nothing inside the scene; it only reports lifecycle
 * (loading / ready / error) and hands the imperative `WorldScene` to the parent through `onReady`.
 */
export default function WorldCanvas({ packId, onReady, onError, className, fixedCamera = false, quality = 'high', children }: WorldCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<{ phase: 'loading' | 'building' | 'ready' | 'error'; detail?: string }>({ phase: 'loading' })

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    let cancelled = false
    let ws: WorldScene | null = null
    setState({ phase: 'loading' })
    loadWorld(packId)
      .then((world: WorldData) => {
        if (cancelled) return
        setState({ phase: 'building' })
        // let the "building" frame paint before the (synchronous) geometry pass
        requestAnimationFrame(async () => {
          if (cancelled) return
          try {
            const worldScene = new WorldScene(canvas, world, { fixedCamera, quality })
            ws = worldScene
            worldScene.setDisplay(useDisplay.getState())
            const offDisplay = useDisplay.subscribe((settings) => worldScene.setDisplay(settings))
            worldScene.scene.onDisposeObservable.addOnce(offDisplay)
            await worldScene.assetsReady
            if (cancelled) return
            await worldScene.scene.whenReadyAsync(true)
            if (cancelled) return
            await new Promise<void>((resolve) => worldScene.scene.onAfterRenderObservable.addOnce(() => resolve()))
            if (cancelled) return
            setState({ phase: 'ready' })
            onReady?.(worldScene)
          } catch (e) {
            if (cancelled) return
            const detail = e instanceof Error ? e.message : String(e)
            setState({ phase: 'error', detail })
            onError?.(detail)
          }
        })
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const detail = e instanceof Error ? e.message : String(e)
          setState({ phase: 'error', detail })
          onError?.(detail)
        }
      })
    return () => {
      cancelled = true
      ws?.dispose()
    }
    // onReady is intentionally not a dependency: remounting the engine on every parent render is the one thing to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packId, fixedCamera, quality])

  return (
    <div className={className ?? 'bworld'}>
      <canvas ref={ref} className="bworld-canvas" />
      {state.phase === 'ready' && children}
      {state.phase !== 'ready' && (
        <div className={`bworld-veil ${state.phase}`}>
          <div className="bworld-veil-card">
            {state.phase === 'error' ? (
              <>
                <b>World unavailable</b>
                <span className="small">{state.detail}</span>
              </>
            ) : (
              <>
                <i />
                <b>{state.phase === 'loading' ? 'Loading' : 'Building'} {packId.replace(/[-_]/g, ' ')}…</b>
                <span className="small dim">{state.phase === 'loading' ? 'SUMO network, OSM footprints, shoreline' : 'textured buildings, streets, parks, landmarks'}</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
