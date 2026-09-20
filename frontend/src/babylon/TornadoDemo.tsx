import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { BrandMark } from '../components/Icon'
import { clock } from '../world/playback'
import { DISPLAY_SCALE, type Destructible } from './destruction'
import type { WorldScene } from './scene'
import TornadoPlacement, { TornadoGlyph } from './TornadoPlacement.tsx'
import { DEFAULT_TORNADO, headingLabel, MAX_TORNADOES, placedTornado, placementShortcut, POWER_NAMES, tornadoHeight, type GroundPoint, type TornadoSettings, type TornadoTrack } from './tornadoPlacement'
import WorldCanvas from './WorldCanvas'
import '../App.css'
import './world.css'
import './tornadoDemo.css'

const INITIAL_HORIZON = 600

type Demo = { scene: WorldScene; hazards: TornadoTrack[]; plan: Destructible[]; hero: Destructible | null }
type View = 'overview' | 'close'

function snapshot(scene: WorldScene, hazards: TornadoTrack[]): Demo {
  const plan = hazards.flatMap((h) => scene.storm.storm(h)?.damage.plan ?? [])
  const hero = [...plan].filter((d) => d.collapse).sort((a, b) => b.h - a.h || a.key.localeCompare(b.key))[0] ?? null
  return { scene, hazards, plan, hero }
}

function viewDemo(demo: Demo, view: View): void {
  const { scene, hero } = demo
  const last = demo.hazards.at(-1)
  const anchor = scene.world.landmarks.find((l) => l.kind === 'cn_tower') ?? scene.world.venue
  const point = hero ? [hero.x, hero.z] : last ? scene.frame.lonLatToWorld(...last.waypoints[0]) : [anchor.x + 260, anchor.z + 60]
  scene.camera.cancel()
  scene.camera.setPreferredProjection('perspective')
  scene.camera.apply(view === 'close'
    ? { target: [point[0], point[1]], y: hero ? hero.base + hero.h * 0.36 : 60, radius: Math.max(440, (hero?.h ?? 140) * 3.8), heading: 25, elevation: 38 }
    : { target: [point[0] + 45, point[1] + 30], y: 90, radius: 1100, heading: -25, elevation: 42 })
}

function timeLabel(t: number): string {
  const seconds = Math.floor(t / DISPLAY_SCALE)
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

export default function TornadoDemo() {
  const sceneRef = useRef<WorldScene | null>(null)
  const hazardsRef = useRef<TornadoTrack[]>([])
  const sequence = useRef(0)
  const wasPlaying = useRef(false)
  const [demo, setDemo] = useState<Demo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('overview')
  const [armed, setArmed] = useState(false)
  const armedRef = useRef(armed)
  useLayoutEffect(() => { armedRef.current = armed }, [armed])
  const [settings, setSettings] = useState<TornadoSettings>({ ...DEFAULT_TORNADO })
  const [horizon, setHorizon] = useState(INITIAL_HORIZON)
  const [playback, setPlayback] = useState({ t: 0, playing: false, speed: 1 })
  const changeSettings = useCallback((patch: Partial<TornadoSettings>) => setSettings((s) => ({ ...s, ...patch })), [])
  const rotate = (back = false) => setSettings((s) => ({ ...s, ...placementShortcut(s, 'KeyR', back) }))

  const cancel = useCallback(() => {
    setArmed(false)
    if (wasPlaying.current) clock.play()
    wasPlaying.current = false
  }, [])

  const arm = useCallback(() => {
    if (!sceneRef.current || hazardsRef.current.length >= MAX_TORNADOES) return
    wasPlaying.current = clock.playing
    clock.pause()
    setArmed(true)
  }, [])

  useEffect(() => {
    const off = clock.onUi((t) => setPlayback({ t, playing: clock.playing, speed: clock.speed / DISPLAY_SCALE }))
    const hidden = () => { if (document.hidden) clock.pause() }
    const key = (event: KeyboardEvent) => {
      if (!sceneRef.current || event.ctrlKey || event.metaKey || event.altKey || (event.target instanceof HTMLElement && event.target.closest('input:not([type="range"]), select, textarea, [contenteditable="true"]'))) return
      if (event.code === 'KeyT' && !event.repeat) { event.preventDefault(); if (armedRef.current) cancel(); else arm(); return }
      if (armedRef.current || (event.target instanceof HTMLElement && event.target.closest('button, a'))) return
      if (event.code === 'Space') { event.preventDefault(); clock.toggle() }
      if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
        event.preventDefault()
        clock.pause()
        clock.seek(clock.t + (event.code === 'ArrowLeft' ? -10 : 10))
      }
    }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('keydown', key)
    return () => {
      off()
      clock.pause()
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('keydown', key)
    }
  }, [arm, cancel])

  const onReady = useCallback((scene: WorldScene) => {
    sceneRef.current = scene
    if (window.__cityshift) window.__cityshift.babylon = scene
    scene.scene.executeWhenReady(() => {
      if (scene.scene.isDisposed) return
      hazardsRef.current = []
      scene.storm.setHazards([])
      const next = snapshot(scene, [])
      clock.pause()
      clock.setFrontier(null)
      clock.setHorizon(INITIAL_HORIZON)
      clock.setSpeed(DISPLAY_SCALE)
      clock.seek(0)
      scene.simT = 0
      scene.setActive(true)
      viewDemo(next, 'overview')
      scene.invalidateShadows()
      let shadowTick = -1
      const off = clock.onFrame((t) => {
        scene.simT = t
        const tick = Math.floor(t / 5)
        if (tick !== shadowTick || !clock.playing) { scene.invalidateShadows(); shadowTick = tick }
      })
      scene.scene.onDisposeObservable.addOnce(() => {
        off()
        if (sceneRef.current === scene) sceneRef.current = null
        if (window.__cityshift?.babylon === scene) window.__cityshift.babylon = undefined
      })
      setDemo(next)
    })
  }, [])

  const apply = (hazards: TornadoTrack[]) => {
    const scene = sceneRef.current
    if (!scene) return
    hazardsRef.current = hazards
    scene.storm.setHazards(hazards)
    scene.simT = clock.t
    scene.storm.update(clock.t)
    scene.invalidateShadows()
    const end = Math.max(INITIAL_HORIZON, ...hazards.map((h) => h.end_s + 100))
    clock.setHorizon(end)
    setHorizon(end)
    setDemo(snapshot(scene, hazards))
  }
  const cast = (point: GroundPoint, direction: [number, number], chosen: TornadoSettings) => {
    const scene = sceneRef.current
    if (!scene || hazardsRef.current.length >= MAX_TORNADOES) return
    const hazard = placedTornado(scene.frame, point, direction, chosen, clock.t, `summoned-${++sequence.current}`)
    setSettings(chosen)
    apply([...hazardsRef.current, hazard])
    wasPlaying.current = false
    setArmed(false)
    clock.play()
  }
  const clear = () => {
    wasPlaying.current = false
    setArmed(false)
    clock.pause()
    clock.seek(0)
    apply([])
  }
  const playDemo = () => {
    const scene = sceneRef.current
    if (!scene) return
    wasPlaying.current = false
    setArmed(false)
    clock.pause()
    clock.seek(0)
    clock.setSpeed(DISPLAY_SCALE)
    const anchor = scene.world.landmarks.find((l) => l.kind === 'cn_tower') ?? scene.world.venue
    const hazard: TornadoTrack = {
      track_id: 'toronto-tornado-visual-demo',
      waypoints: [scene.frame.worldToLonLat(anchor.x + 20, anchor.z - 30), scene.frame.worldToLonLat(anchor.x + 580, anchor.z + 170)],
      radius_m: 110, power: 3, start_s: 30, end_s: 450, modes: [], label: 'Tornado destruction prototype — visual only',
    }
    apply([hazard])
    viewDemo(snapshot(scene, [hazard]), 'overview')
    setView('overview')
    clock.play()
  }
  const seek = (t: number) => { clock.pause(); clock.seek(t) }
  const frame = (next: View) => { if (demo) viewDemo(demo, next); setView(next) }
  const t = playback.t
  const hazards = demo?.hazards ?? []
  const destroyed = demo?.plan.filter((d) => d.collapse && t >= d.tCollapse).length ?? 0
  const active = hazards.filter((h) => t >= h.start_s && t <= h.end_s).length
  const phase = !demo ? 'Preparing the city' : armed ? 'Choose your impact' : active ? `${active} tornado${active === 1 ? '' : 'es'} active` : hazards.some((h) => t < h.start_s) ? 'Waiting for touchdown' : hazards.length ? 'Aftermath' : 'Sandbox ready'
  const last = hazards.at(-1)

  return (
    <main className={`tornado-demo${armed ? ' tornado-armed' : ''}`} data-demo-phase={phase}>
      <WorldCanvas packId="toronto" quality="balanced" onReady={onReady} onError={setError} />
      {armed && <TornadoPlacement scene={demo?.scene ?? null} armed={armed} settings={settings} onSettings={changeSettings} onCast={cast} onCancel={cancel} />}
      <header className="tornado-header">
        <div className="tornado-wordmark"><BrandMark size={23} /><span>Concrete Consequences</span></div>
        <span className="tornado-location">Downtown Toronto</span>
        <span className="tornado-badge">SANDBOX</span>
        <a href="/world">Open city simulation</a>
      </header>

      <aside className="tornado-readout">
        <span className="tornado-eyebrow">{phase}</span>
        <div><strong>{destroyed.toString().padStart(2, '0')}</strong><span>buildings failed<br /><small>visual damage model</small></span></div>
        <p>{hazards.length}/{MAX_TORNADOES} tornadoes{last ? ` · latest ${last.radius_m} m / power ${last.power ?? 3}` : ' · choose a power below'}</p>
        <nav aria-label="Demo camera">
          <button className={view === 'overview' ? 'on' : ''} onClick={() => frame('overview')} disabled={!demo || armed}>Overview</button>
          <button className={view === 'close' ? 'on' : ''} onClick={() => frame('close')} disabled={!demo || armed}>Close-up</button>
        </nav>
      </aside>

      <div className="tornado-power-dock">
        {armed && <aside className="tornado-power-options" aria-label="Tornado settings">
          <div className="power-options-heading"><TornadoGlyph size={23} /><b>Summon tornado</b><button onClick={cancel} aria-label="Cancel tornado placement">Esc</button></div>
          <label><span>Grow-to radius <b>{settings.radius} m</b></span><input aria-label="Tornado radius" type="range" min={30} max={240} step={5} value={settings.radius} onChange={(e) => setSettings((s) => ({ ...s, radius: Number(e.target.value) }))} /></label>
          <div className="power-size-readout">{settings.radius * 2} m wide · up to {Math.round(tornadoHeight(settings.radius, settings.power))} m high</div>
          <div className="power-level-label"><span>Power</span><b>{POWER_NAMES[settings.power - 1]}</b></div>
          <div className="power-levels" role="group" aria-label="Tornado power">{[1, 2, 3, 4, 5].map((p) => <button key={p} className={settings.power === p ? 'on' : ''} aria-label={`Power ${p}: ${POWER_NAMES[p - 1]}`} aria-pressed={settings.power === p} onClick={() => setSettings((s) => ({ ...s, power: p }))}>{p}</button>)}</div>
          <div className="power-heading" role="group" aria-label="Tornado heading">
            <div><span>Direction</span><b>{headingLabel(settings.heading)}</b></div>
            <button onClick={() => rotate(true)} aria-label="Rotate counterclockwise" title="Rotate back 45° (Shift+R)"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ transform: 'scaleX(-1)' }} aria-hidden="true"><path d="M19 9a8 8 0 1 0 1 7M19 3v6h-6" /></svg></button>
            <button onClick={() => rotate()} aria-label="Rotate clockwise" title="Rotate 45° (R)"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M19 9a8 8 0 1 0 1 7M19 3v6h-6" /></svg><kbd>R</kbd></button>
          </div>
          <div className="power-movement" role="group" aria-label="Tornado movement"><button className={!settings.drift ? 'on' : ''} aria-pressed={!settings.drift} onClick={() => changeSettings({ drift: false })}>Stationary</button><button className={settings.drift ? 'on' : ''} aria-pressed={settings.drift} onClick={() => changeSettings({ drift: true })}>Travel <kbd>F</kbd></button></div>
          <details className="power-advanced"><summary>Lifetime <span>{settings.duration} s</span></summary><input aria-label="Tornado lifetime" type="range" min={10} max={60} step={5} value={settings.duration} onChange={(e) => changeSettings({ duration: Number(e.target.value) })} /></details>
        </aside>}
        <button className={`tornado-power-button${armed ? ' on' : ''}`} onClick={armed ? cancel : arm} disabled={!demo || (!armed && hazards.length >= MAX_TORNADOES)} aria-label="Tornado power" aria-pressed={armed} title="Tornado (T)"><TornadoGlyph size={30} /><span>Tornado</span><kbd>T</kbd></button>
        <div className="tornado-power-actions">
          {armed ? <div className="power-key-hints"><span><kbd>R</kbd> Rotate</span><span><kbd>[ ]</kbd> Size</span><span><kbd>1–5</kbd> Power</span><span><kbd>Esc</kbd> Cancel</span></div> : <span>{hazards.length >= MAX_TORNADOES ? 'Clear storms to summon more.' : 'Choose a power. Change the city.'}</span>}
          <div><button onClick={clear} disabled={!demo || !hazards.length}>Clear storms</button><button onClick={playDemo} disabled={!demo}>Demo scene</button></div>
        </div>
      </div>

      <section className="tornado-transport" aria-label="Destruction playback">
        <div className="tornado-transport-top">
          <div className="tornado-play-controls">
            <button className="tornado-play" onClick={() => clock.toggle()} disabled={!demo || armed || !hazards.length} aria-label={playback.playing ? 'Pause demo' : 'Play demo'}><svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor" aria-hidden="true"><path d={playback.playing ? 'M5 3h3v14H5zm7 0h3v14h-3z' : 'M5 2l13 8-13 8z'} /></svg></button>
            <button onClick={() => seek(0)} disabled={!demo || armed}>Rewind</button>
            <output aria-label="Demo time">{timeLabel(t)} <span>/ {timeLabel(horizon)}</span></output>
          </div>
          <div className="tornado-chapters"><button onClick={() => seek(0)} disabled={!demo || armed}>Before</button><button onClick={() => seek(demo!.hero!.tCollapse + 18)} disabled={!demo?.hero || armed}>Collapse</button><button onClick={() => seek(horizon)} disabled={!hazards.length || armed}>Aftermath</button></div>
          <div className="tornado-speeds">{[0.5, 1, 2].map((speed) => <button key={speed} className={playback.speed === speed ? 'on' : ''} onClick={() => { clock.setSpeed(DISPLAY_SCALE * speed); setPlayback((p) => ({ ...p, speed })) }}>{speed}×</button>)}</div>
        </div>
        <div className="tornado-timeline">
          {hazards.map((h) => <div key={h.track_id} className="tornado-storm-window" style={{ left: `${h.start_s / horizon * 100}%`, width: `${(h.end_s - h.start_s) / horizon * 100}%` }} />)}
          {demo?.plan.filter((d) => d.collapse).map((d) => <i key={d.key} style={{ left: `${d.tCollapse / horizon * 100}%` }} />)}
          <input type="range" aria-label="Destruction timeline" min={0} max={horizon} step={0.5} value={t} onChange={(event) => seek(Number(event.target.value))} disabled={!demo || armed} />
        </div>
        <div className="tornado-transport-note"><span>VISUAL SANDBOX · Does not change saved simulations.</span><span>{armed ? 'Drag to size · R to rotate · Release to summon' : 'Drag to orbit · Scroll to zoom · T for tornado · Space to pause'}</span></div>
      </section>
      {error && <div className="tornado-error" role="alert"><b>Sandbox unavailable</b><p>{error}</p><a href="/tornado">Reload the sandbox</a></div>}
    </main>
  )
}
