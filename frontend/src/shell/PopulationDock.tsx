import { useEffect } from 'react'
import { populationSummaryAt } from '../population'
import { useStore } from '../store'
import { clock, PLAYBACK_SPEEDS } from '../world/playback'
import { fmt } from '../util'
import './population.css'

export default function PopulationDock({ active = true }: { active?: boolean }) {
  const replay = useStore(s => s.primaryRunId ? s.replays[s.primaryRunId] ?? null : null)
  const count = useStore(s => s.populationDefinition?.spec.count ?? null)
  const t = useStore(s => s.t)
  const playing = useStore(s => s.playing)
  const speed = useStore(s => s.speed)
  const canPlay = !!replay && replay.tMax > 0
  const summary = replay?.population ? populationSummaryAt(replay.population, t) : null
  useEffect(() => {
    if (!active || !canPlay) return
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.code !== 'Space') return
      if (event.target instanceof Element && event.target.closest('input, select, textarea, button, [contenteditable="true"]')) return
      event.preventDefault()
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
  return <div className="dock population-dock">
    <label className="population-timeline"><span>Recorded +{fmt(t)}</span><input aria-label="Resident history playhead" type="range" min={0} max={Math.max(1, replay?.tMax ?? 0)} step={1} value={Math.min(t, replay?.tMax ?? 0)} disabled={!canPlay} onChange={event => { clock.pause(); clock.seek(Number(event.target.value)) }} /><span>+{fmt(replay?.tMax ?? 0)}</span></label>
    <div className="dock-controls">
      <button className="ghostbtn" onClick={() => clock.toggle()} disabled={!canPlay} aria-label={playing ? 'Pause resident playback' : 'Play resident recording'}>{playing ? 'Pause view' : 'Play view'}</button>
      <div className="speeds" role="group" aria-label="Resident playback speed">{PLAYBACK_SPEEDS.map(value => <button key={value} className={value === speed ? 'on' : ''} disabled={!canPlay} aria-pressed={value === speed} onClick={() => clock.setSpeed(value)}>{value}×</button>)}</div>
      <button className="ghostbtn" onClick={() => useStore.getState().setTool('residents')}>Resident history</button>
    </div>
    <div className="dock-metrics">{values.map(([label, value]) => <div className="metric" key={label}><span className="val">{value ?? '—'}</span><span className="lbl">{label}</span></div>)}</div>
  </div>
}
