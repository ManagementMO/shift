import { boundaryDistance, bounds, distanceToSegment, hash01, pointInRing } from './geometry'
import { BuildingIndex } from './buildingIndex'
import type { Flat, WorldBuilding, WorldData } from './worldData'

export { boundaryDistance, pointInRing } from './geometry'

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
export const TREE_RADIUS = 4.1
export const TREE_HEIGHT = 9.1

type TreeWorld = Pick<WorldData, 'green' | 'buildings' | 'roads' | 'water' | 'junctions' | 'surfaces'> & Partial<Pick<WorldData, 'massing' | 'landmarks'>>
export interface TreePlacement { x: number; z: number; scale: number; shade: number; y?: number }
type Obstacle = { box: [number, number, number, number]; contains: (x: number, z: number) => boolean }
type CirclePlacement = { x: number; z: number; radius: number; y0: number; y1: number }

export class PlacementGrid {
  private readonly cells = new Map<string, CirclePlacement[]>()
  private maxRadius = 0

  free(x: number, z: number, radius: number, y0 = -Infinity, y1 = Infinity): boolean {
    const reach = radius + this.maxRadius
    for (let i = Math.floor((x - reach) / 64); i <= Math.floor((x + reach) / 64); i++) {
      for (let j = Math.floor((z - reach) / 64); j <= Math.floor((z + reach) / 64); j++) {
        if (this.cells.get(`${i}:${j}`)?.some(p => y1 > p.y0 && y0 < p.y1 && Math.hypot(x - p.x, z - p.z) < radius + p.radius)) return false
      }
    }
    return true
  }

  reserve(x: number, z: number, radius: number, y0 = -Infinity, y1 = Infinity): boolean {
    if (!this.free(x, z, radius, y0, y1)) return false
    const key = `${Math.floor(x / 64)}:${Math.floor(z / 64)}`
    if (!this.cells.has(key)) this.cells.set(key, [])
    this.cells.get(key)!.push({ x, z, radius, y0, y1 })
    this.maxRadius = Math.max(this.maxRadius, radius)
    return true
  }
}

export function treePlacements(world: TreeWorld, limit = 6000): TreePlacement[] {
  if (limit <= 0 || !(world.surfaces?.grass.length ?? world.green.length)) return []
  const buildings = new BuildingIndex({ buildings: world.buildings, landmarks: world.landmarks ?? [], massing: world.massing })
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
        const scale = 0.75 + h * 0.65
        if (buildings.overlapsCircle(x, z, TREE_RADIUS * scale + 0.3, 0.25, 0.5 + TREE_HEIGHT * scale)) continue
        used.add(key)
        out.push({ x, z, scale, shade: hash01(`${key}:shade`), priority: hash01(`${key}:budget`) })
      }
    }
  }
  const occupied = new PlacementGrid()
  const placed: TreePlacement[] = []
  for (const { x, z, scale, shade } of out.sort((a, b) => a.priority - b.priority || a.x - b.x || a.z - b.z)) {
    if (!occupied.reserve(x, z, TREE_RADIUS * scale + 0.1)) continue
    placed.push({ x, z, scale, shade })
    if (placed.length >= limit) break
  }
  return placed
}
