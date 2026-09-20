/**
 * Regions the District and Corridor pickers can point at, plus a scenario's closures.  Districts are the
 * Voronoi cells of the pack's destination zones and the venue, clipped to the world bounds, so every ground
 * point belongs to exactly one; corridors and closures are named runs of SUMO edges.  Pure geometry in world
 * metres — no scene involved.
 */

import type { Corridor } from '../types'
import type { Flat, WorldData, WorldRoad } from './worldData'

export interface Site {
  id: string
  name: string
  x: number
  z: number
}

export interface DistrictCell extends Site {
  /** Convex cell boundary, flat [x0, z0, x1, z1, ...], not closed. */
  ring: Flat
}

/** Landmarks this close to the venue point name the venue's district. */
const VENUE_NAME_M = 300

/** Destination zones plus the venue, named by the landmark standing on it when there is one. */
export function districtSites(world: Pick<WorldData, 'zones' | 'venue' | 'landmarks'>): Site[] {
  const sites: Site[] = world.zones.map((z) => ({ id: z.id, name: z.name, x: z.x, z: z.z }))
  const v = world.venue
  if (!sites.some((s) => Math.hypot(s.x - v.x, s.z - v.z) < 1)) {
    let name = 'Venue'
    let best = VENUE_NAME_M
    for (const l of world.landmarks) {
      const d = Math.hypot(l.x - v.x, l.z - v.z)
      if (d < best) {
        best = d
        name = l.name
      }
    }
    sites.push({ id: 'venue', name, x: v.x, z: v.z })
  }
  return sites
}

/** Voronoi cell of every site inside `bounds`: the rectangle clipped by each bisector half-plane. */
export function voronoiCells(sites: Site[], bounds: readonly [number, number, number, number]): DistrictCell[] {
  const [x0, z0, x1, z1] = bounds
  return sites.map((site) => {
    let ring: Flat = [x0, z0, x1, z0, x1, z1, x0, z1]
    for (const other of sites) {
      if (other === site || ring.length < 6) continue
      ring = clipHalfPlane(ring, site, other)
    }
    return { ...site, ring }
  })
}

/** Keep the part of `ring` closer to `a` than to `b` (Sutherland–Hodgman against the perpendicular bisector). */
function clipHalfPlane(ring: Flat, a: Site, b: Site): Flat {
  const nx = b.x - a.x
  const nz = b.z - a.z
  const c = (b.x * b.x + b.z * b.z - a.x * a.x - a.z * a.z) / 2
  const side = (x: number, z: number): number => nx * x + nz * z - c // <= 0: closer to a
  const out: Flat = []
  const n = ring.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const sx = ring[2 * i], sz = ring[2 * i + 1]
    const ex = ring[2 * j], ez = ring[2 * j + 1]
    const fs = side(sx, sz), fe = side(ex, ez)
    if (fe <= 0) {
      if (fs > 0) pushCrossing(out, sx, sz, ex, ez, fs, fe)
      out.push(ex, ez)
    } else if (fs <= 0) pushCrossing(out, sx, sz, ex, ez, fs, fe)
  }
  return out
}

function pushCrossing(out: Flat, sx: number, sz: number, ex: number, ez: number, fs: number, fe: number): void {
  const t = fs / (fs - fe)
  out.push(sx + (ex - sx) * t, sz + (ez - sz) * t)
}

/** The site whose Voronoi cell contains (x, z) — by definition, the nearest one. */
export function nearestSite<T extends Site>(sites: readonly T[], x: number, z: number): T | null {
  let best: T | null = null
  let bestD = Infinity
  for (const s of sites) {
    const d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z)
    if (d < bestD) {
      bestD = d
      best = s
    }
  }
  return best
}

export function pointInRing(x: number, z: number, ring: Flat): boolean {
  let inside = false
  const n = ring.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i], zi = ring[2 * i + 1]
    const xj = ring[2 * j], zj = ring[2 * j + 1]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

export interface CorridorShape {
  id: string
  name: string
  roads: WorldRoad[]
  /** The two farthest-apart edge endpoints: where the corridor starts and ends on the ground. */
  axis: [[number, number], [number, number]]
}

/** Named corridors resolved against the compiled roads; corridors with no drawable edge are dropped. */
export function corridorShapes(corridors: Record<string, Corridor>, byId: Pick<Map<string, WorldRoad>, 'get'>): CorridorShape[] {
  const out: CorridorShape[] = []
  for (const [id, c] of Object.entries(corridors)) {
    const roads: WorldRoad[] = []
    for (const e of c.edge_ids) {
      const r = byId.get(e)
      if (r && r.shape.length >= 4) roads.push(r)
    }
    const ends: [number, number][] = []
    for (const r of roads) ends.push([r.shape[0], r.shape[1]], [r.shape[r.shape.length - 2], r.shape[r.shape.length - 1]])
    const axis = farthestPair(ends)
    if (axis) out.push({ id, name: c.label, roads, axis })
  }
  return out
}

/** The two points farthest apart, west-most first; null with fewer than two distinct points. */
export function farthestPair(points: readonly [number, number][]): [[number, number], [number, number]] | null {
  let best: [[number, number], [number, number]] | null = null
  let bestD = 0
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i], b = points[j]
      const d = (a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1])
      if (d > bestD) {
        bestD = d
        best = a[0] <= b[0] ? [a, b] : [b, a]
      }
    }
  }
  return best
}

/** Distance from (x, z) to the segment (x0, z0)–(x1, z1). */
export function segmentDistance(x: number, z: number, x0: number, z0: number, x1: number, z1: number): number {
  const vx = x1 - x0, vz = z1 - z0
  const len2 = vx * vx + vz * vz
  const u = len2 > 0 ? Math.max(0, Math.min(1, ((x - x0) * vx + (z - z0) * vz) / len2)) : 0
  return Math.hypot(x - (x0 + vx * u), z - (z0 + vz * u))
}

/** Distance from (x, z) to the nearest centre-line of the corridor's edges. */
export function corridorDistance(shape: CorridorShape, x: number, z: number): number {
  let best = Infinity
  for (const r of shape.roads) {
    const s = r.shape
    for (let i = 0; i + 3 < s.length; i += 2) best = Math.min(best, segmentDistance(x, z, s[i], s[i + 1], s[i + 2], s[i + 3]))
  }
  return best
}

/** The corridor whose centre-line passes within `tol` metres of (x, z) — half its road width counts as on it. */
export function nearestCorridor(shapes: readonly CorridorShape[], x: number, z: number, tol: number): CorridorShape | null {
  let best: CorridorShape | null = null
  let bestD = Infinity
  for (const shape of shapes) {
    const w = Math.max(0, ...shape.roads.map((r) => r.w)) / 2
    const d = corridorDistance(shape, x, z) - w
    if (d <= tol && d < bestD) {
      bestD = d
      best = shape
    }
  }
  return best
}
