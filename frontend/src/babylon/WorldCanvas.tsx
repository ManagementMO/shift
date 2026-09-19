import { useEffect, useRef, useState } from 'react'

import { WorldScene } from './scene'
import { loadWorld, type WorldData } from './worldData'

export interface WorldCanvasProps {
  packId: string
  onReady?: (scene: WorldScene) => void
  className?: string
  fixedCamera?: boolean
}

/**
 * Mounts one Babylon engine on one canvas.  React owns nothing inside the scene; it only reports lifecycle
 * (loading / ready / error) and hands the imperative `WorldScene` to the parent through `onReady`.
 */
export default function WorldCanvas({ packId, onReady, className, fixedCamera = true }: WorldCanvasProps) {
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
        requestAnimationFrame(() => {
          if (cancelled) return
          try {
            ws = new WorldScene(canvas, world, { fixedCamera })
            setState({ phase: 'ready' })
            onReady?.(ws)
          } catch (e) {
            setState({ phase: 'error', detail: e instanceof Error ? e.message : String(e) })
          }
        })
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ phase: 'error', detail: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      cancelled = true
      ws?.dispose()
    }
    // onReady is intentionally not a dependency: remounting the engine on every parent render is the one thing to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packId, fixedCamera])

  return (
    <div className={className ?? 'bworld'}>
      <canvas ref={ref} className="bworld-canvas" />
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
                <b>{state.phase === 'loading' ? 'Loading Toronto…' : 'Building Toronto…'}</b>
                <span className="small dim">{state.phase === 'loading' ? 'SUMO network, OSM footprints, shoreline' : 'roads, 10 000 buildings, landmarks'}</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
