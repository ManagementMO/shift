import { useEffect, useMemo } from 'react'
import { useStore } from '../store'
import { clock, PLAYBACK_SPEEDS, simClock } from '../world/playback'
import { cohortSummaryAt, entitiesAt } from '../replay'
import { fmt } from '../util'

export default function SimDock({ active = true }: { active?: boolean }) {
  const t = useStore((s) => s.t)
  const playing = useStore((s) => s.playing)
  const speed = useStore((s) => s.speed)
  const primary = useStore((s) => (s.primaryRunId ? s.replays[s.primaryRunId] : null))
  const loading = useStore((s) => s.loadingReplay !== null)
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const horizon = Math.max(1, scenario?.constraints.horizon_s ?? primary?.tMax ?? 2700, primary?.tMax ?? 0)
  const ready = !!primary && !loading

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null
      if (!ready || e.repeat || target?.isContentEditable || target?.closest('input, textarea, select, button')) return
      if (e.code === 'Space') {
        e.preventDefault()
        clock.toggle()
      } else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
        if (target?.tagName === 'CANVAS') return
        e.preventDefault()
        clock.seek(clock.t + (e.code === 'ArrowRight' ? 30 : -30))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, ready])

  const summary = primary ? cohortSummaryAt(primary, t) : null
  const buses = primary ? entitiesAt(primary, t).filter((e) => e.kind === 'bus').length : 0
  const ticks = useMemo(() => {
    const step = horizon > 3600 * 2 ? 1800 : horizon > 3600 ? 900 : 600
    const out: number[] = []
    for (let x = 0; x <= horizon; x += step) out.push(x)
    return out
  }, [horizon])
  const bands = scenario?.restrictions.map((r) => ({ id: r.restriction_id, a: r.start_s / horizon, b: r.end_s / horizon, label: r.label })) ?? []
  const hazardBands = scenario?.hazards.map((h) => ({ id: h.track_id, a: h.start_s / horizon, b: h.end_s / horizon, label: h.label })) ?? []

  return (
    <div className="dock">
      <div className="dock-controls">
        <button className="iconbtn" onClick={() => clock.seek(0)} title="Restart" aria-label="Restart simulation" disabled={!ready}>
          ⟲
        </button>
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
        {primary && primary.activityStart > 0 && (
          <button className="ghostbtn" onClick={() => clock.seek(primary.activityStart)} disabled={!ready} aria-label="Jump to active traffic" title={`Skip the quiet intro and jump to recorded activity at +${fmt(primary.activityStart)}`}>
            Activity
          </button>
        )}
        <div className="clock" role="timer" aria-label="Simulation clock" title="Recorded simulation time. Replays open at active traffic; rewind to watch the full intro.">
          <span className="wall">{simClock(t, true)}</span>
          <span className="rel">{playing ? 'Running' : 'Paused'} · +{fmt(t)}</span>
        </div>
      </div>
      <div className="dock-timeline">
        <div className="bands">
          {bands.map((b) => (
            <i key={b.id} className="band closure" style={{ left: `${b.a * 100}%`, width: `${(b.b - b.a) * 100}%` }} title={b.label} />
          ))}
          {hazardBands.map((b) => (
            <i key={b.id} className="band hazard" style={{ left: `${b.a * 100}%`, width: `${(b.b - b.a) * 100}%` }} title={b.label} />
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={horizon}
          step={1}
          value={Math.min(t, horizon)}
          onChange={(e) => clock.seek(Number(e.target.value))}
          disabled={!ready}
          aria-label="Simulation time"
        />
        <div className="ticks">
          {ticks.map((x) => (
            <span key={x} style={{ left: `${(x / horizon) * 100}%` }}>
              {simClock(x)}
            </span>
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
