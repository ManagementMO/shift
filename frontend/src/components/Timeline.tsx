import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { cohortSummaryAt, STATE_COLORS, type PersonState } from '../replay'
import { fmt } from '../util'

export default function Timeline() {
  const t = useStore((s) => s.t)
  const playing = useStore((s) => s.playing)
  const speed = useStore((s) => s.speed)
  const setT = useStore((s) => s.setT)
  const setPlaying = useStore((s) => s.setPlaying)
  const setSpeed = useStore((s) => s.setSpeed)
  const primary = useStore((s) => (s.primaryRunId ? s.replays[s.primaryRunId] : null))
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const horizon = scenario?.constraints.horizon_s ?? primary?.tMax ?? 2700
  const raf = useRef<number>(0)
  const last = useRef<number>(0)

  useEffect(() => {
    if (!playing) return
    last.current = performance.now()
    const step = (now: number) => {
      const dt = (now - last.current) / 1000
      last.current = now
      const cur = useStore.getState().t
      const next = Math.min(horizon, cur + dt * useStore.getState().speed)
      setT(next)
      if (next >= horizon) {
        setPlaying(false)
        return
      }
      raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf.current)
  }, [playing, horizon, setT, setPlaying])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return
      if (e.code === 'Space') {
        e.preventDefault()
        setPlaying(!useStore.getState().playing)
      } else if (e.code === 'ArrowRight') setT(Math.min(horizon, useStore.getState().t + 30))
      else if (e.code === 'ArrowLeft') setT(Math.max(0, useStore.getState().t - 30))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [horizon, setPlaying, setT])

  const summary = primary ? cohortSummaryAt(primary, t) : null
  const active = scenario?.restrictions.filter((r) => t >= r.start_s && t <= r.end_s) ?? []
  const events = primary?.bundle.events.filter((e) => e.t <= t && e.t > t - 20 && e.event !== 'depart').slice(-6) ?? []

  return (
    <div className="timeline">
      <div className="row">
        <button onClick={() => setPlaying(!playing)} disabled={!primary} title="Space">
          {playing ? 'Pause' : 'Play'}
        </button>
        <button onClick={() => setT(0)} disabled={!primary}>⟲</button>
        <span className="mono clock">{fmt(t)}</span>
        <input
          type="range"
          min={0}
          max={horizon}
          step={1}
          value={t}
          onChange={(e) => setT(Number(e.target.value))}
          disabled={!primary}
          style={{ flex: 1 }}
        />
        <span className="mono dim">{fmt(horizon)}</span>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          {[1, 5, 10, 30, 60, 120].map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </div>
      <div className="row small">
        {summary &&
          (Object.keys(summary) as PersonState[]).map((k) => (
            <span key={k} className="chip">
              <i style={{ background: `rgb(${STATE_COLORS[k].join(',')})` }} />
              {k.replace('_', ' ')} {summary[k]}
            </span>
          ))}
        {active.map((r) => (
          <span key={r.restriction_id} className="chip warn">
            ⛔ {r.label || r.restriction_id} ({fmt(r.start_s)}–{fmt(r.end_s)})
          </span>
        ))}
        {!primary && <span className="dim">Open a completed run to replay it. Every dot is a recorded SUMO/TraCI sample.</span>}
      </div>
      {events.length > 0 && (
        <div className="row small ticker mono">
          {events.map((e, i) => (
            <span key={i}>
              {fmt(e.t)} {e.person_id} {e.event}
              {e.vehicle_id ? ` ${e.vehicle_id}` : ''}
              {e.stop_id ? ` @${e.stop_id}` : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
