import { useCallback, useEffect, useRef, useState } from 'react'

import { clock } from '../world/playback'
import Transport from './Transport'
import WorldCanvas from './WorldCanvas'
import type { WorldScene } from './scene'
import { useReplay } from './useReplay'
import './world.css'

/**
 * `/world` — the Babylon.js living-city route.  During the migration it is a self-contained preview of the
 * miniature Toronto; the HUD/sim dock/tooling from the Mapbox shell are wired in milestone by milestone.
 */
export default function WorldApp() {
  const params = new URLSearchParams(window.location.search)
  const packId = params.get('pack') ?? 'toronto'
  const runId = params.get('run')
  const sceneRef = useRef<WorldScene | null>(null)
  const [ready, setReady] = useState<WorldScene | null>(null)
  const [fps, setFps] = useState(0)
  const replay = useReplay(packId, runId)
  const rx = replay.phase === 'ready' ? replay.rx : null

  // replay -> scene: the clock drives `simT`; Babylon reads it every frame, React never re-renders per frame
  useEffect(() => {
    const ws = sceneRef.current
    if (!ready || !ws) return
    ws.traffic.setReplay(rx)
    if (!rx) return
    ws.simT = clock.t
    const off = clock.onFrame((t) => {
      ws.simT = t
    })
    if (!clock.playing) clock.play()
    return () => {
      off()
      clock.pause()
    }
  }, [ready, rx])
  const stats = useCallback(() => sceneRef.current?.traffic.stats ?? { buses: 0, cars: 0, people: 0, released: 0 }, [])

  const onReady = useCallback((ws: WorldScene) => {
    sceneRef.current = ws
    if (window.__cityshift) window.__cityshift.babylon = ws
    setReady(ws)
  }, [])

  useEffect(() => {
    if (!ready) return
    const id = setInterval(() => setFps(Math.round(ready.fps)), 800)
    return () => clearInterval(id)
  }, [ready])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const ws = sceneRef.current
      if (!ws || (e.target instanceof HTMLElement && /input|textarea/i.test(e.target.tagName))) return
      if (e.key === ' ') {
        e.preventDefault()
        clock.toggle()
      }
      if (e.key === '1') ws.camera.city()
      if (e.key === '2') flyLandmark(ws, 'cn_tower')
      if (e.key === '3') flyLandmark(ws, 'union_station')
      if (e.key === '4') flyLandmark(ws, 'rogers_centre')
      if (e.key === '5') egress(ws)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const world = ready?.world
  return (
    <div className="bworld-shell">
      <WorldCanvas packId={packId} onReady={onReady} />

      <div className="bworld-top">
        <div className="bworld-brand">
          <b>CITY//SHIFT</b>
          <span className="small dim">world · {packId}</span>
        </div>
        {world && (
          <div className="bworld-status small dim">
            <span>{world.counts.roads.toLocaleString()} SUMO edges</span>
            <span>{world.counts.buildings.toLocaleString()} buildings</span>
            <span>{world.stops.length} stops</span>
            <span>net {world.network_fingerprint.slice(0, 8)}</span>
            {replay.phase === 'ready' && <span>run {replay.run.run_id.replace('run-', '').slice(0, 8)}</span>}
            <span>{fps} fps</span>
          </div>
        )}
        <div className="bworld-top-right">
          <span className="small dim">Babylon.js preview</span>
          <a className="bworld-link small" href="/">
            Mapbox view
          </a>
        </div>
      </div>

      {ready && (
        <div className="bworld-cams">
          <button onClick={() => ready.camera.city()} title="1">
            City
          </button>
          <button onClick={() => flyLandmark(ready, 'cn_tower')} title="2">
            CN Tower
          </button>
          <button onClick={() => flyLandmark(ready, 'union_station')} title="3">
            Union
          </button>
          <button onClick={() => flyLandmark(ready, 'rogers_centre')} title="4">
            Rogers Centre
          </button>
          {rx && (
            <button className="hero" onClick={() => egress(ready)} title="5 — rewind to the first traveller leaving the Blue Jays game">
              Egress
            </button>
          )}
        </div>
      )}

      {ready && rx && <Transport rx={rx} stats={stats} />}
      {ready && replay.phase === 'none' && (
        <div className="bworld-transport small dim">No completed SUMO run for {packId} yet — run one from the Mapbox shell.</div>
      )}
      {ready && replay.phase === 'error' && <div className="bworld-transport small bworld-err">{replay.message}</div>}
    </div>
  )
}

function flyLandmark(ws: WorldScene, kind: string): void {
  const l = ws.world.landmarks.find((x) => x.kind === kind)
  if (!l) return
  const h = kind === 'cn_tower' ? 200 : 10
  ws.camera.flyTo({ target: [l.x, l.z], radius: kind === 'cn_tower' ? 900 : 640, heading: ws.camera.pose.heading, elevation: kind === 'cn_tower' ? 22 : 38, y: h }, 1300, 'district')
}

/**
 * Hero scene: the crowd leaving Rogers Centre.  Camera sits outside the gates looking back at the dome, clock
 * rewound to when the recorded departs start coming thick (10th percentile), at real time.
 */
function egress(ws: WorldScene): void {
  const l = ws.world.landmarks.find((x) => x.kind === 'rogers_centre')
  const t0 = ws.traffic.releaseQuantile(0.1)
  const gate = ws.traffic.releaseCentroid()
  if (!l || t0 === null || !gate) return
  const heading = (Math.atan2(l.x - gate[0], l.z - gate[1]) * 180) / Math.PI
  ws.camera.flyTo({ target: gate, radius: 300, heading, elevation: 46, y: 4 }, 1600, 'district')
  clock.seek(Math.max(0, t0 - 3))
  clock.setSpeed(1)
  if (!clock.playing) clock.toggle()
}
