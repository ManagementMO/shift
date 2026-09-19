/**
 * Presents the Babylon world camera through the `SyncMap` surface the shell already drives (camera modes,
 * agent bubble projection, compare sync).  Mapbox poses (lon/lat, zoom, pitch, bearing) are converted to
 * world-metre poses; nothing in the shell needs to know which renderer is live.
 */

import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector'
import type { Observer } from '@babylonjs/core/Misc/observable'
import type { Camera } from '@babylonjs/core/Cameras/camera'

import type { CameraMode, CameraPose } from '../world/camera'
import { clock } from '../world/playback'
import type { SyncMap } from '../world/registry'
import type { Pose } from './camera'
import type { WorldScene } from './scene'

type MoveCb = (e: { originalEvent?: unknown }) => void

/** Web-Mercator metres per pixel at `lat` for `zoom`; the orbit radius scales like half a ~1000 px viewport. */
export const RADIUS_PX = 494
export function zoomToRadius(zoom: number, lat: number): number {
  return (RADIUS_PX * 156543.03 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom)
}
export function radiusToZoom(radius: number, lat: number): number {
  return Math.log2((RADIUS_PX * 156543.03 * Math.cos((lat * Math.PI) / 180)) / Math.max(1, radius))
}

export class BabylonSyncMap implements SyncMap {
  private readonly ws: WorldScene
  private readonly listeners = new Set<MoveCb>()
  private observer: Observer<Camera> | null = null
  private applyingSync = false

  constructor(ws: WorldScene) {
    this.ws = ws
    this.observer = ws.camera.cam.onViewMatrixChangedObservable.add(() => {
      if (this.applyingSync) return
      for (const cb of this.listeners) cb({})
    })
  }

  toPose(p: CameraPose): Pose {
    const [x, z] = this.ws.frame.lonLatToWorld(p.center[0], p.center[1])
    return { target: [x, z], radius: zoomToRadius(p.zoom, p.center[1]), heading: p.bearing, elevation: Math.max(8, 90 - p.pitch) }
  }

  private lat(): number {
    const p = this.ws.camera.pose
    return this.ws.frame.worldToLonLat(p.target[0], p.target[1])[1]
  }

  easeTo(o: CameraPose & { duration: number }): void {
    this.ws.camera.flyTo(this.toPose(o), o.duration)
  }

  flyTo(o: CameraPose & { duration: number }): void {
    this.ws.camera.flyTo(this.toPose(o), o.duration)
  }

  jumpTo(o: Partial<CameraPose>): void {
    const cur = this.ws.camera.pose
    const lat = this.lat()
    const next: Pose = { ...cur }
    if (o.center) {
      const [x, z] = this.ws.frame.lonLatToWorld(o.center[0], o.center[1])
      next.target = [x, z]
    }
    if (o.zoom !== undefined) next.radius = zoomToRadius(o.zoom, o.center?.[1] ?? lat)
    if (o.bearing !== undefined) next.heading = o.bearing
    if (o.pitch !== undefined) next.elevation = Math.max(8, 90 - o.pitch)
    this.ws.camera.cancel()
    this.applySynced(next)
  }

  /** Preserve exact world-space framing between Babylon panes; avoid lossy lon/lat round trips. */
  syncFrom(source: SyncMap): boolean {
    if (!(source instanceof BabylonSyncMap)) return false
    const next = source.ws.camera.pose, current = this.ws.camera.pose
    const projection = source.ws.camera.projection
    const equal = projection === this.ws.camera.projection && Math.abs(next.target[0]-current.target[0]) < 1e-6 && Math.abs(next.target[1]-current.target[1]) < 1e-6 && Math.abs((next.y ?? 0)-(current.y ?? 0)) < 1e-6 && Math.abs(next.radius-current.radius) < 1e-6 && Math.abs(next.heading-current.heading) < 1e-6 && Math.abs(next.elevation-current.elevation) < 1e-6
    if (!equal) {
      this.ws.camera.setProjection(projection)
      this.applySynced(next)
    }
    return true
  }

  private applySynced(pose: Pose): void {
    this.applyingSync = true
    try {
      this.ws.camera.cancel()
      const cam = this.ws.camera.cam
      cam.inertialAlphaOffset = cam.inertialBetaOffset = cam.inertialRadiusOffset = 0
      cam.inertialPanningX = cam.inertialPanningY = 0
      this.ws.camera.apply(pose)
      cam.getViewMatrix(true)
    } finally { this.applyingSync = false }
  }

  getCenter(): { lng: number; lat: number } {
    const p = this.ws.camera.pose
    const [lng, lat] = this.ws.frame.worldToLonLat(p.target[0], p.target[1])
    return { lng, lat }
  }

  getZoom(): number {
    return radiusToZoom(this.ws.camera.pose.radius, this.lat())
  }

  getPitch(): number {
    return 90 - this.ws.camera.pose.elevation
  }

  getBearing(): number {
    const h = this.ws.camera.pose.heading
    return ((h + 540) % 360) - 180
  }

  /** CSS-pixel screen position of a ground point. */
  project(lngLat: [number, number]): { x: number; y: number } {
    const [x, z] = this.ws.frame.lonLatToWorld(lngLat[0], lngLat[1])
    return this.projectWorld(x, 0, z)
  }

  projectWorld(x: number, y: number, z: number): { x: number; y: number } {
    const engine = this.ws.engine
    const cam = this.ws.camera.cam
    const w = engine.getRenderWidth()
    const h = engine.getRenderHeight()
    const p = Vector3.Project(new Vector3(x, y, z), Matrix.IdentityReadOnly, this.ws.scene.getTransformMatrix(), cam.viewport.toGlobal(w, h))
    const s = engine.getHardwareScalingLevel()
    return { x: p.x * s, y: p.y * s }
  }

  isMoving(): boolean {
    const c = this.ws.camera.cam
    return this.ws.camera.flying || c.inertialAlphaOffset !== 0 || c.inertialBetaOffset !== 0 || c.inertialRadiusOffset !== 0 || c.inertialPanningX !== 0 || c.inertialPanningY !== 0
  }

  on(ev: string, cb: MoveCb): void {
    if (ev === 'move') this.listeners.add(cb)
  }

  off(ev: string, cb: MoveCb): void {
    if (ev === 'move') this.listeners.delete(cb)
  }

  setCameraMode(mode: CameraMode): void {
    this.ws.camera.setProjection(mode === 'agent' ? 'perspective' : 'isometric')
  }

  /** Renderer-native hero framings the shell may offer when this map leads. */
  cityHero(): void {
    this.ws.camera.city()
  }

  /**
   * Blue Jays egress: frame the recorded release points looking at Rogers Centre and rewind the clock to
   * just before the first ~10% of travellers left.  Positions and times are the replay's, not staged.
   */
  egress(): boolean {
    const ws = this.ws
    const l = ws.world.landmarks.find((x) => x.kind === 'rogers_centre')
    const t0 = ws.traffic.releaseQuantile(0.1)
    const gate = ws.traffic.releaseCentroid()
    if (!l || t0 === null || !gate) return false
    const heading = (Math.atan2(l.x - gate[0], l.z - gate[1]) * 180) / Math.PI
    ws.camera.flyTo({ target: gate, radius: 300, heading, elevation: 46, y: 4 }, 1600, 'district')
    clock.seek(Math.max(0, t0 - 3))
    clock.setSpeed(1)
    if (!clock.playing) clock.play()
    return true
  }

  dispose(): void {
    if (this.observer) this.ws.camera.cam.onViewMatrixChangedObservable.remove(this.observer)
    this.observer = null
    this.listeners.clear()
  }
}
