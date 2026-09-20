/**
 * Street-closure furniture: orange-and-white barricades across every entry of a closed corridor and traffic cones
 * along its blocks, so a closed street reads as closed from the city camera without painting the road red.
 */

import { hex, Y } from './city'
import { Batch, type RGB } from './geometry'
import type { RoadIndex } from './roadIndex'

export const CLOSURE_ORANGE: RGB = hex('#f28c28')
const WHITE: RGB = hex('#f4f1ea')
const LEG: RGB = hex('#3a3a3a')

// Built larger than life: the city is read from a few hundred metres up, where true-size street furniture vanishes.
const SCALE = 3.2
const BARRICADE_W = 2.4 * SCALE
const CONE_SPACING_M = 12
const MIN_BLOCK_M = 15

type Vec = [number, number]

/** A box on the ground plane as a ring, centred at (x, z), sized `along` in the direction `d` and `across` perpendicular to it. */
function box(x: number, z: number, d: Vec, along: number, across: number): number[] {
  const px = -d[1], pz = d[0]
  const a = along / 2, c = across / 2
  return [
    x - d[0] * a - px * c, z - d[1] * a - pz * c,
    x + d[0] * a - px * c, z + d[1] * a - pz * c,
    x + d[0] * a + px * c, z + d[1] * a + pz * c,
    x - d[0] * a + px * c, z - d[1] * a + pz * c,
  ]
}

/** A Type III barricade: two legs and two striped rails, `d` is the direction it spans across. */
function barricade(b: Batch, x: number, z: number, d: Vec, y: number): void {
  const k = SCALE
  const half = BARRICADE_W / 2
  for (const s of [-1, 1]) b.extrude(box(x + d[0] * s * (half - 0.1 * k), z + d[1] * s * (half - 0.1 * k), d, 0.14 * k, 0.6 * k), undefined, y, y + 1.2 * k, LEG, LEG)
  const stripes = 6
  const w = BARRICADE_W / stripes
  for (const [y0, y1] of [[0.42, 0.74], [0.86, 1.18]]) {
    for (let i = 0; i < stripes; i++) {
      const t = -half + w * (i + 0.5)
      const c = i % 2 === 0 ? CLOSURE_ORANGE : WHITE
      b.extrude(box(x + d[0] * t, z + d[1] * t, d, w + 0.02, 0.08 * k), undefined, y + y0 * k, y + y1 * k, c, c)
    }
  }
}

/** A traffic cone: orange base, white collar, orange tip. */
function cone(b: Batch, x: number, z: number, y: number): void {
  const k = SCALE
  const ring = (r: number) => {
    const out: number[] = []
    for (let i = 0; i < 6; i++) out.push(x + Math.cos((i / 6) * Math.PI * 2) * r * k, z + Math.sin((i / 6) * Math.PI * 2) * r * k)
    return out
  }
  b.extrude(ring(0.26), undefined, y, y + 0.06 * k, CLOSURE_ORANGE, CLOSURE_ORANGE)
  b.extrude(ring(0.17), undefined, y + 0.06 * k, y + 0.4 * k, CLOSURE_ORANGE, CLOSURE_ORANGE)
  b.extrude(ring(0.13), undefined, y + 0.4 * k, y + 0.55 * k, WHITE, WHITE)
  b.extrude(ring(0.09), undefined, y + 0.55 * k, y + 0.82 * k, CLOSURE_ORANGE, CLOSURE_ORANGE)
}

/** Point `m` metres along a polyline (clamped) and the unit direction there. */
function along(shape: number[], m: number): { p: Vec; d: Vec } | null {
  let left = m
  for (let i = 0; i + 3 < shape.length; i += 2) {
    const ax = shape[i], az = shape[i + 1], bx = shape[i + 2], bz = shape[i + 3]
    const len = Math.hypot(bx - ax, bz - az)
    if (len < 1e-6) continue
    if (left <= len) {
      const t = left / len
      return { p: [ax + (bx - ax) * t, az + (bz - az) * t], d: [(bx - ax) / len, (bz - az) / len] }
    }
    left -= len
  }
  return null
}

function length(shape: number[]): number {
  let total = 0
  for (let i = 0; i + 3 < shape.length; i += 2) total += Math.hypot(shape[i + 2] - shape[i], shape[i + 3] - shape[i + 1])
  return total
}

const key = (x: number, z: number) => `${Math.round(x)},${Math.round(z)}`

/**
 * Furnish the closed edges: a barricade row across the start of every block (each closed edge long enough to be a
 * block, plus every corridor entry), and a line of cones down each closed edge.
 */
export function closureProps(b: Batch, roads: RoadIndex, closed: Iterable<string>, y = Y.junction + 0.02): void {
  const shapes = [...closed].map((id) => roads.byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r && r.shape.length >= 4)
  const exits = new Set(shapes.map((r) => key(r.shape[r.shape.length - 2], r.shape[r.shape.length - 1])))
  for (const r of shapes) {
    const total = length(r.shape)
    const entry = !exits.has(key(r.shape[0], r.shape[1]))
    if (entry || total >= MIN_BLOCK_M) {
      const at = along(r.shape, Math.min(4, total / 2))
      if (at) {
        const across: Vec = [-at.d[1], at.d[0]]
        const n = Math.max(1, Math.floor(r.w / (BARRICADE_W + 0.3)))
        for (let i = 0; i < n; i++) {
          const t = (i - (n - 1) / 2) * (BARRICADE_W + 0.3)
          barricade(b, at.p[0] + across[0] * t, at.p[1] + across[1] * t, across, y)
        }
      }
    }
    // cones down the centre line, alternating sides so the row reads from any angle
    for (let m = CONE_SPACING_M, i = 0; m < total - 6; m += CONE_SPACING_M, i++) {
      const at = along(r.shape, m)
      if (!at) break
      const side = (i % 2 === 0 ? 1 : -1) * Math.min(1.6, r.w * 0.22)
      cone(b, at.p[0] - at.d[1] * side, at.p[1] + at.d[0] * side, y)
    }
  }
}
