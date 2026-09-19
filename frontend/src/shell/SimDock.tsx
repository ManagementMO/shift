import { useEffect, useMemo } from 'react'
import { useStore } from '../store'
import { clock, simClock } from '../world/playback'
import { cohortSummaryAt, entitiesAt } from '../replay'
import { fmt } from '../util'

const SPEEDS = [1, 10, 100]

export default function SimDock() {
  const t = useStore((s) => s.t)
  const playing = useStore((s) => s.playing)
  const speed = useStore((s) => s.speed)
  const primary = useStore((s) => (s.primaryRunId ? s.replays[s.primaryRunId] : null))
  const baseline = useStore((s) => (s.compareMode && s.compareRunId ? s.replays[s.compareRunId] ?? null : null))
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const horizon = scenario?.constraints.horizon_s ?? primary?.tMax ?? 2700

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.code === 'Space') {
        e.preventDefault()
        clock.toggle()
      } else if (e.code === 'ArrowRight') clock.seek(clock.t + 30)
      else if (e.code === 'ArrowLeft') clock.seek(clock.t - 30)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const summary = primary ? cohortSummaryAt(primary, t) : null
  const buses = primary ? entitiesAt(primary, t).filter((e) => e.kind === 'bus').length : 0
  const base = baseline ? cohortSummaryAt(baseline, t) : null
  const baseBuses = baseline ? entitiesAt(baseline, t).filter((e) => e.kind === 'bus').length : null
  const d = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null ? undefined : a - b)
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
        <button className="iconbtn" onClick={() => clock.seek(0)} title="Restart" disabled={!primary}>
          ⟲
        </button>
        <button className="iconbtn play" onClick={() => clock.toggle()} title="Space" disabled={!primary}>
          {playing ? '❚❚' : '▶'}
        </button>
        <div className="speeds">
          {SPEEDS.map((s) => (
            <button key={s} className={speed === s ? 'on' : ''} onClick={() => clock.setSpeed(s)}>
              {s}×
            </button>
          ))}
        </div>
        <div className="clock">
          <span className="wall">{simClock(t)}</span>
          <span className="rel">+{fmt(t)}</span>
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
          disabled={!primary}
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
        <Metric label="Moving" value={summary ? summary.walking + summary.driving : null} tone="walking" delta={d(summary && summary.walking + summary.driving, base && base.walking + base.driving)} />
        <Metric label="Waiting" value={summary?.waiting ?? null} tone="waiting" delta={d(summary?.waiting, base?.waiting)} />
        <Metric label="Riding" value={summary?.riding ?? null} tone="riding" delta={d(summary?.riding, base?.riding)} />
        <Metric label="Arrived" value={summary?.arrived ?? null} tone="arrived" delta={d(summary?.arrived, base?.arrived)} />
        <Metric label="Buses" value={primary ? buses : null} tone="bus" delta={d(primary ? buses : null, baseBuses)} />
      </div>
    </div>
  )
}

/** `delta` is candidate − baseline at the same clock while comparing; otherwise omitted. */
function Metric({ label, value, tone, delta }: { label: string; value: number | null; tone: string; delta?: number }) {
  return (
    <div className={`metric ${tone}`}>
      <span className="val">
        {value ?? '—'}
        {delta !== undefined && (
          <small className={`delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}`} title="candidate − baseline, same clock">
            {delta > 0 ? `+${delta}` : delta === 0 ? '±0' : delta}
          </small>
        )}
      </span>
      <span className="lbl">{label}</span>
    </div>
  )
}
