// Procedural low-poly travellers.  Every pose is a handful of boxes so thousands of them stay thin instances;
// the figure a person is drawn with follows the speed SUMO measured for them, never a scripted animation.

import { awareLevel, FLAG_IN_ZONE } from '../live/flags'
import type { Batch, RGB } from './geometry'

export type Pose = 'stand' | 'walkA' | 'walkB' | 'runA' | 'runB'
export const FIGURE_POSES: Pose[] = ['stand', 'walkA', 'walkB', 'runA', 'runB']
/** Stride cycles per second while walking and running. */
export const WALK_HZ = 2.0
export const RUN_HZ = 3.0
export const RUN_SPEED = 2.2

export const SWARM_SCALES = [
  { value: 1, label: 'Life-size' },
  { value: 1.6, label: 'Clear' },
  { value: 2.2, label: 'Large' },
  { value: 3, label: 'Giant' },
] as const

/** Alert colours by how the agent learned of an incident: saw it, heard first-hand, second-hand, further. */
export const ALERT_HOPS: RGB[] = [
  [1.0, 0.24, 0.12],
  [1.0, 0.48, 0.1],
  [1.0, 0.7, 0.16],
  [0.98, 0.88, 0.28],
]

const SKIN: RGB = [0.87, 0.72, 0.6]
const HAIR: RGB = [0.22, 0.16, 0.12]

/** Vehicles grow more gently than people so queued cars keep reading as separate vehicles on their measured lane. */
export function vehicleScale(swarmScale: number): number {
  return 1 + (swarmScale - 1) * 0.55
}

/**
 * Extra presentation size from the city camera: far-LOD pins and vehicles are enlarged so a crowd still reads
 * as individuals from 1 km up. Positions are untouched; only the model grows.
 */
export function farBoost(cameraRadius: number, kind: 'marker' | 'vehicle'): number {
  const start = kind === 'marker' ? 420 : 700
  const limit = kind === 'marker' ? 3.4 : 2.0
  return Math.max(1, Math.min(limit, cameraRadius / start))
}

export function poseFor(speed: number, t: number, phase: number, state: number): Pose {
  if (state === 2 || speed < 0.25) return 'stand'
  const running = speed > RUN_SPEED
  const beat = Math.floor((t * (running ? RUN_HZ : WALK_HZ) + phase) * 2) % 2
  if (running) return beat ? 'runB' : 'runA'
  return beat ? 'walkB' : 'walkA'
}

export function alertTint(flags: number, base: RGB): RGB {
  const level = awareLevel(flags)
  if (!level) return base
  const tint = ALERT_HOPS[Math.min(ALERT_HOPS.length - 1, level - 1)]
  return flags & FLAG_IN_ZONE ? [tint[0] * 0.72, tint[1] * 0.45, tint[2] * 0.45] : tint
}

/** Local space: +z forward, +y up, origin on the ground between the feet. */
function block(b: Batch, cx: number, y0: number, cz: number, sx: number, sy: number, sz: number, c: RGB): void {
  const x0 = cx - sx / 2, x1 = cx + sx / 2, z0 = cz - sz / 2, z1 = cz + sz / 2
  const quad = [x0, z0, x1, z0, x1, z1, x0, z1]
  b.polygon(quad, undefined, y0 + sy, c)
  b.walls(quad, undefined, y0, y0 + sy, c, 1)
}

const STRIDE: Record<Pose, { legs: number; arms: number; lift: number; lean: number }> = {
  stand: { legs: 0, arms: 0, lift: 0, lean: 0 },
  walkA: { legs: 0.22, arms: 0.18, lift: 0.05, lean: 0.04 },
  walkB: { legs: -0.22, arms: -0.18, lift: 0.05, lean: 0.04 },
  runA: { legs: 0.4, arms: 0.34, lift: 0.14, lean: 0.14 },
  runB: { legs: -0.4, arms: -0.34, lift: 0.14, lean: 0.14 },
}

/** Body parts take the per-instance colour; the head is drawn by `buildHead` in a fixed skin tone. */
export function buildFigure(b: Batch, pose: Pose, c: RGB = SKIN): void {
  const s = STRIDE[pose]
  const forward = Math.sign(s.legs)
  block(b, -0.12, forward > 0 ? 0 : s.lift, s.legs, 0.17, 0.82, 0.2, c) // left leg
  block(b, 0.12, forward < 0 ? 0 : s.lift, -s.legs, 0.17, 0.82, 0.2, c) // right leg
  block(b, 0, 0.8, s.lean, 0.5, 0.66, 0.3, c) // torso
  block(b, 0, 1.4, s.lean, 0.58, 0.12, 0.32, c) // shoulders
  block(b, -0.36, 0.86 + Math.abs(s.arms) * 0.3, -s.arms + s.lean, 0.14, 0.58, 0.16, c) // left arm swings against the left leg
  block(b, 0.36, 0.86 + Math.abs(s.arms) * 0.3, s.arms + s.lean, 0.14, 0.58, 0.16, c) // right arm
}

export function buildHead(b: Batch, pose: Pose): void {
  const lean = STRIDE[pose].lean
  block(b, 0, 1.5, lean, 0.28, 0.3, 0.28, SKIN)
  block(b, 0, 1.76, lean - 0.02, 0.3, 0.06, 0.3, HAIR)
}

/** Far-away pedestrian: a tall pin with a ground disc, readable from the city camera. */
export function buildMarker(b: Batch): void {
  block(b, 0, 0, 0, 0.9, 3.2, 0.9, SKIN)
  b.disc(0, 0, 1.9, 0.05, SKIN, 10)
}

export function buildCar(b: Batch, c: RGB): void {
  block(b, 0, 0.3, 0, 1.85, 0.68, 4.5, c)
  block(b, 0, 0.98, -0.25, 1.62, 0.56, 2.4, c) // cabin
  block(b, 0, 0.62, 2.24, 1.5, 0.16, 0.08, [0.98, 0.95, 0.7]) // headlights
  block(b, 0, 0.62, -2.26, 1.5, 0.14, 0.08, [0.85, 0.12, 0.1]) // tail lights
}

export function buildCarTrim(b: Batch): void {
  const glass: RGB = [0.16, 0.2, 0.26], tyre: RGB = [0.08, 0.08, 0.09]
  block(b, 0, 1.02, -0.25, 1.66, 0.4, 2.44, glass)
  for (const z of [-1.45, 1.45]) for (const x of [-0.82, 0.82]) block(b, x, 0, z, 0.26, 0.66, 0.66, tyre)
}
