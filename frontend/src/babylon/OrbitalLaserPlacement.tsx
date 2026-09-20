import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { GlassButton, GlassIconButton, GlassSurface } from '../gods-plan/ui'
import { GodIcon } from '../gods-plan/icons'
import { LASER_MAX_RADIUS, LASER_MIN_RADIUS, LASER_RADIUS_STEP, laserRadius } from './orbitalLaserModel'
import type { WorldScene } from './scene'
import { suspendCamera } from './placementControls'
import { pickTornadoGround, projectTornadoPoint, type GroundPoint } from './tornadoPlacement'

export default function OrbitalLaserPlacement({ scene, radius, onRadius, onFire, onCancel }: {
  scene: WorldScene
  radius: number
  onRadius: (radius: number) => void
  onFire: (point: GroundPoint) => void
  onCancel: () => void
}) {
  const [target, setTarget] = useState<GroundPoint | null>(null)
  const [hover, setHover] = useState<GroundPoint | null>(null)
  const [, redraw] = useState(0)
  const latest = useRef({ radius, onRadius, onCancel })
  useLayoutEffect(() => { latest.current = { radius, onRadius, onCancel } }, [radius, onRadius, onCancel])

  useEffect(() => {
    const canvas = scene.canvas
    const restore = suspendCamera(scene)
    let down: { x: number; y: number; id: number } | null = null
    let cursor: [number, number] | null = null
    let raf = 0
    const ground = (x: number, y: number): GroundPoint | null => {
      const rect = canvas.getBoundingClientRect()
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null
      const point = pickTornadoGround(scene.scene, x - rect.left, y - rect.top)
      return point && scene.frame.contains(point.x, point.z) ? point : null
    }
    const move = (event: PointerEvent) => {
      if (!event.isPrimary) return
      cursor = [event.clientX, event.clientY]
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; setHover(cursor ? ground(...cursor) : null) })
    }
    const start = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary || !ground(event.clientX, event.clientY)) return
      event.preventDefault()
      down = { x: event.clientX, y: event.clientY, id: event.pointerId }
      canvas.setPointerCapture(event.pointerId)
    }
    const end = (event: PointerEvent) => {
      if (!down || down.id !== event.pointerId) return
      const current = down
      down = null
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      if (event.button !== 0 || Math.hypot(event.clientX - current.x, event.clientY - current.y) > 6 || document.elementFromPoint(event.clientX, event.clientY) !== canvas) return
      const point = ground(event.clientX, event.clientY)
      if (point) setTarget(point)
    }
    const cancelPointer = () => {
      const current = down
      down = null
      if (current && canvas.hasPointerCapture(current.id)) canvas.releasePointerCapture(current.id)
      cursor = null
      setHover(null)
    }
    const resize = () => redraw(value => value + 1)
    const leave = () => { cursor = null; setHover(null) }
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      if (!event.ctrlKey && !event.metaKey && event.deltaY) latest.current.onRadius(laserRadius(latest.current.radius - Math.sign(event.deltaY) * LASER_RADIUS_STEP))
    }
    const cancel = (event: Event) => { event.preventDefault(); latest.current.onCancel() }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { cancel(event); return }
      if (event.ctrlKey || event.metaKey || event.altKey || event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]')) return
      if (event.code === 'BracketLeft' || event.code === 'BracketRight') {
        event.preventDefault()
        latest.current.onRadius(laserRadius(latest.current.radius + (event.code === 'BracketRight' ? LASER_RADIUS_STEP : -LASER_RADIUS_STEP)))
      }
    }
    canvas.addEventListener('pointerdown', start)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', end)
    canvas.addEventListener('pointercancel', cancelPointer)
    canvas.addEventListener('lostpointercapture', cancelPointer)
    canvas.addEventListener('pointerleave', leave)
    canvas.addEventListener('wheel', wheel, { passive: false })
    canvas.addEventListener('contextmenu', cancel)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', cancelPointer)
    window.addEventListener('resize', resize)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      canvas.removeEventListener('pointerdown', start)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', end)
      canvas.removeEventListener('pointercancel', cancelPointer)
      canvas.removeEventListener('lostpointercapture', cancelPointer)
      canvas.removeEventListener('pointerleave', leave)
      canvas.removeEventListener('wheel', wheel)
      canvas.removeEventListener('contextmenu', cancel)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', cancelPointer)
      window.removeEventListener('resize', resize)
      if (down && canvas.hasPointerCapture(down.id)) canvas.releasePointerCapture(down.id)
      restore()
    }
  }, [scene])

  const point = target ?? hover
  const rect = scene.canvas.getBoundingClientRect()
  const host = scene.canvas.closest('.gp-shell')?.getBoundingClientRect()
  const project = (x: number, z: number) => {
    const p = projectTornadoPoint(scene.scene, x, 0.85, z)
    return { x: p.x + rect.left - (host?.left ?? 0), y: p.y + rect.top - (host?.top ?? 0) }
  }
  const center = point ? project(point.x, point.z) : null
  const ring = point ? Array.from({ length: 97 }, (_, i) => {
    const angle = i / 96 * Math.PI * 2
    const p = project(point.x + Math.cos(angle) * radius, point.z + Math.sin(angle) * radius)
    return `${p.x},${p.y}`
  }).join(' ') : ''
  return <>
    {center && <svg className="gp-laser-reticle" aria-hidden="true"><polygon points={ring} /><path d={`M${center.x - 10} ${center.y}h20 M${center.x} ${center.y - 10}v20`} /></svg>}
    <GlassSurface className="gp-laser-targeting" role="dialog" aria-label="Target orbital laser" onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <header><GodIcon name="locate" size={20} /><strong>Orbital Laser</strong><GlassIconButton icon="close" label="Cancel targeting" onClick={onCancel} /></header>
      <p role="status">{target ? 'Target locked. Fire when ready.' : 'Click a spot on the map to target it.'}</p>
      <label className="gp-laser-radius"><span>Radius <b>{radius} m</b></span><input aria-label="Laser radius" type="range" min={LASER_MIN_RADIUS} max={LASER_MAX_RADIUS} step={LASER_RADIUS_STEP} value={radius} onChange={event => onRadius(laserRadius(event.currentTarget.valueAsNumber))} /></label>
      <GlassButton variant="ghost" aria-label="Target view centre" onClick={() => {
        const p = pickTornadoGround(scene.scene, rect.width / 2, rect.height / 2)
        if (p && scene.frame.contains(p.x, p.z)) setTarget(p)
      }}>View centre</GlassButton>
      <div className="gp-laser-actions"><GlassButton onClick={onCancel}>Cancel</GlassButton><GlassButton className="gp-laser-fire" variant="primary" disabled={!target} onClick={() => { if (target) onFire(target) }}><GodIcon name="bolt" size={17} />Fire orbital laser</GlassButton></div>
      <small>Scroll or [ / ] to resize · Esc to cancel</small>
    </GlassSurface>
  </>
}
