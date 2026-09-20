/**
 * WASD ground travel for the city camera.  Held keys slide the orbit target across the ground relative to the
 * way the camera is looking (W = further into the view), at a speed proportional to the orbit radius so the
 * city scrolls at the same on-screen pace whether you are over the skyline or a single block.  Movement eases
 * in and out; the camera's own angle and zoom are untouched, and a preset flight yields the moment a key goes
 * down, exactly as a pointer drag does.
 */

import type { Scene } from '@babylonjs/core/scene'

import type { WorldCamera } from './camera'
import type { WorldCrs } from './coords'

/** Physical key positions (`KeyboardEvent.code`), so ZQSD layouts work unchanged: [right, forward] on the ground. */
export const PAN_KEYS: Record<string, readonly [number, number]> = {
  KeyW: [0, 1],
  KeyS: [0, -1],
  KeyA: [-1, 0],
  KeyD: [1, 0],
}
/** Ground metres per second per metre of orbit radius. */
export const PAN_SPEED = 0.35
/** Shift multiplies the speed. */
export const PAN_BOOST = 2.5
/** How quickly velocity settles on the held direction (1/s). */
const PAN_RESPONSE = 12
const STOP_SPEED = 0.5
const VERTICAL_KEYS: Record<string, number> = { KeyE: 1, KeyQ: -1 }

/** Unit ground direction (x east, z north) for the held keys at a camera heading, or null when they cancel out. */
export function panDirection(pressed: Iterable<string>, headingDeg: number): [number, number] | null {
  let right = 0
  let forward = 0
  for (const code of pressed) {
    const k = PAN_KEYS[code]
    if (k) {
      right += k[0]
      forward += k[1]
    }
  }
  const len = Math.hypot(right, forward)
  if (len < 1e-9) return null
  right /= len
  forward /= len
  const h = (headingDeg * Math.PI) / 180
  // heading h looks toward (sin h, cos h); its right-hand side is (cos h, -sin h)
  return [Math.sin(h) * forward + Math.cos(h) * right, Math.cos(h) * forward - Math.sin(h) * right]
}

export class KeyboardPan {
  private readonly camera: WorldCamera
  private readonly bounds: WorldCrs['bounds_world']
  private readonly pressed = new Set<string>()
  private boost = false
  private vx = 0
  private vy = 0
  private vz = 0
  private readonly groundHeight: (x: number, z: number) => number
  private detach: (() => void) | null = null
  /** The shell turns this off while the city is hidden or still flying in from the globe. */
  enabled = true

  constructor(camera: WorldCamera, bounds: WorldCrs['bounds_world'], scene?: Scene, groundHeight = (_x: number, _z: number) => 0) {
    this.camera = camera
    this.bounds = bounds
    this.groundHeight = groundHeight
    if (scene) {
      const observer = scene.onBeforeRenderObservable.add(() => this.step(Math.min(0.1, scene.getEngine().getDeltaTime() / 1000)))
      scene.onDisposeObservable.addOnce(() => {
        scene.onBeforeRenderObservable.remove(observer)
        this.dispose()
      })
    }
  }

  /** True while the target is still sliding, so followers (agent camera) do not fight the keys. */
  get moving(): boolean {
    return this.vx !== 0 || this.vy !== 0 || this.vz !== 0
  }

  /** Listen on `target` (normally `window`); keys typed into fields are left alone. */
  attach(target: Window | HTMLElement): void {
    this.detach?.()
    const onDown = (e: Event): void => {
      const ev = e as KeyboardEvent
      if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey || typing(ev.target)) return
      this.boost = ev.shiftKey
      if (!ev.repeat) this.press(ev.code)
    }
    const onUp = (e: Event): void => {
      const ev = e as KeyboardEvent
      this.boost = ev.shiftKey
      this.pressed.delete(ev.code)
    }
    const onBlur = (): void => { this.release(); this.vx = this.vy = this.vz = 0 }
    const onFocus = (event: Event): void => { if (typing(event.target)) onBlur() }
    target.addEventListener('keydown', onDown)
    target.addEventListener('keyup', onUp)
    target.addEventListener('blur', onBlur)
    target.addEventListener('focusin', onFocus)
    this.detach = () => {
      target.removeEventListener('keydown', onDown)
      target.removeEventListener('keyup', onUp)
      target.removeEventListener('blur', onBlur)
      target.removeEventListener('focusin', onFocus)
      this.detach = null
    }
  }

  press(code: string): void {
    if ((!PAN_KEYS[code] && !VERTICAL_KEYS[code]) || !this.enabled || this.camera.fixed) return
    this.pressed.add(code)
    this.camera.mode = 'city'
    if (this.camera.flying) this.camera.cancel()
  }

  setBoost(on: boolean): void {
    this.boost = on
  }

  /** Forget every held key (focus lost, city hidden): the target glides to a stop. */
  release(): void {
    this.pressed.clear()
    this.boost = false
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    if (!on) { this.release(); this.vx = this.vy = this.vz = 0 }
  }

  /** Advance by `dt` seconds: ease velocity toward the held direction and slide the target inside the world. */
  step(dt: number): void {
    const cam = this.camera
    if (!this.enabled || cam.fixed || dt <= 0 || !Number.isFinite(dt)) return
    dt = Math.min(dt, 0.1)
    const dir = panDirection(this.pressed, cam.pose.heading)
    const vertical = Number(this.pressed.has('KeyE')) - Number(this.pressed.has('KeyQ'))
    const magnitude = Math.hypot(dir ? 1 : 0, vertical)
    const speed = magnitude ? cam.pose.radius * PAN_SPEED * (this.boost ? PAN_BOOST : 1) / magnitude : 0
    const k = Math.min(1, dt * PAN_RESPONSE)
    this.vx += ((dir ? dir[0] * speed : 0) - this.vx) * k
    this.vy += (vertical * speed - this.vy) * k
    this.vz += ((dir ? dir[1] * speed : 0) - this.vz) * k
    if (!magnitude && Math.hypot(this.vx, this.vy, this.vz) < STOP_SPEED) {
      this.vx = this.vy = this.vz = 0
      return
    }
    if (!this.moving) return
    cam.cam.target.addInPlaceFromFloats(this.vx * dt, this.vy * dt, this.vz * dt)
    cam.constrainEye(this.bounds, this.groundHeight)
  }

  dispose(): void {
    this.detach?.()
    this.release()
    this.vx = this.vy = this.vz = 0
  }
}

function typing(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.closest('input, textarea, select') !== null
}
