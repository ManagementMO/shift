import { useEffect } from 'react'
import { useStore } from '../store'
import { clock, PLAYBACK_SPEEDS } from '../world/playback'
import { cohortSummaryAt, entitiesAt } from '../replay'

/**
 * Playback dock: play / pause, speed and the live cohort counters.  There is no clock or timeline — the replay
 * opens at recorded activity, runs continuously and loops back there at the end; Space toggles it.
 */
export default function SimDock({ active = true }: { active?: boolean }) {
  const t = useStore((s) => s.t)
  const playing = useStore((s) => s.playing)
  const speed = useStore((s) => s.speed)
  const primary = useStore((s) => (s.primaryRunId ? s.replays[s.primaryRunId] : null))
  const loading = useStore((s) => s.loadingReplay !== null)
  const ready = !!primary && !loading

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null
      if (!ready || e.repeat || target?.isContentEditable || target?.closest('input, textarea, select, button')) return
      if (e.code === 'Space') {
        e.preventDefault()
        clock.toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, ready])

  const summary = primary ? cohortSummaryAt(primary, t) : null
  const buses = primary ? entitiesAt(primary, t).filter((e) => e.kind === 'bus').length : 0

  return (
    <div className="dock">
      <div className="dock-controls">
        <button className="iconbtn play" onClick={() => clock.toggle()} title={`${playing ? 'Pause' : 'Resume'} (Space)`} aria-label={playing ? 'Pause simulation' : 'Resume simulation'} disabled={!ready}>
          {playing ? '❚❚' : '▶'}
        </button>
        <div className="speeds" role="group" aria-label="Simulation speed">
          {PLAYBACK_SPEEDS.map((s) => (
            <button key={s} className={speed === s ? 'on' : ''} aria-pressed={speed === s} onClick={() => clock.setSpeed(s)} disabled={!ready}>
              {s}×
            </button>
          ))}
        </div>
      </div>
      <div className="dock-metrics">
        <Metric label="Moving" value={summary ? summary.walking + summary.driving : null} tone="walking" />
        <Metric label="Waiting" value={summary?.waiting ?? null} tone="waiting" />
        <Metric label="Riding" value={summary?.riding ?? null} tone="riding" />
        <Metric label="Arrived" value={summary?.arrived ?? null} tone="arrived" />
        <Metric label="Buses" value={primary ? buses : null} tone="bus" />
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
