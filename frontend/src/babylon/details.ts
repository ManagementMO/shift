import { bounds, hash01 } from './geometry'
import type { Flat, WorldBuilding, WorldData } from './worldData'

export function pointInRing(x: number, z: number, ring: Flat): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const ax = ring[i], az = ring[i + 1], bx = ring[j], bz = ring[j + 1]
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside
  }
  return inside
}

function distanceToSegment(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)))
  return Math.hypot(x - ax - t * dx, z - az - t * dz)
}

export function boundaryDistance(x: number, z: number, ring: Flat): number {
  let d = Infinity
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    d = Math.min(d, distanceToSegment(x, z, ring[j], ring[j + 1], ring[i], ring[i + 1]))
  }
  return d
}

export function interiorBox(b: Pick<WorldBuilding, 'ring' | 'holes'>, halfSize: number): Flat | null {
  const [x0, z0, x1, z1] = bounds(b.ring)
  for (const [u, v] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
    const x = x0 + (x1 - x0) * u, z = z0 + (z1 - z0) * v
    const clearance = halfSize * Math.SQRT2 + 0.3
    if (!pointInRing(x, z, b.ring) || boundaryDistance(x, z, b.ring) < clearance) continue
    if (b.holes?.some((h) => pointInRing(x, z, h) || boundaryDistance(x, z, h) < clearance)) continue
    return [x - halfSize, z - halfSize, x + halfSize, z - halfSize, x + halfSize, z + halfSize, x - halfSize, z + halfSize]
  }
  return null
}

export function roadDashes(shape: Flat, offset: number): Flat[] {
  const segments: { ax: number; az: number; dx: number; dz: number; len: number; start: number }[] = []
  let length = 0
  for (let i = 0; i + 3 < shape.length; i += 2) {
    const dx = shape[i + 2] - shape[i], dz = shape[i + 3] - shape[i + 1]
    const len = Math.hypot(dx, dz)
    if (len < 0.01) continue
    segments.push({ ax: shape[i], az: shape[i + 1], dx: dx / len, dz: dz / len, len, start: length })
    length += len
  }
  const dashes: Flat[] = []
  for (let s = 5; s + 3 < length - 4; s += 8) {
    const path: Flat = []
    for (const seg of segments) {
      const a = Math.max(s, seg.start), b = Math.min(s + 3, seg.start + seg.len)
      if (a >= b) continue
      for (const t of [a - seg.start, b - seg.start]) path.push(seg.ax + seg.dx * t - seg.dz * offset, seg.az + seg.dz * t + seg.dx * offset)
    }
    if (path.length >= 4) dashes.push(path)
  }
  return dashes
}

export const TREE_CLEARANCE = 6

type TreeWorld = Pick<WorldData, 'green' | 'buildings' | 'roads' | 'water' | 'junctions' | 'surfaces'>
export interface TreePlacement { x: number; z: number; scale: number; shade: number }
type Obstacle = { box: [number, number, number, number]; contains: (x: number, z: number) => boolean }

export function treePlacements(world: TreeWorld, limit = 6000): TreePlacement[] {
  if (limit <= 0 || !world.green.length) return []
  const cells = new Map<string, Obstacle[]>()
  const cell = 64
  const insert = (o: Obstacle) => {
    const [x0, z0, x1, z1] = o.box
    for (let x = Math.floor(x0 / cell); x <= Math.floor(x1 / cell); x++) {
      for (let z = Math.floor(z0 / cell); z <= Math.floor(z1 / cell); z++) {
        const key = `${x}:${z}`
        let list = cells.get(key)
        if (!list) cells.set(key, (list = []))
        list.push(o)
      }
    }
  }
  const polygon = (ring: Flat, margin: number) => {
    const [x0, z0, x1, z1] = bounds(ring)
    insert({ box: [x0 - margin, z0 - margin, x1 + margin, z1 + margin], contains: (x, z) => pointInRing(x, z, ring) || boundaryDistance(x, z, ring) < margin })
  }
  for (const b of world.buildings) polygon(b.ring, TREE_CLEARANCE)
  for (const w of world.water) polygon(w.ring, TREE_CLEARANCE)
  for (const j of world.junctions) polygon(j.ring, TREE_CLEARANCE)
  for (const road of world.roads) {
    for (const lane of road.lanes?.length ? road.lanes : [{ shape: road.shape, w: road.w }]) {
      const margin = lane.w / 2 + TREE_CLEARANCE
      for (let i = 0; i + 3 < lane.shape.length; i += 2) {
        const ax = lane.shape[i], az = lane.shape[i + 1], bx = lane.shape[i + 2], bz = lane.shape[i + 3]
        insert({ box: [Math.min(ax, bx) - margin, Math.min(az, bz) - margin, Math.max(ax, bx) + margin, Math.max(az, bz) + margin], contains: (x, z) => distanceToSegment(x, z, ax, az, bx, bz) < margin })
      }
    }
  }
  const out: (TreePlacement & { priority: number })[] = []
  const used = new Set<string>()
  const spacing = 11
  const parks = world.surfaces?.grass ?? world.green.map((ring) => ({ ring, holes: [] }))
  for (const { ring, holes } of parks) {
    const [x0, z0, x1, z1] = bounds(ring)
    for (let ix = Math.ceil(x0 / spacing); ix * spacing < x1; ix++) {
      for (let iz = Math.ceil(z0 / spacing); iz * spacing < z1; iz++) {
        const key = `${ix}:${iz}`
        if (used.has(key)) continue
        const h = hash01(key)
        const x = (ix + h * 0.45) * spacing, z = (iz + hash01(`${key}:z`) * 0.45) * spacing
        if (!pointInRing(x, z, ring) || boundaryDistance(x, z, ring) < TREE_CLEARANCE) continue
        if (holes?.some((hole) => pointInRing(x, z, hole) || boundaryDistance(x, z, hole) < TREE_CLEARANCE)) continue
        if (cells.get(`${Math.floor(x / cell)}:${Math.floor(z / cell)}`)?.some((o) => x >= o.box[0] && z >= o.box[1] && x <= o.box[2] && z <= o.box[3] && o.contains(x, z))) continue
        used.add(key)
        out.push({ x, z, scale: 0.75 + h * 0.65, shade: hash01(`${key}:shade`), priority: hash01(`${key}:budget`) })
      }
    }
  }
  return out.sort((a, b) => a.priority - b.priority || a.x - b.x || a.z - b.z).slice(0, limit).map(({ x, z, scale, shade }) => ({ x, z, scale, shade }))
}
