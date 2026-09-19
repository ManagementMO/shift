import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { GlobeScene } from './GlobeScene'
import { LOCATIONS, smooth, type Location } from './flight'
import RecentWork from './RecentWork'
import SimulationSettings from '../shell/SimulationSettings'
import { BrandMark } from '../components/Icon'
import type { ScenarioSpec } from '../types'
import './globe.css'

export type GlobePhase = 'globe' | 'preparing' | 'flight'

interface Props {
  phase: GlobePhase
  selected: Location | null
  error: string | null
  onSelect: (place: Location, scenario?: ScenarioSpec) => void
  onReveal: () => void
  onComplete: () => void
  onCancel: () => void
}

export default function Globe(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const labels = useRef(new Map<string, HTMLButtonElement>())
  const sceneRef = useRef<GlobeScene | null>(null)
  const callbacks = useRef(props)
  useLayoutEffect(() => { callbacks.current = props }, [props])
  const [ready, setReady] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [imageryError, setImageryError] = useState(false)
  const [tactical, setTactical] = useState(true)
  const [progress, setProgress] = useState(0)
  const busy = props.phase !== 'globe'
  const target = props.selected ?? LOCATIONS[0]

  useEffect(() => {
    if (!canvasRef.current) return
    try {
      const scene = new GlobeScene(canvasRef.current, labels.current, {
        select: (place) => { if (callbacks.current.phase === 'globe') callbacks.current.onSelect(place) },
        imageryError: () => setImageryError(true),
      })
      sceneRef.current = scene
      if (window.__cityshift) window.__cityshift.globe = scene
      scene.scene.onAfterRenderObservable.addOnce(() => setReady(true))
      return () => {
        sceneRef.current = null
        if (window.__cityshift?.globe === scene) window.__cityshift.globe = undefined
        scene.dispose()
      }
    } catch (error) {
      const frame = requestAnimationFrame(() => {
        setFailure(error instanceof Error ? error.message : 'Globe renderer unavailable')
        setReady(true)
      })
      return () => cancelAnimationFrame(frame)
    }
  }, [])

  useEffect(() => { sceneRef.current?.setTactical(tactical) }, [tactical, ready])

  useEffect(() => {
    if (!ready) return
    if (props.phase !== 'flight' || !props.selected) {
      sceneRef.current?.cancel()
      const frame = requestAnimationFrame(() => setProgress(0))
      return () => cancelAnimationFrame(frame)
    }
    let revealed = false
    const reveal = () => {
      if (!revealed) { revealed = true; callbacks.current.onReveal() }
    }
    if (!sceneRef.current) { reveal(); callbacks.current.onComplete(); return }
    sceneRef.current.fly(props.selected, (t) => {
      setProgress(Math.round(t * 1000) / 1000)
      if (t >= 0.78) reveal()
    }, () => { reveal(); callbacks.current.onComplete() })
    return () => sceneRef.current?.cancel()
  }, [props.phase, props.selected, ready])

  const opacity = props.phase === 'flight' ? 1 - smooth((progress - 0.78) / 0.22) : 1
  const haze = props.phase === 'flight' ? Math.sin(smooth((progress - 0.6) / 0.4) * Math.PI) * 0.45 : 0
  const choose = (place: Location) => { if (!busy) props.onSelect(place) }

  return (
    <main className="orbital" data-busy={busy} style={{ opacity, '--entry-haze': haze } as CSSProperties}>
      <header className="orbital-header">
        <a className="orbital-brand" href="/" aria-label="Concrete Consequences home"><BrandMark /><span>Concrete Consequences</span></a>
        <span className="orbital-header-note">Toronto prototype</span>
      </header>

      <div className="orbital-panel orbital-panel-left"><SimulationSettings docked appearance={{ monochrome: tactical, setMonochrome: setTactical }} /></div>

      <section className="orbital-stage" aria-label="Interactive Earth">
        <canvas ref={canvasRef} tabIndex={0} aria-label="Rotate Earth by dragging or using the arrow keys. Select a city marker to enter." />
        <div className="orbital-pin-layer">
          {LOCATIONS.map((place) => <button key={place.id} ref={(element) => { if (element) labels.current.set(place.id, element); else labels.current.delete(place.id) }} className={`orbital-pin ${place.id === 'toronto' ? 'home' : ''}`} aria-label={`Fly to ${place.name}`} disabled={busy} onClick={() => choose(place)}><i /><span>{place.name}</span></button>)}
        </div>
        {failure && <div className="orbital-render-error"><b>Globe unavailable</b><span>{failure}</span><a href="/world">Open Toronto directly</a></div>}
        {!ready && !failure && <div className="orbital-render-error">Loading Earth…</div>}
        {imageryError && <span className="orbital-imagery-note">Earth imagery unavailable. Location selection still works.</span>}
        <div className="orbital-haze" aria-hidden="true" />
        {busy && <div className="orbital-flight-status" role="status" aria-live="polite"><div><span>{props.error ? 'Unable to open city' : props.phase === 'preparing' ? 'Preparing Toronto…' : `Opening ${target.name}`}</span><button onClick={props.onCancel}>Cancel</button></div><small>{props.error ?? 'Toronto prototype · From orbit to street level'}</small><progress max={1} value={props.phase === 'flight' ? progress : undefined} aria-label="Flight progress" /></div>}
      </section>

      <div className="orbital-panel orbital-panel-right"><RecentWork disabled={busy} onOpen={(place, scenario) => { if (!busy) props.onSelect(place, scenario) }} /></div>

      <footer className="orbital-footer"><span>Prototype · All markers open Toronto</span><span><a href="https://github.com/mrdoob/three.js" target="_blank" rel="noreferrer">Earth imagery</a><i /><a href="https://github.com/nvkelso/natural-earth-vector" target="_blank" rel="noreferrer">Natural Earth</a></span></footer>
    </main>
  )
}
