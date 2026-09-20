import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { GlobeScene } from './GlobeScene'
import { cityClickAction, entryVisuals, ENTRY_REVEAL, LOCATIONS, type Location } from './flight'
import { GlassButton, GlassSurface } from '../gods-plan/ui'
import { GodIcon } from '../gods-plan/icons'
import CityPicker from './CityPicker'
import GlobeSettings from './GlobeSettings'
import type { ScenarioSpec } from '../types'
import '@fontsource-variable/geist'
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
  const rootRef = useRef<HTMLElement>(null)
  const stageRef = useRef<HTMLElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const progressRef = useRef<HTMLProgressElement>(null)
  const settingsButton = useRef<HTMLButtonElement>(null)
  const labels = useRef(new Map<string, HTMLButtonElement>())
  const sceneRef = useRef<GlobeScene | null>(null)
  const callbacks = useRef(props)
  const chosenRef = useRef<Location | null>(null)
  const focusSelection = useRef(false)
  const settingsId = useId()
  useLayoutEffect(() => { callbacks.current = props }, [props])
  const [ready, setReady] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [imageryError, setImageryError] = useState(false)
  const [tactical, setTactical] = useState(false)
  const [chosen, setChosen] = useState<Location | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(true)
  const busy = props.phase !== 'globe'
  const target = props.selected ?? chosen

  useEffect(() => {
    if (!canvasRef.current) return
    try {
      const scene = new GlobeScene(canvasRef.current, labels.current, {
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

  useLayoutEffect(() => {
    if (!ready) return
    const paint = (progress: number) => {
      const visual = entryVisuals(progress)
      const style = rootRef.current?.style
      if (style) {
        style.opacity = String(visual.opacity)
        style.setProperty('--entry-ui', String(visual.ui))
        style.setProperty('--entry-haze', String(visual.haze))
      }
      if (progressRef.current) progressRef.current.value = progress
    }
    if (props.phase !== 'flight' || !props.selected) {
      sceneRef.current?.cancel()
      paint(0)
      return
    }
    let revealed = false
    const reveal = () => {
      if (!revealed) { revealed = true; callbacks.current.onReveal() }
    }
    if (!sceneRef.current) { reveal(); callbacks.current.onComplete(); return }
    sceneRef.current.fly(props.selected, (progress) => {
      paint(progress)
      if (progress >= ENTRY_REVEAL) reveal()
    }, () => { reveal(); callbacks.current.onComplete() })
    return () => sceneRef.current?.cancel()
  }, [props.phase, props.selected, ready])

  useEffect(() => {
    if (chosen && !busy && focusSelection.current) sceneRef.current?.focus(chosen)
  }, [chosen, busy, ready])

  // Once the entry starts, the globe stops being a framed square: it takes the whole window so the descent
  // never reveals a canvas edge. The stage's own ResizeObserver refits the engine as it grows.
  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const vars = ['--stage-left', '--stage-top', '--stage-width', '--stage-height'] as const
    if (props.phase !== 'flight') {
      for (const name of vars) stage.style.removeProperty(name)
      return
    }
    const rect = stage.getBoundingClientRect()
    stage.style.setProperty('--stage-left', `${rect.left}px`)
    stage.style.setProperty('--stage-top', `${rect.top}px`)
    stage.style.setProperty('--stage-width', `${rect.width}px`)
    stage.style.setProperty('--stage-height', `${rect.height}px`)
    const frame = requestAnimationFrame(() => {
      stage.style.setProperty('--stage-left', '0px')
      stage.style.setProperty('--stage-top', '0px')
      stage.style.setProperty('--stage-width', '100vw')
      stage.style.setProperty('--stage-height', '100dvh')
    })
    return () => cancelAnimationFrame(frame)
  }, [props.phase])

  useEffect(() => {
    if (!busy) return
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      callbacks.current.onCancel()
    }
    window.addEventListener('keydown', cancel, true)
    return () => window.removeEventListener('keydown', cancel, true)
  }, [busy])

  const choose = (place: Location, focus = true) => {
    if (busy) return
    if (cityClickAction(chosenRef.current, place) === 'enter') { props.onSelect(place); return }
    chosenRef.current = place
    focusSelection.current = focus
    setChosen(place)
  }

  return (
    <main ref={rootRef} className="gp-shell orbital" data-busy={busy} data-phase={props.phase}>
      <div className="orbital-sky" aria-hidden="true" />

      <header className="orbital-bar">
        <a className="orbital-brand" href="/" aria-label="God's Plan home"><span className="orbital-logo-placeholder" aria-hidden="true"><i /></span><span>God's Plan</span></a>
        <GlassButton ref={settingsButton} className="orbital-settings-trigger" variant="ghost" disabled={busy} aria-label="Settings" aria-controls={settingsId} aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}><GodIcon name="settings" size={17} /><span>Settings</span></GlassButton>
      </header>

      <div className="orbital-content">
        <div className="orbital-rail">
          <CityPicker selected={target} hovered={hovered} disabled={busy} error={busy ? props.error : null} onChoose={choose} onHover={setHovered} />
        </div>

        <section ref={stageRef} className="orbital-stage" aria-label="Interactive Earth">
          <div className="orbital-aureole" aria-hidden="true" />
          <canvas ref={canvasRef} tabIndex={busy ? -1 : 0} aria-label="Drag or use arrow keys to rotate Earth. Click a city to select it, then click it again to enter." />
          <div className="orbital-pin-layer">
            {LOCATIONS.map((place) => <button key={place.id} ref={(element) => { if (element) labels.current.set(place.id, element); else labels.current.delete(place.id) }} type="button" className="orbital-pin" data-city={place.id} data-hovered={hovered === place.id} aria-label={`${target?.id === place.id ? 'Enter' : 'Select'} ${place.name} on globe`} aria-pressed={target?.id === place.id} disabled={busy} onClick={() => choose(place, false)} onPointerEnter={() => setHovered(place.id)} onPointerLeave={() => setHovered(null)} onFocus={() => setHovered(place.id)} onBlur={() => setHovered(null)}><i /><span>{place.name}</span></button>)}
          </div>
          {failure && <GlassSurface tone="light" className="orbital-render-error" role="status"><b>Globe unavailable</b><span>You can still choose a city from the list.</span><a href="/world">Open city directly</a></GlassSurface>}
          {!ready && !failure && <div className="orbital-loading" role="status">Bringing the world into view…</div>}
          {imageryError && <span className="orbital-imagery-note" role="status">Earth imagery is unavailable. You can still choose a city.</span>}
        </section>

        <div className="orbital-rail orbital-rail-right">
          {settingsOpen && <GlobeSettings id={settingsId} disabled={busy} monochrome={tactical} setMonochrome={setTactical} onClose={() => { setSettingsOpen(false); settingsButton.current?.focus() }} />}
        </div>
      </div>

      {busy && <progress ref={progressRef} className="gp-sr-only" max={1} aria-label="Flight progress" />}
      {props.phase === 'preparing' && <div className="orbital-entry-status" role="status"><span>{props.error ? 'Unable to open city' : `Preparing ${target?.name ?? 'city'}…`}</span><GlassButton variant="ghost" aria-label="Cancel city entry" onClick={props.onCancel}>Cancel</GlassButton></div>}
      <div className="orbital-haze" aria-hidden="true" />
    </main>
  )
}
