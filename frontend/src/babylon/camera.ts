/**
 * Strategic camera on top of ArcRotateCamera: named poses (city / district / corridor / agent / incident) and
 * eased flights between them.  Poses are in world metres; callers never touch alpha/beta directly.
 */

import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Camera } from '@babylonjs/core/Cameras/camera'

import type { WorldData } from './worldData'

export type CameraMode = 'city' | 'district' | 'corridor' | 'agent' | 'vehicle' | 'incident'

export interface Pose {
  target: [number, number] // x, z (world metres); target height is always ground
  radius: number
  /** heading the camera looks *toward*, degrees clockwise from north (0 = camera south of target looking north) */
  heading: number
  /** elevation above the ground plane in degrees (90 = straight down) */
  elevation: number
  y?: number
}

/** Downtown / waterfront hero: lake in the lower third, skyline rising toward the top of the frame. */
export function cityPose(world: WorldData): Pose {
  if (world.pack_id === 'waterloo_e7') {
    const e7 = world.landmarks.find((l) => l.kind === 'engineering_7') ?? world.venue
    return { target: [e7.x, e7.z], radius: 1050, heading: -35, elevation: 48 }
  }
  const cn = world.landmarks.find((l) => l.kind === 'cn_tower')
  const union = world.landmarks.find((l) => l.kind === 'union_station')
  if (cn && union) return { target: [(cn.x + union.x) / 2 + 40, (cn.z + union.z) / 2 + 80], radius: 1250, heading: -28, elevation: 43, y: 75 }
  const [x0, z0, x1, z1] = world.crs.bounds_world
  return { target: [(x0 + x1) / 2, (z0 + z1) / 2], radius: Math.max(450, Math.min(8500, Math.hypot(x1 - x0, z1 - z0) * 0.7)), heading: 22, elevation: 38 }
}

const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

export class WorldCamera {
  private flight: { from: Pose; to: Pose; t0: number; ms: number; raf: number } | null = null
  mode: CameraMode = 'city'
  readonly cam: ArcRotateCamera
  readonly world: WorldData
  projection: 'isometric' | 'perspective' = 'isometric'
  preferredProjection: 'isometric' | 'perspective' = 'isometric'

  constructor(cam: ArcRotateCamera, world: WorldData) {
    this.cam = cam
    this.world = world
    this.setProjection('isometric')
    this.apply(cityPose(world))
    cam.getScene().onBeforeRenderObservable.add(() => this.updateProjection())
  }

  setPreferredProjection(projection: 'isometric' | 'perspective'): void {
    this.preferredProjection = projection
    this.setProjection(projection)
  }

  setProjection(projection: 'isometric' | 'perspective'): void {
    this.projection = projection
    this.cam.mode = projection === 'isometric' ? Camera.ORTHOGRAPHIC_CAMERA : Camera.PERSPECTIVE_CAMERA
    this.updateProjection()
  }

  private updateProjection(): void {
    if (this.projection !== 'isometric') return
    const engine = this.cam.getEngine()
    const aspect = engine.getRenderWidth() / Math.max(1, engine.getRenderHeight())
    const half = this.cam.radius * 0.44
    this.cam.orthoLeft = -half * aspect
    this.cam.orthoRight = half * aspect
    this.cam.orthoBottom = -half
    this.cam.orthoTop = half
  }

  get flying(): boolean {
    return this.flight !== null
  }

  get pose(): Pose {
    const c = this.cam
    return {
      target: [c.target.x, c.target.z],
      radius: c.radius,
      heading: ((-90 - (c.alpha * 180) / Math.PI) % 360 + 360) % 360,
      elevation: 90 - (c.beta * 180) / Math.PI,
      y: c.target.y,
    }
  }

  apply(p: Pose): void {
    const c = this.cam
    c.target = new Vector3(p.target[0], p.y ?? 0, p.target[1])
    c.radius = p.radius
    // Babylon: position = target + r * (cos(alpha) sin(beta), cos(beta), sin(alpha) sin(beta)).
    // heading h (camera looks toward h) puts the camera at direction h+180 from the target.
    c.alpha = ((-90 - p.heading) * Math.PI) / 180
    c.beta = ((90 - p.elevation) * Math.PI) / 180
    this.updateProjection()
  }

  flyTo(to: Pose, ms = 1400, mode?: CameraMode): void {
    if (mode) this.mode = mode
    this.cancel()
    if (ms <= 0) { this.apply(to); return }
    const from = this.pose
    // shortest heading turn
    let dh = to.heading - from.heading
    dh = ((dh + 540) % 360) - 180
    const target: Pose = { ...to, heading: from.heading + dh }
    const t0 = performance.now()
    const step = (): void => {
      const k = Math.min(1, (performance.now() - t0) / ms)
      const e = ease(k)
      this.apply({
        target: [lerp(from.target[0], target.target[0], e), lerp(from.target[1], target.target[1], e)],
        radius: Math.exp(lerp(Math.log(from.radius), Math.log(target.radius), e)),
        heading: lerp(from.heading, target.heading, e),
        elevation: lerp(from.elevation, target.elevation, e),
        y: lerp(from.y ?? 0, target.y ?? 0, e),
      })
      if (k < 1) this.flight = { from, to: target, t0, ms, raf: requestAnimationFrame(step) }
      else this.flight = null
    }
    this.flight = { from, to: target, t0, ms, raf: requestAnimationFrame(step) }
  }

  cancel(): void {
    if (this.flight) cancelAnimationFrame(this.flight.raf)
    this.flight = null
  }

  city(ms = 1600): void {
    this.setProjection(this.preferredProjection)
    this.flyTo(cityPose(this.world), ms, 'city')
  }

  district(x: number, z: number, ms = 1200): void {
    this.flyTo({ target: [x, z], radius: 620, heading: this.pose.heading, elevation: 42 }, ms, 'district')
  }

  corridor(path: [number, number][], ms = 1200): void {
    const a = path[0]
    const b = path[path.length - 1]
    const dx = b[0] - a[0]
    const dz = b[1] - a[1]
    const along = (Math.atan2(dx, dz) * 180) / Math.PI
    const span = Math.hypot(dx, dz)
    let heading = along + 90
    const cur = this.pose.heading
    if (Math.abs((((heading - cur) % 360) + 540) % 360 - 180) < 80) heading += 180
    this.flyTo({ target: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], radius: Math.max(260, Math.min(1400, span * 1.1)), heading, elevation: 38 }, ms, 'corridor')
  }

  agent(x: number, z: number, heading: number | null, ms = 900): void {
    this.setProjection('perspective')
    this.flyTo({ target: [x, z], radius: 95, heading: heading ?? this.pose.heading, elevation: 28, y: 2 }, ms, 'agent')
  }

  incident(x: number, z: number, radiusM: number, ms = 1200): void {
    this.flyTo({ target: [x, z], radius: Math.max(220, radiusM * 3.2), heading: this.pose.heading + 25, elevation: 44 }, ms, 'incident')
  }

  /** Track a moving point (follow modes) without fighting the user's orbit: only the target moves. */
  follow(x: number, z: number, y = 0): void {
    if (this.flight) return
    this.cam.target.set(x, y, z)
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}
