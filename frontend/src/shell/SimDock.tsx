import { useEffect } from 'react'
import { environmentAt, live, liveCountsAt, useLive } from '../live/session'
import { useStore } from '../store'
import { PLAYBACK_SPEEDS } from '../world/playback'

/**
 * Playback dock for the live city: play / pause, speed and the live cohort counters.  Pausing holds SUMO at a
 * simulation step; playing advances it.  There is no clock or timeline — the city simply runs.  Space toggles it.
 */
export default function SimDock({ active = true }: { active?: boolean }) {
  const t = useStore((s) => s.t)
  const playing = useStore((s) => s.playing)
  const speed = useStore((s) => s.speed)
  const view = useLive()
  const ready = !!view.primary && !['starting', 'restoring', 'failed'].includes(view.primary.state.status) && !view.busy

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null
      if (!ready || e.repeat || target?.isContentEditable || target?.closest('input, textarea, select, button')) return
      if (e.code === 'Space') {
        e.preventDefault()
        live.toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, ready])

  const counts = liveCountsAt(view, t)
  const buses = view.primary ? environmentAt(view.primary.state, t).assignedBuses.size : null

  return (
    <div className="dock">
      <div className="dock-controls">
        <button className="iconbtn play" onClick={() => live.toggle()} title={`${playing ? 'Pause' : 'Resume'} (Space)`} aria-label={playing ? 'Pause simulation' : 'Resume simulation'} disabled={!ready}>
          {playing ? '❚❚' : '▶'}
        </button>
        <div className="speeds" role="group" aria-label="Simulation speed">
          {PLAYBACK_SPEEDS.map((s) => (
            <button key={s} className={speed === s ? 'on' : ''} aria-pressed={speed === s} onClick={() => live.setSpeed(s)} disabled={!ready}>
              {s}×
            </button>
          ))}
        </div>
        {view.buffering && <span className="small dim">simulating…</span>}
      </div>
      <div className="dock-metrics">
        <Metric label="Moving" value={counts ? counts.walking + counts.driving : null} tone="walking" />
        <Metric label="Waiting" value={counts?.waiting ?? null} tone="waiting" />
        <Metric label="Riding" value={counts?.riding ?? null} tone="riding" />
        <Metric label="Arrived" value={counts?.arrived ?? null} tone="arrived" />
        <Metric label="Buses" value={buses} tone="bus" />
      </div>
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: number | null; tone: string }) {
  return (
    <div className={`metric ${tone}`}>
      <span className="val">{value ?? '—'}</span>
      <span className="lbl">{label}</span>
    </div>
  )
}
