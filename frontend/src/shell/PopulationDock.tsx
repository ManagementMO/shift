import { useEffect, type CSSProperties } from 'react'
import { populationSummaryAt } from '../population'
import { useStore } from '../store'
import { clock, PLAYBACK_SPEEDS } from '../world/playback'
import { fmt } from '../util'
import { runIsActive, usePopulationPlayback } from '../populationLifecycle'
import './population.css'

export default function PopulationDock({ active = true }: { active?: boolean }) {
  const replay = useStore(s => s.primaryRunId ? s.replays[s.primaryRunId] ?? null : null)
  const count = useStore(s => s.populationDefinition?.spec.count ?? null)
  const t = useStore(s => s.t)
  const playing = useStore(s => s.playing)
  const speed = useStore(s => s.speed)
  const run = useStore(s => s.runs.find(r => r.run_id === s.primaryRunId))
  const following = usePopulationPlayback(s => s.followLive)
  const executing = !!run && runIsActive(run)
  const canPlay = !!replay && replay.tMax > 0
  const duration = replay?.tMax ?? 0
  const playhead = Math.min(t, duration)
  const summary = replay?.population ? populationSummaryAt(replay.population, t) : null
  useEffect(() => {
    if (!active || !canPlay) return
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.code !== 'Space') return
      if (event.target instanceof Element && event.target.closest('input, select, textarea, button, [contenteditable="true"]')) return
      event.preventDefault()
      usePopulationPlayback.getState().setFollowLive(false)
      clock.toggle()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [active, canPlay])
  const values = [
    ['Residents', summary?.residents ?? count], ['Moving', summary?.moving ?? null],
    ['Working', summary?.working ?? null], ['Tasks done', summary?.completed ?? null],
    ['Committed', summary?.commitments ?? null],
  ] as const
  return <section className="population-dock" aria-label="Resident recording playback">
    <label className="population-timeline">
      <span className="population-timeline-labels"><span>{executing ? following ? 'Latest decision' : 'Inspecting history' : 'Recorded'} <b>+{fmt(playhead)}</b></span><span>{run?.status ?? 'Not started'} · +{fmt(duration)}</span></span>
      <input aria-label="Resident history playhead" aria-valuetext={`${fmt(playhead)} of ${fmt(duration)} recorded`} type="range" min={0} max={Math.max(1, duration)} step={1} value={playhead} style={{ '--playback-progress': `${duration ? playhead / duration * 100 : 0}%` } as CSSProperties} disabled={!canPlay} onChange={event => { usePopulationPlayback.getState().setFollowLive(false); clock.pause(); clock.seek(Number(event.target.value)) }} />
    </label>
    <div className="population-playback-controls">
      <button onClick={() => { usePopulationPlayback.getState().setFollowLive(false); clock.toggle() }} disabled={!canPlay} aria-label={playing ? 'Pause resident playback' : 'Play resident recording'}>{playing ? 'Pause' : 'Play'}</button>
      <div className="population-speeds" role="group" aria-label="Resident playback speed">{PLAYBACK_SPEEDS.map(value => <button key={value} disabled={!canPlay} aria-pressed={value === speed} onClick={() => clock.setSpeed(value)}>{value}×</button>)}</div>
      {executing ? <button aria-pressed={following} onClick={() => { clock.pause(); clock.seek(duration); usePopulationPlayback.getState().setFollowLive(true) }}>Latest</button> : <button aria-label="Open resident history" onClick={() => useStore.getState().setTool('residents')}>Residents</button>}
    </div>
    <dl className="population-playback-metrics">{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? '—'}</dd></div>)}</dl>
  </section>
}
