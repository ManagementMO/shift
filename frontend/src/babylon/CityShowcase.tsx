import { useCallback, useEffect, useRef, useState } from 'react'
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector'
import WorldCanvas from './WorldCanvas'
import type { WorldScene } from './scene'
import { useReplay } from './useReplay'
import { clock } from '../world/playback'
import './world.css'
import './showcase.css'

const VIEWS = ['Downtown', 'The stadium', 'Union Station', 'Waterfront'] as const
export default function CityShowcase() {
  const scene = useRef<WorldScene | null>(null)
  const labels = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState<WorldScene | null>(null)
  const [view, setView] = useState(0)
  const [light, setLight] = useState<'afternoon' | 'golden'>('afternoon')
  const [projection, setProjection] = useState<'isometric' | 'perspective'>('isometric')
  const [clean, setClean] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [fps, setFps] = useState(0)
  const replay = useReplay('toronto', null)
  const rx = replay.phase === 'ready' ? replay.rx : null
  const onReady = useCallback((ws: WorldScene) => {
    scene.current = ws
    if (window.__cityshift) window.__cityshift.babylon = ws
    ws.scene.onDisposeObservable.addOnce(() => {
      if (window.__cityshift?.babylon === ws) window.__cityshift.babylon = undefined
      if (scene.current === ws) scene.current = null
    })
    setReady(ws)
  }, [])
  useEffect(() => {
    if (!ready) return
    ready.traffic.setReplay(rx)
    const off = clock.onFrame(t => { ready.simT = t })
    if (rx) { clock.setHorizon(rx.tMax); clock.seek(ready.traffic.releaseQuantile(0.35) ?? 300); clock.setSpeed(10); clock.play() }
    return () => { off(); clock.pause() }
  }, [ready, rx])
  useEffect(() => {
    if (!ready) return
    const id = setInterval(() => { setTime(clock.t); setPlaying(clock.playing); setFps(Math.round(ready.fps)) }, 750)
    const observer = ready.scene.onAfterRenderObservable.add(() => {
      if (!labels.current) return
      const cam = ready.camera.cam, e = ready.engine
      const viewport = cam.viewport.toGlobal(e.getRenderWidth(), e.getRenderHeight())
      const scaling = e.getHardwareScalingLevel()
      for (const el of labels.current.querySelectorAll<HTMLElement>('[data-landmark]')) {
        const l = ready.world.landmarks.find(l => l.kind === el.dataset.landmark)
        if (!l) continue
        const p = Vector3.Project(new Vector3(l.x, l.h + 9, l.z), Matrix.IdentityReadOnly, ready.scene.getTransformMatrix(), viewport)
        const x = p.x * scaling, y = p.y * scaling
        el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`
        el.style.opacity = p.z >= 0 && p.z <= 1 && y > 80 && y < window.innerHeight - 120 && x > 80 && x < window.innerWidth - 80 ? '1' : '0'
      }
    })
    return () => { clearInterval(id); ready.scene.onAfterRenderObservable.remove(observer) }
  }, [ready])
  const travel = (index: number) => {
    const ws = scene.current
    if (!ws) return
    setView(index)
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const ms = reduced ? 0 : 1500
    if (index === 0) { ws.camera.city(ms); setProjection('isometric'); return }
    const l = ws.world.landmarks.find(l => l.kind === (index === 1 ? 'rogers_centre' : index === 2 ? 'union_station' : 'cn_tower'))
    if (!l) return
    ws.camera.flyTo(index === 1 ? { target: [l.x + 120, l.z + 20], radius: 750, heading: -30, elevation: 42, y: 100 } : index === 2 ? { target: [l.x, l.z + 170], radius: 800, heading: -24, elevation: 47, y: 65 } : { target: [l.x + 250, l.z - 380], radius: 1050, heading: -55, elevation: 39, y: 60 }, ms, 'district')
  }
  const changeLight = () => { const next = light === 'afternoon' ? 'golden' : 'afternoon'; ready?.setLighting(next); setLight(next) }
  const changeProjection = () => { const next = projection === 'isometric' ? 'perspective' : 'isometric'; ready?.camera.setProjection(next); setProjection(next) }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /input|textarea|select/i.test(e.target.tagName)) return
      if (/^[1-4]$/.test(e.key)) travel(Number(e.key)-1)
      if (e.key.toLowerCase() === 'h') setClean(c => !c)
      if (e.key === ' ') { e.preventDefault(); if (rx) { clock.toggle(); setPlaying(clock.playing) } }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })
  return (
    <main className={`cityscape ${clean ? 'cityscape-clean' : ''}`}>
      <WorldCanvas packId="toronto" onReady={onReady} />
      <div className="cityscape-labels" ref={labels} aria-hidden="true">
        <span data-landmark="cn_tower">CN Tower</span>
        <span data-landmark="rogers_centre">Rogers Centre</span>
        <span data-landmark="union_station">Union Station</span>
      </div>
      <header className="cityscape-header cityscape-ui">
        <a className="cityscape-wordmark" href="/" aria-label="Open CITY SHIFT simulation">CITY<span>//</span>SHIFT</a>
        <div className="cityscape-location"><i /> Toronto, Ontario <span>Canada</span></div>
        <a className="cityscape-simulation" href="/">Open simulation <span>↗</span></a>
      </header>
      <section className="cityscape-title cityscape-ui" aria-label="Toronto cityscape">
        <span className="cityscape-eyebrow">Downtown & the waterfront</span>
        <h1>Toronto,<br/><em>in motion.</em></h1>
        <p>The waterfront. The skyline.<br/>A different way to see the city.</p>
        <div className="cityscape-rule" />
        <span className="cityscape-coordinate">43°38′ N &nbsp; 79°23′ W</span>
      </section>
      <div className="cityscape-settings cityscape-ui" aria-label="View settings">
        <button onClick={changeLight} disabled={!ready} aria-label="Change lighting">{light === 'afternoon' ? '☀ Afternoon' : '◐ Golden hour'}</button>
        <button onClick={changeProjection} disabled={!ready} aria-label="Change projection">{projection === 'isometric' ? '◇ Isometric' : '◈ Perspective'}</button>
      </div>
      <div className="cityscape-navigation cityscape-ui">
        <button onClick={() => ready && ready.camera.flyTo({ ...ready.camera.pose, radius: Math.max(90, ready.camera.pose.radius * 0.8) }, 300)} aria-label="Zoom in" disabled={!ready}>+</button>
        <button onClick={() => ready && ready.camera.flyTo({ ...ready.camera.pose, radius: Math.min(7000, ready.camera.pose.radius * 1.25) }, 300)} aria-label="Zoom out" disabled={!ready}>−</button>
        <button onClick={() => travel(0)} aria-label="Reset view" disabled={!ready}>⌂</button>
      </div>
      <footer className="cityscape-footer cityscape-ui">
        <nav className="cityscape-views" aria-label="Explore Toronto">
          {VIEWS.map((name, i) => <button key={name} onClick={() => travel(i)} className={view === i ? 'active' : ''} aria-pressed={view === i} disabled={!ready}><span>0{i+1}</span>{name}</button>)}
        </nav>
        <div className="cityscape-playback">
          <button disabled={!rx || !ready} onClick={() => { clock.toggle(); setPlaying(clock.playing) }} aria-label={playing ? 'Pause recorded traffic' : 'Play recorded traffic'}>{playing ? 'Ⅱ' : '▶'}</button>
          <div><b>{rx ? 'Recorded city movement' : replay.phase === 'error' ? 'Replay unavailable' : replay.phase === 'none' ? 'No recorded run yet' : 'Loading city movement'}</b><span>{rx ? `${Math.floor(time / 60).toString().padStart(2,'0')}:${Math.floor(time % 60).toString().padStart(2,'0')} elapsed · SUMO replay · 10×` : replay.phase === 'none' || replay.phase === 'error' ? 'The city is ready to explore' : 'Explore the city while replay loads'}</span></div>
          <span className="cityscape-fps">{fps || '—'} <small>fps</small></span>
        </div>
      </footer>
      <div className="cityscape-credit cityscape-ui"><a href="https://open.toronto.ca/dataset/3d-massing/" target="_blank" rel="noreferrer">{ready?.world.massing ? 'Toronto Open Data · 2025 building forms' : 'Procedural building forms'}</a><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a></div>
      <button className="cityscape-hide" onClick={() => setClean(c => !c)} aria-label={clean ? 'Show interface' : 'Hide interface'}>{clean ? 'Show interface' : 'Hide interface'} <kbd>H</kbd></button>
    </main>
  )
}
