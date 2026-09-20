/**
 * Which building is under the pointer.  Every drawn building is a stack of vertical prisms (an OSM footprint
 * or its reconciled sections, official massing tiers, a landmark footprint); the pointer's line of sight is
 * tested against those prisms in 2D — through the roof cap, or through a wall where the ray's ground shadow
 * crosses the footprint edge — so a click on a tower's facade picks the tower, not the street behind it.
 */

import { boundaryDistance, bounds, signedArea } from './geometry'
import type { Flat, BuildingCategory, WorldData } from './worldData'

export interface Prism {
  /** id shared by every section of one building (OSM `source_id`, massing id or landmark id) */
  building: string
  ring: Flat
  holes?: Flat[]
  /** roof polygons actually exposed at `y1` (a reconciled section may be partly covered by a taller one) */
  roofs: { ring: Flat; holes?: Flat[] }[]
  /** rendered extent in world metres, i.e. where the drawn walls actually are */
  y0: number
  y1: number
}

/** Buildings are drawn lifted off the ground plate (`Y.building`), with legacy footprints at least 3 m tall. */
const BASE_LIFT = 0.3
const MIN_LEGACY_H = 3

export interface BuildingInfo {
  id: string
  name?: string
  kind: 'building' | 'landmark' | 'massing'
  cat?: BuildingCategory
  /** height of the tallest section as the data states it, metres above ground */
  height: number
  /** ground footprint of the largest section, m² */
  area: number
  sections: number
  /** world x/z of the largest footprint's centre */
  x: number
  z: number
  prisms: Prism[]
}

export interface Ray {
  origin: { x: number; y: number; z: number }
  dir: { x: number; y: number; z: number }
}

const CELL = 100

export class BuildingIndex {
  private readonly prisms: Prism[] = []
  private readonly byBuilding = new Map<string, Prism[]>()
  private readonly cells = new Map<number, number[]>()
  private readonly info = new Map<string, BuildingInfo>()
  private tallest = 0

  constructor(world: Pick<WorldData, 'buildings' | 'landmarks' | 'massing'>) {
    const replaced = new Set(world.massing?.excluded_osm_ids ?? [])
    const landmarkIds = new Set(world.landmarks.map((l) => l.id))
    for (const b of world.buildings) {
      if (replaced.has(b.source_id ?? b.id) || (b.cat === 'landmark' && landmarkIds.has(b.id))) continue
      if (b.ring.length < 6 || Math.abs(signedArea(b.ring)) < (b.source_id ? 0.01 : 4)) continue
      const reconciled = b.roofs !== undefined || Boolean(b.source_id)
      const y0 = BASE_LIFT + Math.max(0, b.base ?? 0)
      const h = reconciled ? b.h : Math.max(MIN_LEGACY_H, b.h)
      this.add({ building: b.source_id ?? b.id, ring: b.ring, holes: b.holes, roofs: b.roofs ?? [{ ring: b.ring, holes: b.holes }], y0, y1: y0 + h }, { kind: 'building', name: b.name, cat: b.cat, height: (b.base ?? 0) + b.h })
    }
    for (const m of world.massing?.buildings ?? []) {
      for (const t of m.tiers) this.add({ building: m.id, ring: t.ring, holes: t.holes, roofs: t.roofs ?? [{ ring: t.ring, holes: t.holes }], y0: t.y0 + BASE_LIFT, y1: t.y1 + BASE_LIFT }, { kind: 'massing', cat: m.cat, height: t.y1 })
    }
    for (const l of world.landmarks) {
      if (l.ring.length >= 6) this.add({ building: l.id, ring: l.ring, holes: l.holes, roofs: [{ ring: l.ring, holes: l.holes }], y0: 0, y1: l.h }, { kind: 'landmark', name: l.name, cat: 'landmark', height: l.h })
    }
  }

  private add(p: Prism, meta: { kind: BuildingInfo['kind']; name?: string; cat?: BuildingCategory; height: number }): void {
    const k = this.prisms.push(p) - 1
    this.tallest = Math.max(this.tallest, p.y1)
    let list = this.byBuilding.get(p.building)
    if (!list) this.byBuilding.set(p.building, (list = []))
    list.push(p)
    const [x0, z0, x1, z1] = bounds(p.ring)
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const key = cellKey(cx, cz)
        let cell = this.cells.get(key)
        if (!cell) this.cells.set(key, (cell = []))
        cell.push(k)
      }
    }
    const area = Math.abs(signedArea(p.ring))
    const prev = this.info.get(p.building)
    if (!prev) {
      const [cx, cz] = centre(p.ring)
      this.info.set(p.building, { id: p.building, name: meta.name, kind: meta.kind, cat: meta.cat, height: meta.height, area, sections: 1, x: cx, z: cz, prisms: list })
    } else {
      prev.height = Math.max(prev.height, meta.height)
      prev.sections++
      prev.name ??= meta.name
      if (area > prev.area) {
        prev.area = area
        ;[prev.x, prev.z] = centre(p.ring)
      }
    }
  }

  get size(): number {
    return this.info.size
  }

  building(id: string): BuildingInfo | undefined {
    return this.info.get(id)
  }

  private *circlePrisms(x: number, z: number, radius: number): Generator<Prism> {
    const seen = new Set<number>()
    for (let cx = Math.floor((x - radius) / CELL); cx <= Math.floor((x + radius) / CELL); cx++) {
      for (let cz = Math.floor((z - radius) / CELL); cz <= Math.floor((z + radius) / CELL); cz++) {
        for (const k of this.cells.get(cellKey(cx, cz)) ?? []) {
          if (seen.has(k)) continue
          seen.add(k)
          const p = this.prisms[k]
          if (inside(x, z, p.ring, p.holes) || boundaryDistance(x, z, p.ring) <= radius || p.holes?.some(h => boundaryDistance(x, z, h) <= radius)) yield p
        }
      }
    }
  }

  inCircle(x: number, z: number, radius: number): string[] {
    return [...new Set([...this.circlePrisms(x, z, radius)].map(p => p.building))]
  }

  overlapsCircle(x: number, z: number, radius: number, y0: number, y1: number): boolean {
    for (const p of this.circlePrisms(x, z, radius)) if (p.y1 > y0 && p.y0 < y1) return true
    return false
  }

  /** The nearest building the ray meets, or null; `maxT` bounds the search along the ray (metres). */
  pick(ray: Ray, maxT = 20000, hidden?: (id: string) => boolean): { info: BuildingInfo; t: number } | null {
    const { origin: o, dir: d } = ray
    // Height band all buildings can occupy: [0, tallest]. The ray's stretch inside it is what can hit anything.
    const band = tRange(o.y, d.y, 0, this.tallest, maxT)
    if (!band) return null
    const [tA, tB] = band
    const ax = o.x + d.x * tA, az = o.z + d.z * tA
    const bx = o.x + d.x * tB, bz = o.z + d.z * tB
    let best: { info: BuildingInfo; t: number } | null = null
    const seen = new Set<number>()
    for (let cx = Math.floor(Math.min(ax, bx) / CELL); cx <= Math.floor(Math.max(ax, bx) / CELL); cx++) {
      for (let cz = Math.floor(Math.min(az, bz) / CELL); cz <= Math.floor(Math.max(az, bz) / CELL); cz++) {
        for (const k of this.cells.get(cellKey(cx, cz)) ?? []) {
          if (seen.has(k)) continue
          seen.add(k)
          if (hidden?.(this.prisms[k].building)) continue
          const t = hitPrism(this.prisms[k], o, d, maxT)
          if (t !== null && (!best || t < best.t)) best = { info: this.info.get(this.prisms[k].building)!, t }
        }
      }
    }
    return best
  }
}

/** Ray parameters where the ray is between heights y0 and y1 (both inclusive), clipped to [0, maxT]; null if never. */
function tRange(oy: number, dy: number, y0: number, y1: number, maxT: number): [number, number] | null {
  let a: number, b: number
  if (Math.abs(dy) < 1e-9) {
    if (oy < y0 || oy > y1) return null
    a = 0
    b = maxT
  } else {
    const t0 = (y0 - oy) / dy
    const t1 = (y1 - oy) / dy
    a = Math.max(0, Math.min(t0, t1))
    b = Math.min(maxT, Math.max(t0, t1))
  }
  return b < a ? null : [a, b]
}

/** Smallest t at which the ray enters the prism: through the roof, or through a wall; null when it misses. */
export function hitPrism(p: Prism, o: Ray['origin'], d: Ray['dir'], maxT: number): number | null {
  const band = tRange(o.y, d.y, p.y0, p.y1, maxT)
  if (!band) return null
  const [tA, tB] = band
  const ax = o.x + d.x * tA, az = o.z + d.z * tA
  if (inside(ax, az, p.ring, p.holes)) return tA
  const bx = o.x + d.x * tB, bz = o.z + d.z * tB
  let best = Infinity
  const cross = (ring: Flat) => {
    const n = ring.length / 2
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const u = segmentParam(ax, az, bx, bz, ring[2 * i], ring[2 * i + 1], ring[2 * j], ring[2 * j + 1])
      if (u !== null && u < best) best = u
    }
  }
  cross(p.ring)
  for (const h of p.holes ?? []) cross(h)
  return best === Infinity ? null : tA + (tB - tA) * best
}

/** Parameter u in [0,1] along a→b where it crosses segment c→d, or null. */
function segmentParam(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): number | null {
  const rx = bx - ax, rz = bz - az
  const sx = dx - cx, sz = dz - cz
  const den = rx * sz - rz * sx
  if (Math.abs(den) < 1e-12) return null
  const u = ((cx - ax) * sz - (cz - az) * sx) / den
  const v = ((cx - ax) * rz - (cz - az) * rx) / den
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? u : null
}

export function inside(x: number, z: number, ring: Flat, holes?: Flat[]): boolean {
  if (!pointInRing(x, z, ring)) return false
  for (const h of holes ?? []) if (pointInRing(x, z, h)) return false
  return true
}

function pointInRing(x: number, z: number, ring: Flat): boolean {
  let hit = false
  const n = ring.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i], zi = ring[2 * i + 1]
    const xj = ring[2 * j], zj = ring[2 * j + 1]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit
  }
  return hit
}

function centre(ring: Flat): [number, number] {
  const [x0, z0, x1, z1] = bounds(ring)
  return [(x0 + x1) / 2, (z0 + z1) / 2]
}

function cellKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768)
}
