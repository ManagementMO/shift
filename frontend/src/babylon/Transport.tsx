import { useEffect, useState } from 'react'

import { clock, PLAYBACK_SPEEDS, simClock } from '../world/playback'
import { cohortSummaryAt, STATE_COLORS, type PersonState, type ReplayIndex } from '../replay'
import { EMPTY_STATS, type TrafficStats } from './traffic'

/** Minimal play/scrub bar for the Babylon route; the full sim dock is wired in a later milestone. */
export default function Transport({ rx, stats }: { rx: ReplayIndex; stats: () => TrafficStats }) {
  const [t, setT] = useState(clock.t)
  const [playing, setPlaying] = useState(clock.playing)
  const [speed, setSpeed] = useState(clock.speed)
  const [live, setLive] = useState<TrafficStats>(EMPTY_STATS)
  const cohort = cohortSummaryAt(rx, t)
  const total = Object.keys(rx.personEvents).length

  useEffect(() => {
    clock.setHorizon(rx.tMax)
    return clock.onUi((v) => {
      setT(v)
      setPlaying(clock.playing)
      setSpeed(clock.speed)
    })
  }, [rx])

  // counts are read after Babylon has drawn the frame, so they lag the clock by at most one tick
  useEffect(() => {
    const id = setInterval(() => setLive(stats()), 400)
    return () => clearInterval(id)
  }, [stats])

  return (
    <div className="bworld-transport">
      <button
        className="bworld-play"
        onClick={() => {
          clock.toggle()
          setPlaying(clock.playing)
        }}
        title={`${playing ? 'Pause' : 'Resume'} (Space)`}
        aria-label={playing ? 'Pause simulation' : 'Resume simulation'}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <span className="bworld-clock mono" role="timer" aria-label="Simulation clock">{simClock(t, true)}</span>
      <input
        type="range"
        min={0}
        max={rx.tMax}
        step={1}
        value={Math.round(t)}
        onChange={(e) => clock.seek(Number(e.target.value))}
      />
      <span className="mono small dim">{Math.floor(t / 60)}:{String(Math.floor(t % 60)).padStart(2, '0')}</span>
      <div className="bworld-speeds">
        {PLAYBACK_SPEEDS.map((s) => (
          <button
            key={s}
            className={s === speed ? 'on' : ''}
            aria-pressed={s === speed}
            onClick={() => {
              clock.setSpeed(s)
              setSpeed(s)
            }}
          >
            {s}×
          </button>
        ))}
      </div>
      <span className="small dim bworld-live">
        {live.buses} bus · {live.cars} cars · {live.people} on foot
      </span>
      <span className="small bworld-cohort" title="travellers released from the venue so far, by recorded state">
        <b className="mono">{live.released}</b>
        <span className="dim">/{total} released</span>
        {CROWD_STATES.map((s) => (
          <span key={s} className="bworld-state" style={{ ['--c' as string]: rgb(STATE_COLORS[s]) }}>
            <i />
            {cohort[s]} {STATE_LABEL[s]}
          </span>
        ))}
      </span>
    </div>
  )
}

const CROWD_STATES: PersonState[] = ['walking', 'waiting', 'riding', 'driving', 'arrived']
const STATE_LABEL: Record<PersonState, string> = {
  not_departed: 'inside',
  walking: 'walking',
  waiting: 'waiting',
  riding: 'on bus',
  driving: 'driving',
  arrived: 'home',
  unroutable: 'unroutable',
}
const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`
