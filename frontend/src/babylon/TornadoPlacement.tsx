import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { WorldScene } from './scene'
import { dragPlacement, driftTarget, headingLabel, pickTornadoGround, placementDirection, placementShortcut, POWER_NAMES, projectTornadoPoint, tornadoHeight, tornadoPower, tornadoRadius, type GroundPoint, type TornadoSettings } from './tornadoPlacement'

export function TornadoGlyph({ size = 26 }: { size?: number }) {
  return <svg viewBox="0 0 32 32" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M5 7c4-4 23-4 23 0s-16 5-21 1M7 13c4 2 15 2 17-1M10 18c3 2 10 1 11-1M13 22c3 1 5 0 6-1M15 26l2 2" /></svg>
}

type Preview = { point: GroundPoint; edge: GroundPoint; radius: number; dragging: boolean; direction: [number, number]; mouse: [number, number] }
type Drag = { point: GroundPoint; mouse: [number, number]; pointer: number; fallback: number; radius?: number }

function suspendCamera(scene: WorldScene): () => void {
  const canvas = scene.canvas, camera = scene.camera.cam
  const cursor = canvas.style.cursor
  const controls = camera.inputs.attachedToElement
  const travel = scene.keys.enabled
  scene.camera.cancel()
  scene.keys.setEnabled(false)
  camera.detachControl()
  camera.inertialAlphaOffset = camera.inertialBetaOffset = camera.inertialRadiusOffset = 0
  camera.inertialPanningX = camera.inertialPanningY = 0
  canvas.style.cursor = 'crosshair'
  return () => {
    canvas.style.cursor = cursor
    if (!scene.scene.isDisposed) {
      scene.keys.setEnabled(travel)
      if (controls && !scene.camera.fixed) camera.attachControl(false, true, 1)
    }
  }
}

export default function TornadoPlacement({ scene, armed, settings, onSettings, onCast, onCancel }: {
  scene: WorldScene | null
  armed: boolean
  settings: TornadoSettings
  onSettings: (patch: Partial<TornadoSettings>) => void
  onCast: (point: GroundPoint, direction: [number, number], settings: TornadoSettings) => void
  onCancel: () => void
}) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const arrowId = useId()
  const latest = useRef({ settings, onSettings, onCast, onCancel })
  useLayoutEffect(() => { latest.current = { settings, onSettings, onCast, onCancel } }, [settings, onSettings, onCast, onCancel])

  useEffect(() => {
    if (!scene || !armed) return
    const canvas = scene.canvas
    let drag: Drag | null = null
    let cursor: [number, number] | null = null
    let raf = 0
    const restore = suspendCamera(scene)
    const change = (patch: Partial<TornadoSettings>) => {
      latest.current.settings = { ...latest.current.settings, ...patch }
      if (drag && patch.radius !== undefined) {
        drag.radius = patch.radius
        setPreview((p) => p ? { ...p, radius: patch.radius! } : p)
      }
      latest.current.onSettings(patch)
    }

    const ground = (x: number, y: number) => {
      const rect = canvas.getBoundingClientRect()
      if (x < rect.left || y < rect.top || x > rect.right || y > rect.bottom) return null
      const p = pickTornadoGround(scene.scene, x - rect.left, y - rect.top)
      return p && scene.frame.contains(p.x, p.z) ? p : null
    }
    const draw = () => {
      raf = 0
      if (!cursor) { setPreview(null); return }
      const hit = ground(...cursor)
      if (!hit) { setPreview(null); return }
      const anchor = drag?.point ?? hit
      const distance = drag ? Math.hypot(cursor[0] - drag.mouse[0], cursor[1] - drag.mouse[1]) : 0
      const placement = dragPlacement(anchor, hit, distance, drag?.fallback ?? latest.current.settings.radius)
      if (drag?.radius !== undefined) placement.radius = drag.radius
      if (drag && placement.radius !== latest.current.settings.radius) change({ radius: placement.radius })
      setPreview({ point: anchor, edge: hit, radius: placement.radius, direction: placement.direction, dragging: !!drag, mouse: cursor })
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(draw) }
    const move = (event: PointerEvent) => {
      if (drag && drag.pointer !== event.pointerId) return
      if (drag && (cursor?.[0] !== event.clientX || cursor?.[1] !== event.clientY)) drag.radius = undefined
      cursor = [event.clientX, event.clientY]
      schedule()
    }
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary || drag) return
      const point = ground(event.clientX, event.clientY)
      if (!point) return
      event.preventDefault()
      drag = { point, mouse: [event.clientX, event.clientY], pointer: event.pointerId, fallback: latest.current.settings.radius }
      cursor = [event.clientX, event.clientY]
      canvas.setPointerCapture(event.pointerId)
      schedule()
    }
    const release = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointer || event.button !== 0) return
      const current = drag
      drag = null
      const hit = ground(event.clientX, event.clientY)
      const overCanvas = document.elementFromPoint(event.clientX, event.clientY) === canvas
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      if (!hit || !overCanvas) { cursor = null; setPreview(null); return }
      const distance = Math.hypot(event.clientX - current.mouse[0], event.clientY - current.mouse[1])
      const placement = dragPlacement(current.point, hit, distance, current.fallback)
      setPreview(null)
      latest.current.onCast(current.point, placement.direction, { ...latest.current.settings, radius: current.radius ?? placement.radius })
    }
    const cancelPointer = () => { drag = null; cursor = null; setPreview(null) }
    const leave = () => { if (!drag) { cursor = null; setPreview(null) } }
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      event.preventDefault()
      const s = latest.current.settings
      change(event.shiftKey ? { power: tornadoPower(s.power - Math.sign(event.deltaY)) } : { radius: tornadoRadius(s.radius - Math.sign(event.deltaY) * 5) })
    }
    const cancel = (event: Event) => { event.preventDefault(); latest.current.onCancel() }
    const key = (event: KeyboardEvent) => {
      if (event.code === 'Escape') { cancel(event); return }
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return
      if (event.target instanceof HTMLElement && event.target.closest('textarea, select, input:not([type="range"]), [contenteditable="true"]')) return
      const patch = placementShortcut(latest.current.settings, event.code, event.shiftKey)
      if (patch) { event.preventDefault(); change(patch) }
    }
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointerup', release)
    canvas.addEventListener('pointercancel', cancelPointer)
    canvas.addEventListener('lostpointercapture', cancelPointer)
    canvas.addEventListener('pointerleave', leave)
    canvas.addEventListener('wheel', wheel, { passive: false })
    canvas.addEventListener('contextmenu', cancel)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', cancelPointer)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      if (drag && canvas.hasPointerCapture(drag.pointer)) canvas.releasePointerCapture(drag.pointer)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointerup', release)
      canvas.removeEventListener('pointercancel', cancelPointer)
      canvas.removeEventListener('lostpointercapture', cancelPointer)
      canvas.removeEventListener('pointerleave', leave)
      canvas.removeEventListener('wheel', wheel)
      canvas.removeEventListener('contextmenu', cancel)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', cancelPointer)
      restore()
    }
  }, [scene, armed])

  if (!armed || !scene || !preview) return null
  const rect = scene.canvas.getBoundingClientRect()
  const project = (x: number, y: number, z: number) => {
    const p = projectTornadoPoint(scene.scene, x, y, z)
    return { x: p.x + rect.left, y: p.y + rect.top }
  }
  const radius = preview.dragging ? preview.radius : settings.radius
  const ring = (r: number) => Array.from({ length: 81 }, (_, i) => {
    const angle = i / 80 * Math.PI * 2
    const p = project(preview.point.x + Math.cos(angle) * r, 0.8, preview.point.z + Math.sin(angle) * r)
    return `${p.x},${p.y}`
  }).join(' ')
  const center = project(preview.point.x, 0.8, preview.point.z)
  const height = Math.round(tornadoHeight(radius, settings.power))
  const top = project(preview.point.x, height, preview.point.z)
  const edge = project(preview.point.x + (preview.dragging ? preview.direction[0] : 1) * radius, 0.8, preview.point.z + (preview.dragging ? preview.direction[1] : 0) * radius)
  const direction = placementDirection(preview.direction, settings.heading)
  const drift = driftTarget(scene.frame, preview.point, direction, radius)
  const driftScreen = project(drift.x, 0.8, drift.z)
  const left = Math.max(12, Math.min(window.innerWidth - 214, preview.mouse[0] + 22))
  const y = Math.max(76, Math.min(window.innerHeight - 234, preview.mouse[1] + 18))
  return <div className="tornado-placement" aria-hidden="true">
    <svg width="100%" height="100%">
      <defs><marker id={arrowId} markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1l7 4-7 4" fill="none" stroke="#f0c88b" strokeWidth="1.8" /></marker></defs>
      <polyline points={ring(radius * 1.7)} className="placement-reach" />
      <polygon points={ring(radius)} className="placement-footprint" />
      <line x1={center.x} y1={center.y} x2={edge.x} y2={edge.y} className="placement-measure" />
      <line x1={center.x} y1={center.y} x2={top.x} y2={top.y} className="placement-height" />
      <path d={`M${top.x - 6} ${top.y}h12 M${center.x - 7} ${center.y}h14 M${center.x} ${center.y - 7}v14`} className="placement-measure" />
      {settings.drift && <line x1={center.x} y1={center.y} x2={driftScreen.x} y2={driftScreen.y} className="placement-route" markerEnd={`url(#${arrowId})`} data-heading={settings.heading ?? 90} />}
      <text x={(center.x + edge.x) / 2} y={(center.y + edge.y) / 2 - 8} className="placement-distance">{radius} m</text>
    </svg>
    <div className="placement-label" style={{ left, top: y }}>
      <TornadoGlyph size={31} />
      <div><b>{preview.dragging ? 'Release to summon' : 'Tornado ready'}</b><span>{radius} m radius · {POWER_NAMES[settings.power - 1]}</span><span>{height} m high · {settings.drift ? headingLabel(settings.heading) : 'Stationary'}</span><small><kbd>R</kbd> rotate · <kbd>Esc</kbd> cancel</small></div>
    </div>
  </div>
}
