import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import type { Renderer } from '../types'

const WorldBabylon = lazy(() => import('../babylon/WorldBabylon'))
const WorldMap = lazy(() => import('../world/WorldMap'))

/**
 * Two full-viewport worlds, same renderer, same camera, same clock; the right one is clipped at a draggable divider.
 * Left = baseline (compare slot), right = candidate (view slot). Identical canvas sizes keep projections aligned.
 */
export default function CompareSplit({ renderer = 'babylon' }: { renderer?: Renderer }) {
  const World = renderer === 'mapbox' ? WorldMap : WorldBabylon
  const primaryRunId = useStore((s) => s.primaryRunId)
  const compareRunId = useStore((s) => s.compareRunId)
  const runs = useStore((s) => s.runs)
  const plans = useStore((s) => s.plans)
  const openRun = useStore((s) => s.openRun)
  const setCompareMode = useStore((s) => s.setCompareMode)
  const [split, setSplit] = useState(0.5)
  const dragging = useRef(false)

  const onMove = useCallback((e: PointerEvent) => {
    if (!dragging.current) return
    setSplit(Math.min(0.85, Math.max(0.15, e.clientX / window.innerWidth)))
  }, [])
  useEffect(() => {
    const up = () => {
      dragging.current = false
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', up)
    }
  }, [onMove])

  const name = (rid: string | null) => {
    const r = runs.find((x) => x.run_id === rid)
    return r ? plans.find((p) => p.plan.plan_id === r.plan_id)?.plan.name ?? r.plan_id : '—'
  }
  const candidates = runs.filter((r) => r.status === 'completed' && r.run_id !== primaryRunId)

  return (
    <div className="split" style={{ ['--split' as string]: `${split * 100}%` }}>
      <div className="split-pane left">
        <Suspense fallback={null}>
          <World runId={compareRunId} side="left" />
        </Suspense>
      </div>
      <div className="split-pane right">
        <Suspense fallback={null}>
          <World runId={primaryRunId} side="right" />
        </Suspense>
      </div>
      <div className="split-divider" onPointerDown={() => (dragging.current = true)}>
        <i />
      </div>
      <div className="split-label left">
        <span className="tag">Baseline</span>
        {compareRunId ? (
          <b>{name(compareRunId)}</b>
        ) : (
          <select value="" onChange={(e) => void openRun(e.target.value, 'compare')}>
            <option value="">choose a completed run…</option>
            {candidates.map((r) => (
              <option key={r.run_id} value={r.run_id}>
                {name(r.run_id)} · seed {r.seed}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="split-label right">
        <span className="tag">Candidate</span>
        <b>{name(primaryRunId)}</b>
        <button className="iconbtn small" onClick={() => setCompareMode(false)} aria-label="Exit compare">
          ✕
        </button>
      </div>
    </div>
  )
}
