import { useCallback, useEffect, useRef, useState } from 'react'

import { BrandMark } from '../components/Icon'
import type { HazardTrack } from '../types'
import { clock } from '../world/playback'
import { DISPLAY_SCALE, type Destructible } from './destruction'
import type { WorldScene } from './scene'
import WorldCanvas from './WorldCanvas'
import '../App.css'
import './world.css'
import './tornadoDemo.css'

const HORIZON = 600
const START = 30
const END = 450

type Demo = { scene: WorldScene; hazard: HazardTrack; plan: Destructible[]; hero: Destructible }
type View = 'overview' | 'close'

function viewDemo(demo: Demo, view: View): void {
  const { scene, hero } = demo
  scene.camera.cancel()
  scene.camera.setPreferredProjection('perspective')
  scene.camera.apply(view === 'close'
    ? { target: [hero.x, hero.z], y: hero.base + hero.h * 0.36, radius: Math.max(400, hero.h * 3.8), heading: 25, elevation: 38 }
    : { target: [hero.x + 45, hero.z + 30], y: 90, radius: 1000, heading: -25, elevation: 42 })
}

function timeLabel(t: number): string {
  const seconds = Math.floor(t / DISPLAY_SCALE)
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

export default function TornadoDemo() {
  const sceneRef = useRef<WorldScene | null>(null)
  const [demo, setDemo] = useState<Demo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('overview')
  const [playback, setPlayback] = useState({ t: 0, playing: false, speed: 1 })
  const [fps, setFps] = useState(0)

  useEffect(() => {
    const off = clock.onUi((t) => setPlayback({ t, playing: clock.playing, speed: clock.speed / DISPLAY_SCALE }))
    const hidden = () => { if (document.hidden) clock.pause() }
    const key = (event: KeyboardEvent) => {
      if (!sceneRef.current || (event.target instanceof HTMLElement && event.target.closest('button, input, select, textarea, a, [contenteditable="true"]'))) return
      if (event.code === 'Space') { event.preventDefault(); clock.toggle() }
      if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
        event.preventDefault()
        clock.pause()
        clock.seek(clock.t + (event.code === 'ArrowLeft' ? -10 : 10))
      }
    }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('keydown', key)
    const timer = window.setInterval(() => setFps(Math.round(sceneRef.current?.fps ?? 0)), 1000)
    return () => {
      off()
      clock.pause()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('keydown', key)
    }
  }, [])

  const onReady = useCallback((scene: WorldScene) => {
    sceneRef.current = scene
    if (window.__cityshift) window.__cityshift.babylon = scene
    scene.scene.executeWhenReady(() => {
      if (scene.scene.isDisposed) return
      const anchor = scene.world.landmarks.find((l) => l.kind === 'cn_tower') ?? scene.world.venue
      const hazard: HazardTrack = {
        track_id: 'toronto-tornado-visual-demo',
        waypoints: [scene.frame.worldToLonLat(anchor.x + 20, anchor.z - 30), scene.frame.worldToLonLat(anchor.x + 580, anchor.z + 170)],
        radius_m: 110,
        start_s: START,
        end_s: END,
        modes: [],
        label: 'Tornado destruction prototype — visual only',
      }
      scene.storm.setHazards([hazard])
      const plan = scene.storm.storm(hazard)?.damage.plan ?? []
      const hero = [...plan].filter((d) => d.collapse).sort((a, b) => b.h - a.h || a.key.localeCompare(b.key))[0]
      if (!hero) { setError('No destructible building was found in this city pack.'); return }
      const next = { scene, hazard, plan, hero }
      clock.pause()
      clock.setHorizon(HORIZON)
      clock.setSpeed(DISPLAY_SCALE)
      clock.seek(0)
      scene.simT = 0
      scene.storm.update(0)
      scene.setActive(true)
      viewDemo(next, 'overview')
      scene.invalidateShadows()
      let shadowTick = -1
      const off = clock.onFrame((t) => {
        scene.simT = t
        const tick = Math.floor(t / 5)
        if (tick !== shadowTick || !clock.playing) {
          scene.invalidateShadows()
          shadowTick = tick
        }
      })
      scene.scene.onDisposeObservable.addOnce(() => {
        off()
        if (sceneRef.current === scene) sceneRef.current = null
        if (window.__cityshift?.babylon === scene) window.__cityshift.babylon = undefined
      })
      setDemo(next)
    })
  }, [])

  const seek = (t: number) => { clock.pause(); clock.seek(t) }
  const frame = (next: View) => { if (demo) viewDemo(demo, next); setView(next) }
  const start = () => {
    clock.pause()
    clock.seek(0)
    clock.setSpeed(DISPLAY_SCALE)
    frame('overview')
    clock.play()
  }
  const collapse = () => {
    if (!demo) return
    clock.pause()
    clock.seek(Math.max(0, demo.hero.tCollapse - 40))
    clock.setSpeed(DISPLAY_SCALE)
    frame('close')
    clock.play()
  }
  const t = playback.t
  const destroyed = demo?.plan.filter((d) => d.collapse && t >= d.tCollapse).length ?? 0
  const phase = !demo ? 'Preparing the city' : t < START ? 'Before the storm' : t > END ? 'Aftermath' : destroyed ? 'Destruction in progress' : 'Tornado approaching'
  const chapters = [
    { label: 'Before', t: 0 },
    { label: 'Touchdown', t: START + 30 },
    { label: 'Collapse', t: (demo?.hero.tCollapse ?? 240) + 18 },
    { label: 'Aftermath', t: HORIZON },
  ]

  return (
    <main className="tornado-demo" data-demo-phase={phase}>
      <WorldCanvas packId="toronto" quality="balanced" onReady={onReady} onError={setError} />
      <header className="tornado-header">
        <div className="tornado-wordmark"><BrandMark size={23} /><span>Concrete Consequences</span></div>
        <span className="tornado-location">Downtown Toronto</span>
        <span className="tornado-badge">DESTRUCTION LAB</span>
        <a href="/world">Open city sandbox</a>
      </header>

      <aside className="tornado-story">
        <span className="tornado-eyebrow">GOD MODE / 01</span>
        <h1>Make an<br />entrance.</h1>
        <p>Drop a tornado into Toronto. Watch the skyline sway, fracture, and fall.</p>
        <button className="tornado-primary" onClick={start} disabled={!demo}>Play tornado demo</button>
        <button className="tornado-secondary" onClick={collapse} disabled={!demo}>Watch a building collapse</button>
        <div className="tornado-story-note">Orbit freely. Scrub backward.<br />The same city comes back.</div>
      </aside>

      <aside className="tornado-readout">
        <span className="tornado-eyebrow">{phase}</span>
        <div><strong>{destroyed.toString().padStart(2, '0')}</strong><span>buildings failed<br /><small>visual damage model</small></span></div>
        <p>{demo ? `${demo.plan.length} animated buildings · 110 m footprint` : 'Loading real city geometry…'}</p>
        <nav aria-label="Demo camera">
          <button className={view === 'overview' ? 'on' : ''} onClick={() => frame('overview')} disabled={!demo}>Overview</button>
          <button className={view === 'close' ? 'on' : ''} onClick={() => frame('close')} disabled={!demo}>Close-up</button>
        </nav>
      </aside>

      <section className="tornado-transport" aria-label="Destruction playback">
        <div className="tornado-transport-top">
          <div className="tornado-play-controls">
            <button className="tornado-play" onClick={() => clock.toggle()} disabled={!demo} aria-label={playback.playing ? 'Pause demo' : 'Play demo'}>
              <svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor" aria-hidden="true"><path d={playback.playing ? 'M5 3h3v14H5zm7 0h3v14h-3z' : 'M5 2l13 8-13 8z'} /></svg>
            </button>
            <button onClick={() => seek(0)} disabled={!demo}>Reset</button>
            <output aria-label="Demo time">{timeLabel(t)} <span>/ {timeLabel(HORIZON)}</span></output>
          </div>
          <div className="tornado-chapters">
            {chapters.map((chapter) => <button key={chapter.label} onClick={() => seek(chapter.t)} disabled={!demo}>{chapter.label}</button>)}
          </div>
          <div className="tornado-speeds">
            {[0.5, 1, 2].map((speed) => <button key={speed} className={playback.speed === speed ? 'on' : ''} onClick={() => { clock.setSpeed(DISPLAY_SCALE * speed); setPlayback((p) => ({ ...p, speed })) }}>{speed}×</button>)}
          </div>
        </div>
        <div className="tornado-timeline">
          <div className="tornado-storm-window" style={{ left: `${START / HORIZON * 100}%`, width: `${(END - START) / HORIZON * 100}%` }} />
          {demo?.plan.filter((d) => d.collapse).map((d) => <i key={d.key} style={{ left: `${d.tCollapse / HORIZON * 100}%` }} />)}
          <input type="range" aria-label="Destruction timeline" min={0} max={HORIZON} step={0.5} value={t} onChange={(event) => seek(Number(event.target.value))} disabled={!demo} />
        </div>
        <div className="tornado-transport-note"><span>VISUAL PROTOTYPE · Not structural physics or a new SUMO run.</span><span>Drag to orbit · Scroll to zoom · Space to pause{fps > 0 ? ` · ${fps} fps` : ''}</span></div>
      </section>
      {error && <div className="tornado-error" role="alert"><b>Demo unavailable</b><p>{error}</p><a href="/tornado">Reload the demo</a></div>}
    </main>
  )
}
