import { useCallback, useEffect, useRef, useState } from 'react'

import WorldCanvas from './WorldCanvas'
import type { WorldScene } from './scene'
import './world.css'

/**
 * `/world` — the Babylon.js living-city route.  During the migration it is a self-contained preview of the
 * miniature Toronto; the HUD/sim dock/tooling from the Mapbox shell are wired in milestone by milestone.
 */
export default function WorldApp() {
  const packId = new URLSearchParams(window.location.search).get('pack') ?? 'toronto'
  const sceneRef = useRef<WorldScene | null>(null)
  const [ready, setReady] = useState<WorldScene | null>(null)
  const [fps, setFps] = useState(0)

  const onReady = useCallback((ws: WorldScene) => {
    sceneRef.current = ws
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
      if (e.key === '1') ws.camera.city()
      if (e.key === '2') flyLandmark(ws, 'cn_tower')
      if (e.key === '3') flyLandmark(ws, 'union_station')
      if (e.key === '4') flyLandmark(ws, 'rogers_centre')
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
        </div>
      )}

      {world && (
        <div className="bworld-status small dim">
          <span>{world.counts.roads.toLocaleString()} SUMO edges</span>
          <span>{world.counts.buildings.toLocaleString()} buildings</span>
          <span>{world.stops.length} stops</span>
          <span>net {world.network_fingerprint.slice(0, 8)}</span>
          <span>{fps} fps</span>
        </div>
      )}
    </div>
  )
}

function flyLandmark(ws: WorldScene, kind: string): void {
  const l = ws.world.landmarks.find((x) => x.kind === kind)
  if (!l) return
  const h = kind === 'cn_tower' ? 200 : 10
  ws.camera.flyTo({ target: [l.x, l.z], radius: kind === 'cn_tower' ? 900 : 640, heading: ws.camera.pose.heading, elevation: kind === 'cn_tower' ? 22 : 38, y: h }, 1300, 'district')
}
