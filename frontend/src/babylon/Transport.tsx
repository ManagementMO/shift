import { useEffect, useState } from 'react'

import { clock, simClock } from '../world/playback'
import type { ReplayIndex } from '../replay'
import type { TrafficStats } from './traffic'

const SPEEDS = [1, 10, 60]

/** Minimal play/scrub bar for the Babylon route; the full sim dock is wired in a later milestone. */
export default function Transport({ rx, stats }: { rx: ReplayIndex; stats: () => TrafficStats }) {
  const [t, setT] = useState(clock.t)
  const [playing, setPlaying] = useState(clock.playing)
  const [speed, setSpeed] = useState(clock.speed)
  const [live, setLive] = useState<TrafficStats>({ buses: 0, cars: 0, people: 0 })

  useEffect(() => {
    clock.setHorizon(rx.tMax)
    return clock.onUi((v) => {
      setT(v)
      setPlaying(clock.playing)
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
        title="space"
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <span className="bworld-clock mono">{simClock(t)}</span>
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
        {SPEEDS.map((s) => (
          <button
            key={s}
            className={s === speed ? 'on' : ''}
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
        {live.buses} bus · {live.cars} cars · {live.people} walking
      </span>
    </div>
  )
}
