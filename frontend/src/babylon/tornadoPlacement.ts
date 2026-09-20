import { CreatePickingRay } from '@babylonjs/core/Culling/ray.core'
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector'
import type { Scene } from '@babylonjs/core/scene'
import type { HazardTrack } from '../types'
import type { WorldFrame } from './coords'
import type { DamageOptions } from './destruction'

export type TornadoTrack = HazardTrack & { power?: number }
export type GroundPoint = { x: number; z: number }
export type TornadoSettings = { radius: number; power: number; duration: number; drift: boolean; heading?: number }
export const DEFAULT_TORNADO: TornadoSettings = { radius: 110, power: 3, duration: 30, drift: false, heading: 90 }
export const MAX_TORNADOES = 4
export const POWER_NAMES = ['Gentle', 'Strong', 'Violent', 'Devastating', 'Extreme']
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

export function tornadoPower(value = 3): number {
  return clamp(Math.round(Number.isFinite(value) ? value : 3), 1, 5)
}

export function tornadoRadius(value: number): number {
  return clamp(Math.round((Number.isFinite(value) ? value : 110) / 5) * 5, 30, 240)
}

export function normalizeHeading(value: number): number {
  return ((Number.isFinite(value) ? value : 90) % 360 + 360) % 360
}

export function headingLabel(value = 90): string {
  const heading = normalizeHeading(value)
  return `${['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(heading / 45) % 8]} · ${Math.round(heading)}°`
}

export function placementDirection(fallback: [number, number], heading?: number): [number, number] {
  if (heading === undefined) return fallback
  const angle = normalizeHeading(heading) * Math.PI / 180
  return [Math.sin(angle), Math.cos(angle)]
}

export function placementShortcut(settings: TornadoSettings, code: string, shift = false): Partial<TornadoSettings> | null {
  if (code === 'KeyR') return { heading: normalizeHeading((settings.heading ?? 90) + (shift ? -45 : 45)), drift: true }
  if (code === 'KeyF') return { drift: !settings.drift }
  if (/^Digit[1-5]$/.test(code)) return { power: Number(code.slice(-1)) }
  if (code === 'BracketLeft' || code === 'BracketRight') return { radius: tornadoRadius(settings.radius + (code === 'BracketLeft' ? -5 : 5)) }
  return null
}

export function tornadoHeight(radius: number, power = 3): number {
  return clamp(260 * Math.sqrt(radius / 110) * (0.7 + tornadoPower(power) * 0.1), 100, 700)
}

export function tornadoDamage(power = 3): Partial<DamageOptions> {
  const p = tornadoPower(power)
  return {
    maxSway: [28, 40, 56, 64, 72][p - 1],
    maxCollapse: [0, 3, 10, 14, 18][p - 1],
    maxCollapseHeight: [0, 65, 150, 220, 300][p - 1],
    collapseChance: [0, 0.4, 0.8, 0.9, 0.98][p - 1],
    collapseReach: [0, 0.5, 0.75, 0.85, 0.95][p - 1],
  }
}

export function dragPlacement(origin: GroundPoint, end: GroundPoint, screenDistance: number, fallback: number): { radius: number; direction: [number, number] } {
  const dx = end.x - origin.x, dz = end.z - origin.z
  const distance = Math.hypot(dx, dz)
  return { radius: screenDistance < 6 ? tornadoRadius(fallback) : tornadoRadius(distance), direction: distance > 0.1 ? [dx / distance, dz / distance] : [1, 0] }
}

export function driftTarget(frame: WorldFrame, origin: GroundPoint, direction: [number, number], radius: number): GroundPoint {
  const [x0, z0, x1, z1] = frame.crs.bounds_world
  return { x: clamp(origin.x + direction[0] * radius * 3, x0, x1), z: clamp(origin.z + direction[1] * radius * 3, z0, z1) }
}

export function placedTornado(frame: WorldFrame, origin: GroundPoint, direction: [number, number], settings: TornadoSettings, time: number, id: string): TornadoTrack {
  const radius = tornadoRadius(settings.radius)
  const power = tornadoPower(settings.power)
  const end = driftTarget(frame, origin, placementDirection(direction, settings.heading), radius)
  const start = Math.max(0, time) + 2
  return {
    track_id: id,
    waypoints: [frame.worldToLonLat(origin.x, origin.z), ...(settings.drift ? [frame.worldToLonLat(end.x, end.z)] : [])],
    radius_m: radius, power,
    start_s: start,
    end_s: start + clamp(Number.isFinite(settings.duration) ? settings.duration : 30, 10, 60) * 10,
    modes: [],
    label: `Summoned tornado · power ${power} · visual sandbox`,
  }
}

export function pickTornadoGround(scene: Scene, x: number, y: number): GroundPoint | null {
  if (!scene.activeCamera) return null
  const ray = CreatePickingRay(scene, x, y, Matrix.Identity(), scene.activeCamera)
  if (ray.direction.y >= -1e-6) return null
  const distance = (0.7 - ray.origin.y) / ray.direction.y
  if (distance < 0) return null
  const point = ray.origin.add(ray.direction.scale(distance))
  return Number.isFinite(point.x) && Number.isFinite(point.z) ? { x: point.x, z: point.z } : null
}

export function projectTornadoPoint(scene: Scene, x: number, y: number, z: number): { x: number; y: number } {
  const engine = scene.getEngine(), camera = scene.activeCamera!
  const point = Vector3.Project(new Vector3(x, y, z), Matrix.Identity(), scene.getTransformMatrix(), camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight()))
  const scale = engine.getHardwareScalingLevel()
  return { x: point.x * scale, y: point.y * scale }
}
