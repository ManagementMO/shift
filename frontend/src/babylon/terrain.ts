/**
 * Placeholder countryside beyond the compiled pack: a rolling grassland heightfield, the lake carried on from
 * the pack's shoreline (`far_water`, compiled from the full Lake Ontario linework), the main roads leaving the
 * pack extended to the horizon, filler suburb blocks where the mapped city thins out, farmland and sparse trees.
 * Purely presentational and deterministic: nothing here is surveyed terrain, and nothing here feeds the simulation.
 */

import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import type { Material } from '@babylonjs/core/Materials/material'
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import type { Scene } from '@babylonjs/core/scene'

import { facadeFor, TEXTURE_RECIPES, type TextureKind } from './appearance'
import { addArchitecture } from './architecture'
import { BuildingIndex } from './buildingIndex'
import { buildingColor, hex, meshFromBatch, PALETTE, vertexColorMaterial, Y } from './city'
import { boundaryDistance, pointInRing, PlacementGrid, TREE_HEIGHT, TREE_RADIUS, type TreePlacement } from './details'
import { Batch, bounds, centroid, distanceToSegment, mix, signedArea, type RGB } from './geometry'
import type { CityMaterials } from './materials'
import { buildVegetation } from './vegetation'
import type { BuildingCategory, Flat, WorldBuilding, WorldData, WorldRoad } from './worldData'

export interface TerrainOptions {
  /** grid cells across the far box (per axis) */
  cells: number
  /** metres the pack bounds are padded by the compiled ground plate */
  platePad: number
  /** peak hill height, metres */
  hillAmplitude: number
  /** dominant hill wavelength, metres */
  hillWavelength: number
  /** distance from the plate edge over which hills grow to full height */
  hillRise: number
  /** land rises gently away from the plate (metres per metre) */
  slope: number
  roadLimit: number
  treeLimit: number
  reservedTrees?: readonly TreePlacement[]
  /** filler blocks carrying the street grid on past the mapped city (see `fringeBlocks`) */
  fringe: boolean
}

export const TERRAIN_DEFAULTS: TerrainOptions = {
  cells: 176, platePad: 0.3, hillAmplitude: 85, hillWavelength: 2000, hillRise: 1400, slope: 0.005, roadLimit: 8, treeLimit: 1500, fringe: true,
}

const GRASS_DRY = hex('#a3a86b')
const GRASS_DEEP = hex('#5f7d47')
const SHORE = hex('#cfc39d')
const HORIZON_ROAD_TYPES = /motorway|trunk|primary|secondary/

function hash2(ix: number, iz: number): number {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

const smooth = (t: number): number => {
  const k = Math.max(0, Math.min(1, t))
  return k * k * (3 - 2 * k)
}

/** Value noise in [-1, 1] with three octaves; `wavelength` is the largest feature size in metres. */
export function rollingNoise(x: number, z: number, wavelength: number): number {
  let value = 0
  let weight = 0.62
  let f = 1 / wavelength
  let sum = 0
  for (let octave = 0; octave < 3; octave++) {
    const gx = x * f + 31.7 * octave
    const gz = z * f - 17.3 * octave
    const ix = Math.floor(gx), iz = Math.floor(gz)
    const u = smooth(gx - ix), v = smooth(gz - iz)
    const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1)
    value += ((a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v) * 2 * weight - weight
    sum += weight
    weight *= 0.45
    f *= 2.1
  }
  return value / sum
}

/** Signed distance to an axis-aligned box: negative inside, metres outside. */
export function boxDistance(box: readonly number[], x: number, z: number): number {
  const dx = Math.max(box[0] - x, x - box[2])
  const dz = Math.max(box[1] - z, z - box[3])
  if (dx <= 0 && dz <= 0) return Math.max(dx, dz)
  return Math.hypot(Math.max(dx, 0), Math.max(dz, 0))
}

interface TerrainGrid {
  xs: number[]
  zs: number[]
  heights: Float32Array
}

function gridInterval(values: number[], value: number): number {
  let lo = 0, hi = values.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1
    if (values[mid] <= value) lo = mid
    else hi = mid
  }
  return lo
}

function heightGrid(far: readonly number[], plate: readonly number[], cells: number, height: (x: number, z: number) => number): TerrainGrid {
  const axis = (a: number, b: number, edges: number[]): number[] => {
    const values = new Set<number>()
    for (let i = 0; i <= cells; i++) values.add(Math.fround(a + ((b - a) * i) / cells))
    for (const edge of edges) if (edge > a && edge < b) values.add(Math.fround(edge))
    return [...values].sort((p, q) => p - q)
  }
  const xs = axis(far[0], far[2], [plate[0], plate[2]])
  const zs = axis(far[1], far[3], [plate[1], plate[3]])
  const heights = new Float32Array(xs.length * zs.length)
  for (let j = 0; j < zs.length; j++) for (let i = 0; i < xs.length; i++) heights[j * xs.length + i] = height(xs[i], zs[j])
  return { xs, zs, heights }
}

function gridHeight({ xs, zs, heights }: TerrainGrid, x: number, z: number): number {
  const i = gridInterval(xs, x), j = gridInterval(zs, z)
  const u = Math.max(0, Math.min(1, (x - xs[i]) / (xs[i + 1] - xs[i])))
  const v = Math.max(0, Math.min(1, (z - zs[j]) / (zs[j + 1] - zs[j])))
  const a = j * xs.length + i, b = a + 1, c = a + xs.length, d = c + 1
  return u + v <= 1
    ? heights[a] * (1 - u - v) + heights[b] * u + heights[c] * v
    : heights[b] * (1 - v) + heights[d] * (u + v - 1) + heights[c] * (1 - u)
}

export interface TerrainShape {
  grid: TerrainGrid
  farBounds: [number, number, number, number]
  /** the compiled pack */
  pack: [number, number, number, number]
  /** the compiled ground plate: pack plus padding */
  plate: [number, number, number, number]
  plateY: number
  water: { ring: Flat; holes: Flat[]; box: [number, number, number, number] }[]
  inWater(x: number, z: number): boolean
  /** Distance to the nearest shoreline; with `within`, polygons farther than that are skipped and `within` is returned. */
  shoreDistance(x: number, z: number, within?: number): number
  /** placeholder ground height; hidden below the plate and the lake bed where the compiled world takes over */
  height(x: number, z: number): number
  /** height a road or tree should sit on: the plate inside the padded pack, the terrain beyond */
  surface(x: number, z: number): number
}

const SHORE_CELL_M = 250

/** Shoreline segments bucketed by `SHORE_CELL_M` cells; `distance` only visits cells within the asked radius. */
export class ShoreIndex {
  private readonly cells = new Map<string, number[]>()
  private readonly segments: number[] = []

  constructor(rings: Flat[]) {
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 2; i + 1 < ring.length; j = i, i += 2) {
        const k = this.segments.length
        this.segments.push(ring[j], ring[j + 1], ring[i], ring[i + 1])
        const x0 = Math.min(ring[j], ring[i]), x1 = Math.max(ring[j], ring[i]), z0 = Math.min(ring[j + 1], ring[i + 1]), z1 = Math.max(ring[j + 1], ring[i + 1])
        for (let cx = Math.floor(x0 / SHORE_CELL_M); cx <= Math.floor(x1 / SHORE_CELL_M); cx++) {
          for (let cz = Math.floor(z0 / SHORE_CELL_M); cz <= Math.floor(z1 / SHORE_CELL_M); cz++) {
            const key = `${cx}:${cz}`
            const bucket = this.cells.get(key)
            if (bucket) bucket.push(k)
            else this.cells.set(key, [k])
          }
        }
      }
    }
  }

  /** Distance to the nearest shoreline segment, or `within` when none lies within that radius. */
  distance(x: number, z: number, within: number): number {
    let d = within
    const reach = Math.ceil(within / SHORE_CELL_M)
    const cx = Math.floor(x / SHORE_CELL_M), cz = Math.floor(z / SHORE_CELL_M)
    const seen = new Set<number>()
    for (let i = cx - reach; i <= cx + reach; i++) {
      for (let j = cz - reach; j <= cz + reach; j++) {
        const bucket = this.cells.get(`${i}:${j}`)
        if (!bucket) continue
        for (const k of bucket) {
          if (seen.has(k)) continue
          seen.add(k)
          d = Math.min(d, distanceToSegment(x, z, this.segments[k], this.segments[k + 1], this.segments[k + 2], this.segments[k + 3]))
        }
      }
    }
    return d
  }
}

export function terrainShape(world: Pick<WorldData, 'crs' | 'surfaces' | 'far_water' | 'far_bounds'>, opts: Partial<TerrainOptions> = {}): TerrainShape {
  const o = { ...TERRAIN_DEFAULTS, ...opts }
  const [bx0, bz0, bx1, bz1] = world.crs.bounds_world
  const padX = (bx1 - bx0) * o.platePad, padZ = (bz1 - bz0) * o.platePad
  const plate: [number, number, number, number] = [bx0 - padX, bz0 - padZ, bx1 + padX, bz1 + padZ]
  const reach = Math.max(bx1 - bx0, bz1 - bz0) * 2
  const farBounds: [number, number, number, number] = world.far_bounds ?? [bx0 - reach, bz0 - reach, bx1 + reach, bz1 + reach]
  const plateY = world.surfaces ? Y.road : Y.ground
  const water = (world.far_water ?? []).filter((w) => w.ring.length >= 6).map((w) => ({ ring: w.ring, holes: w.holes ?? [], box: bounds(w.ring) }))
  const inWater = (x: number, z: number): boolean =>
    water.some((w) => x >= w.box[0] && x <= w.box[2] && z >= w.box[1] && z <= w.box[3] && pointInRing(x, z, w.ring) && !w.holes.some((h) => pointInRing(x, z, h)))
  // Shoreline segments in a coarse spatial hash: a bounded query touches a few cells instead of walking every
  // segment of the lake shore (hundreds) for each of the ~100k terrain vertices.
  const shore = new ShoreIndex(water.flatMap((w) => [w.ring, ...w.holes]))
  const shoreDistance = (x: number, z: number, within = Infinity): number => {
    if (Number.isFinite(within)) return shore.distance(x, z, within)
    let d = Infinity
    for (const w of water) {
      if (x < w.box[0] - d || x > w.box[2] + d || z < w.box[1] - d || z > w.box[3] + d) continue
      d = Math.min(d, boundaryDistance(x, z, w.ring))
      for (const h of w.holes) d = Math.min(d, boundaryDistance(x, z, h))
    }
    return d
  }
  const base = plateY
  const height = (x: number, z: number): number => {
    if (inWater(x, z)) return Y.water - 5
    const d = boxDistance(plate, x, z)
    if (d <= 0) return d < -60 ? Y.water - 3 : Y.water - 3 + (base - (Y.water - 3)) * (1 + d / 60)
    const relief = o.hillAmplitude * (0.5 + 0.5 * rollingNoise(x, z, o.hillWavelength)) + d * o.slope
    // land grows from the plate edge and flattens again into a beach at the shore
    const shore = smooth(shoreDistance(x, z, 500) / 500)
    return base + relief * smooth(d / o.hillRise) * shore
  }
  const grid = heightGrid(farBounds, plate, o.cells, (x, z) => boxDistance(plate, x, z) >= -0.001 && inWater(x, z) ? plateY : height(x, z))
  const surface = (x: number, z: number): number => inWater(x, z) ? Y.water - 5 : boxDistance(plate, x, z) <= 0 ? plateY : Math.max(plateY, gridHeight(grid, x, z))
  return { grid, farBounds, pack: [bx0, bz0, bx1, bz1], plate, plateY, water, inWater, shoreDistance, height, surface }
}

/** Roads of the pack's highest classes that end at the pack edge, continued straight to the far edge. */
export function horizonRoads(roads: (Pick<WorldRoad, 'shape' | 'w' | 'type' | 'kind'> & Partial<Pick<WorldRoad, 'from' | 'to'>>)[], packBounds: readonly number[], farBounds: readonly number[], limit = 8): { shape: Flat; width: number }[] {
  const [x0, z0, x1, z1] = packBounds
  const near = Math.max(x1 - x0, z1 - z0) * 0.25
  const neighbors = new Map<string, Set<string>>()
  for (const road of roads) {
    if (road.kind !== 'road' || !road.from || !road.to) continue
    for (const [from, to] of [[road.from, road.to], [road.to, road.from]]) {
      if (!neighbors.has(from)) neighbors.set(from, new Set())
      neighbors.get(from)!.add(to)
    }
  }
  const out: { shape: Flat; width: number; side: number; priority: number; dx: number; dz: number }[] = []
  for (const r of roads) {
    if (r.kind !== 'road' || !HORIZON_ROAD_TYPES.test(r.type) || r.shape.length < 4) continue
    for (const end of [false, true]) {
      const n = r.shape.length
      const px = end ? r.shape[n - 2] : r.shape[0], pz = end ? r.shape[n - 1] : r.shape[1]
      const qx = end ? r.shape[n - 4] : r.shape[2], qz = end ? r.shape[n - 3] : r.shape[3]
      const distances = [px - x0, x1 - px, pz - z0, z1 - pz]
      const edge = Math.min(...distances), side = distances.indexOf(edge)
      const node = end ? r.to : r.from
      if (edge >= near || (node ? neighbors.get(node)?.size !== 1 : edge > 80)) continue
      let dx = px - qx, dz = pz - qz
      const len = Math.hypot(dx, dz)
      if (len < 1) continue
      dx /= len
      dz /= len
      // the road must actually be heading out of the pack, not grazing its edge
      const outward = [-dx, dx, -dz, dz][side]
      if (outward < 0.35) continue
      const tx = dx > 0 ? (farBounds[2] - px) / dx : dx < 0 ? (farBounds[0] - px) / dx : Infinity
      const tz = dz > 0 ? (farBounds[3] - pz) / dz : dz < 0 ? (farBounds[1] - pz) / dz : Infinity
      const t = Math.min(tx, tz)
      if (!Number.isFinite(t) || t < 200) continue
      if (out.some((o) => Math.hypot(px - o.shape[0], pz - o.shape[1]) < 160 && dx * o.dx + dz * o.dz > 0.9)) continue
      const roadClass = r.type.includes('motorway') ? 4 : r.type.includes('trunk') ? 3 : r.type.includes('primary') ? 2 : 1
      out.push({ shape: [px, pz, px + dx * t, pz + dz * t], width: Math.max(r.w, 9), side, priority: roadClass * 100 + r.w - edge / 100, dx, dz })
    }
  }
  const groups = [0, 1, 2, 3].map((side) => out.filter((r) => r.side === side).sort((a, b) => b.priority - a.priority))
  const selected: typeof out = []
  for (let i = 0; i < out.length && selected.length < limit; i++) {
    for (const group of groups) if (group[i] && selected.length < limit) selected.push(group[i])
  }
  return selected.map(({ shape, width }) => ({ shape, width }))
}

/** Deterministic tree positions on the countryside: clumps by noise, kept off the pack, water, beaches, horizon roads and `avoid`. */
export function countryTrees(shape: TerrainShape, roads: { shape: Flat; width: number }[], limit: number, avoid?: (x: number, z: number, radius: number) => boolean, occupied = new PlacementGrid()): TreePlacement[] {
  const [fx0, fz0, fx1, fz1] = shape.farBounds
  const spacing = 100
  const out: (TreePlacement & { priority: number })[] = []
  for (let ix = Math.ceil(fx0 / spacing); ix * spacing < fx1; ix++) {
    for (let iz = Math.ceil(fz0 / spacing); iz * spacing < fz1; iz++) {
      const j1 = hash2(ix, iz), j2 = hash2(ix + 977, iz - 331), j3 = hash2(ix - 541, iz + 223)
      const x = (ix + j1 * 0.9) * spacing, z = (iz + j2 * 0.9) * spacing
      if (boxDistance(shape.pack, x, z) < 150 || shape.inWater(x, z) || shape.shoreDistance(x, z, 90) < 90) continue
      if (rollingNoise(x + 5000, z - 5000, 900) < 0.12 || avoid?.(x, z, TREE_RADIUS * (1.5 + j3 * 1.1) + 0.2)) continue
      if (roads.some((r) => segmentDistance(x, z, r.shape) < r.width + 30)) continue
      out.push({ x, z, y: shape.surface(x, z), scale: 1.5 + j3 * 1.1, shade: j2, priority: Math.max(0, boxDistance(shape.pack, x, z)) + j3 * 600 })
    }
  }
  const placed: TreePlacement[] = []
  for (const { x, y = 0, z, scale, shade } of out.sort((a, b) => a.priority - b.priority || a.x - b.x || a.z - b.z)) {
    if (placed.length >= limit) break
    if (occupied.reserve(x, z, TREE_RADIUS * scale + 0.2, y, y + TREE_HEIGHT * scale)) placed.push({ x, y, z, scale, shade })
  }
  return placed
}

function segmentDistance(x: number, z: number, shape: Flat): number {
  const [ax, az, bx, bz] = shape
  const dx = bx - ax, dz = bz - az
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)))
  return Math.hypot(x - ax - t * dx, z - az - t * dz)
}

// ---------------------------------------------------------------------------------------------- farmland

/** Ontario's concession survey runs about 17° west of north; the placeholder fields follow the same tilt. */
const LATTICE_ANGLE = 0.3
const LOT_U = 260
const LOT_V = 420
const LOTS_PER_BLOCK_U = 5
const LOTS_PER_BLOCK_V = 4
const LANE_WIDTH = 7
const FIELD_TINTS: RGB[] = [hex('#c9b978'), hex('#9a7f5e'), hex('#98b06a'), hex('#b9b26b'), hex('#6f8c4d'), hex('#d1c08a'), hex('#8f9d5c')]
const LANE = hex('#9c9483')
const HOUSE = { wall: hex('#d8cfc0'), roof: hex('#7a5a4a') }
const BARN = { wall: hex('#8a4b3f'), roof: hex('#5a5a5a') }

const toLattice = (x: number, z: number): [number, number] => [x * Math.cos(LATTICE_ANGLE) + z * Math.sin(LATTICE_ANGLE), -x * Math.sin(LATTICE_ANGLE) + z * Math.cos(LATTICE_ANGLE)]
const fromLattice = (u: number, v: number): [number, number] => [u * Math.cos(LATTICE_ANGLE) - v * Math.sin(LATTICE_ANGLE), u * Math.sin(LATTICE_ANGLE) + v * Math.cos(LATTICE_ANGLE)]

export interface Parcel {
  /** lattice indices */
  i: number
  j: number
  /** world corners, positive shoelace */
  corners: [number, number][]
  centre: [number, number]
  tint: RGB | null
  hedgerow: boolean
  farmstead: boolean
}

/** Is this spot open farmland: away from the pack, the lake and the beach, and inside the farmland noise mask. */
export function isFarmland(shape: TerrainShape, x: number, z: number): boolean {
  return boxDistance(shape.plate, x, z) > 250 && !shape.inWater(x, z) && shape.shoreDistance(x, z, 250) >= 250 && rollingNoise(x + 2222, z - 777, 3200) > -0.05
}

/** Deterministic parcels on the concession lattice, skipping horizon roads and anything `avoid` claims (the suburb). */
export function farmParcels(shape: TerrainShape, roads: { shape: Flat; width: number }[], avoid?: (x: number, z: number) => boolean): Parcel[] {
  const [fx0, fz0, fx1, fz1] = shape.farBounds
  const corners = [[fx0, fz0], [fx1, fz0], [fx1, fz1], [fx0, fz1]].map(([x, z]) => toLattice(x, z))
  const u0 = Math.min(...corners.map((c) => c[0])), u1 = Math.max(...corners.map((c) => c[0]))
  const v0 = Math.min(...corners.map((c) => c[1])), v1 = Math.max(...corners.map((c) => c[1]))
  const out: Parcel[] = []
  for (let i = Math.floor(u0 / LOT_U); i * LOT_U < u1; i++) {
    for (let j = Math.floor(v0 / LOT_V); j * LOT_V < v1; j++) {
      const gap = LANE_WIDTH / 2 + 6
      const ua = i * LOT_U + gap, ub = (i + 1) * LOT_U - gap, va = j * LOT_V + gap, vb = (j + 1) * LOT_V - gap
      const centre = fromLattice((ua + ub) / 2, (va + vb) / 2)
      if (centre[0] < fx0 + 300 || centre[0] > fx1 - 300 || centre[1] < fz0 + 300 || centre[1] > fz1 - 300) continue
      if (!isFarmland(shape, centre[0], centre[1])) continue
      if (roads.some((r) => segmentDistance(centre[0], centre[1], r.shape) < r.width / 2 + Math.hypot(LOT_U, LOT_V) / 2)) continue
      if (avoid?.(centre[0], centre[1])) continue
      const h = hash2(i * 7 + 3, j * 11 - 5), h2 = hash2(i - 991, j + 577), h3 = hash2(i + 313, j - 131)
      const cornersWorld = ([[ua, va], [ub, va], [ub, vb], [ua, vb]] as [number, number][]).map(([u, v]) => fromLattice(u, v))
      const onLaneCorner = i % LOTS_PER_BLOCK_U === 0 && j % LOTS_PER_BLOCK_V === 0
      out.push({
        i, j, corners: cornersWorld, centre,
        tint: h < 0.36 ? null : FIELD_TINTS[Math.floor(h2 * FIELD_TINTS.length)],
        hedgerow: h3 < 0.3,
        farmstead: onLaneCorner && h2 > 0.45,
      })
    }
  }
  return out
}

function slopeNormal(shape: TerrainShape, x: number, z: number): [number, number, number] {
  const height = (px: number, pz: number) => Math.max(shape.plateY, gridHeight(shape.grid, px, pz))
  const nx = -(height(x + 6, z) - height(x - 6, z)) / 12
  const nz = -(height(x, z + 6) - height(x, z - 6)) / 12
  const l = Math.hypot(nx, 1, nz)
  return [nx / l, 1 / l, nz / l]
}

type Point2 = [number, number]

function clipSide(polygon: Point2[], [ax, az]: Point2, [bx, bz]: Point2, inside = true): Point2[] {
  if (!polygon.length) return []
  const sign = inside ? 1 : -1
  const side = ([x, z]: Point2) => sign * ((bx - ax) * (z - az) - (bz - az) * (x - ax))
  const next: Point2[] = []
  let previous = polygon[polygon.length - 1], before = side(previous)
  for (const current of polygon) {
    const after = side(current)
    if ((before >= 0) !== (after >= 0)) {
      const t = before / (before - after)
      next.push([previous[0] + (current[0] - previous[0]) * t, previous[1] + (current[1] - previous[1]) * t])
    }
    if (after >= 0) next.push(current)
    previous = current
    before = after
  }
  return next
}

function clipTriangle(polygon: Point2[], triangle: Point2[]): Point2[] {
  let clipped = polygon
  for (let e = 0; e < 3 && clipped.length; e++) clipped = clipSide(clipped, triangle[e], triangle[(e + 1) % 3])
  return clipped
}

function subtractPolygon(polygon: Point2[], cut: Point2[]): Point2[][] {
  const pieces: Point2[][] = []
  let remaining = polygon
  for (let e = 0; e < cut.length && remaining.length >= 3; e++) {
    const a = cut[e], b = cut[(e + 1) % cut.length]
    const outside = clipSide(remaining, a, b, false)
    if (outside.length >= 3 && signedArea(outside.flat()) > 0.0001) pieces.push(outside)
    remaining = clipSide(remaining, a, b)
  }
  return pieces
}

function waterCuts(shape: TerrainShape): Point2[][] {
  const water = new Batch()
  for (const polygon of shape.water) water.polygon(polygon.ring, polygon.holes, 0, [1, 1, 1])
  const cuts: Point2[][] = []
  for (let i = 0; i < water.indices.length; i += 3) cuts.push(water.indices.slice(i, i + 3).map(v => [water.positions[v * 3], water.positions[v * 3 + 2]]))
  return cuts
}

class SurfaceReservations {
  readonly all: Point2[][] = []
  private readonly cells = new Map<number, Point2[][]>()
  private readonly grid: TerrainGrid

  constructor(shape: TerrainShape, cuts: Point2[][] = []) {
    this.grid = shape.grid
    for (const cut of cuts) this.add(cut)
  }

  add(ring: Point2[]): void {
    const { xs, zs } = this.grid
    const [x0, z0, x1, z1] = bounds(ring.flat())
    const i0 = gridInterval(xs, x0), i1 = gridInterval(xs, x1), j0 = gridInterval(zs, z0), j1 = gridInterval(zs, z1)
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const key = j * xs.length + i
      if (!this.cells.has(key)) this.cells.set(key, [])
      this.cells.get(key)!.push(ring)
    }
    this.all.push(ring)
  }

  remaining(polygon: Point2[], i: number, j: number): Point2[][] {
    let pieces = [polygon]
    for (const cut of this.cells.get(j * this.grid.xs.length + i) ?? []) {
      pieces = pieces.flatMap(piece => subtractPolygon(piece, cut))
      if (!pieces.length) break
    }
    return pieces
  }

  intersectsCircle(x: number, z: number, radius: number): boolean {
    const { xs, zs } = this.grid
    const seen = new Set<Point2[]>()
    for (let j = gridInterval(zs, z - radius); j <= gridInterval(zs, z + radius); j++) {
      for (let i = gridInterval(xs, x - radius); i <= gridInterval(xs, x + radius); i++) {
        for (const polygon of this.cells.get(j * xs.length + i) ?? []) {
          if (seen.has(polygon)) continue
          seen.add(polygon)
          const ring = polygon.flat()
          if (pointInRing(x, z, ring) || boundaryDistance(x, z, ring) < radius) return true
        }
      }
    }
    return false
  }
}

function drape(batch: Batch, ring: Point2[], shape: TerrainShape, color: RGB, lift: number, reservations?: SurfaceReservations): void {
  const { xs, zs } = shape.grid
  const [x0, z0, x1, z1] = bounds(ring.flat())
  const i0 = gridInterval(xs, x0), i1 = gridInterval(xs, x1)
  const j0 = gridInterval(zs, z0), j1 = gridInterval(zs, z1)
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const a: Point2 = [xs[i], zs[j]], b: Point2 = [xs[i + 1], zs[j]]
    const c: Point2 = [xs[i], zs[j + 1]], d: Point2 = [xs[i + 1], zs[j + 1]]
    for (const triangle of [[a, b, c], [b, d, c]]) {
      const clipped = clipTriangle(ring, triangle)
      if (clipped.length < 3) continue
      for (const polygon of reservations?.remaining(clipped, i, j) ?? [clipped]) {
        const base = batch.vertexCount
        for (const [x, z] of polygon) {
          const [nx, ny, nz] = slopeNormal(shape, x, z)
          batch.vertex(x, Math.max(shape.plateY, gridHeight(shape.grid, x, z)) + lift, z, nx, ny, nz, color)
        }
        for (let k = 1; k < polygon.length - 1; k++) {
          const [px, pz] = polygon[0], [qx, qz] = polygon[k], [rx, rz] = polygon[k + 1]
          if ((qx - px) * (rz - pz) - (rx - px) * (qz - pz) > 0.00001) batch.indices.push(base, base + k, base + k + 1)
        }
      }
    }
  }
  reservations?.add(ring)
}

/** A tinted field draped on the terrain as a small grid, so it follows the hills. */
function drapedField(batch: Batch, parcel: Parcel, shape: TerrainShape, tint: RGB, reservations: SurfaceReservations): void {
  drape(batch, parcel.corners, shape, tint, 0.12, reservations)
}

/** Gravel concession lanes: lattice lines every block, drawn only where both ends are farmland. */
function drapedLanes(batch: Batch, shape: TerrainShape, parcels: Parcel[], cuts: Point2[][], reservations: SurfaceReservations): void {
  if (!parcels.length) return
  const is = parcels.map((p) => p.i), js = parcels.map((p) => p.j)
  const i0 = Math.min(...is), i1 = Math.max(...is) + 1, j0 = Math.min(...js), j1 = Math.max(...js) + 1
  const step = 120
  const lane = (from: [number, number], to: [number, number]) => {
    const [ax, az] = fromLattice(from[0], from[1]), [bx, bz] = fromLattice(to[0], to[1])
    if (!isFarmland(shape, ax, az) || !isFarmland(shape, bx, bz)) return
    drapedStrip(batch, [ax, az, bx, bz], LANE_WIDTH, shape, LANE, 0.3, cuts, reservations)
  }
  for (let i = Math.ceil(i0 / LOTS_PER_BLOCK_U) * LOTS_PER_BLOCK_U; i <= i1; i += LOTS_PER_BLOCK_U) {
    for (let v = j0 * LOT_V; v < j1 * LOT_V; v += step) lane([i * LOT_U, v], [i * LOT_U, Math.min(v + step, j1 * LOT_V)])
  }
  for (let j = Math.ceil(j0 / LOTS_PER_BLOCK_V) * LOTS_PER_BLOCK_V; j <= j1; j += LOTS_PER_BLOCK_V) {
    for (let u = i0 * LOT_U; u < i1 * LOT_U; u += step) lane([u, j * LOT_V], [Math.min(u + step, i1 * LOT_U), j * LOT_V])
  }
}

/** Straight strip draped on the surface (sampled every 120 m), slightly proud of the ground. */
function drapedStrip(batch: Batch, line: Flat, width: number, shape: TerrainShape, color: RGB, lift: number, cuts: Point2[][] = [], reservations?: SurfaceReservations): void {
  const [ax, az, bx, bz] = line
  const len = Math.hypot(bx - ax, bz - az)
  if (len < 1) return
  const steps = Math.max(1, Math.ceil(len / 120))
  const dx = (bx - ax) / len, dz = (bz - az) / len
  const ox = -dz * width / 2, oz = dx * width / 2
  for (let s = 0; s < steps; s++) {
    const t0 = (s / steps) * len, t1 = ((s + 1) / steps) * len
    const x0 = ax + dx * t0, z0 = az + dz * t0, x1 = ax + dx * t1, z1 = az + dz * t1
    if (shape.inWater(x0, z0) || shape.inWater(x1, z1)) break
    const ring: Point2[] = [[x0 + ox, z0 + oz], [x0 - ox, z0 - oz], [x1 - ox, z1 - oz], [x1 + ox, z1 + oz]]
    cuts.push(ring)
    drape(batch, ring, shape, color, lift, reservations)
  }
}

/** A house and a barn beside the lane corner of a parcel, footprints aligned to the lattice. */
function farmstead(batch: Batch, parcel: Parcel, shape: TerrainShape, placements: PlacementGrid, obstacles?: SurfaceReservations): [number, number][] {
  const [u0, v0] = toLattice(parcel.corners[0][0], parcel.corners[0][1])
  const h = hash2(parcel.i * 3, parcel.j * 5)
  const lots: [number, number][] = []
  const building = (du: number, dv: number, w: number, d: number, height: number, c: { wall: RGB; roof: RGB }) => {
    const ring: Flat = []
    for (const [su, sv] of [[0, 0], [w, 0], [w, d], [0, d]]) {
      const [x, z] = fromLattice(u0 + du + su, v0 + dv + sv)
      ring.push(x, z)
    }
    const [cx, cz] = fromLattice(u0 + du + w / 2, v0 + dv + d / 2)
    const levels = [0, 2, 4, 6].map((i) => shape.surface(ring[i], ring[i + 1]))
    if (obstacles?.intersectsCircle(cx, cz, Math.hypot(w, d) / 2 + 0.3)) return
    if (!placements.reserve(cx, cz, Math.hypot(w, d) / 2 + 0.3, Math.min(...levels) - 0.5, Math.max(...levels) + height)) return
    batch.extrude(ring, undefined, Math.min(...levels) - 0.5, Math.max(...levels) + height, c.wall, c.roof)
    lots.push([cx, cz])
  }
  building(28, 24, 12, 9, 6, HOUSE)
  building(28 + 22 + h * 10, 20, 22, 11, 8, BARN)
  return lots
}

export interface Farmland {
  fields: Batch
  lanes: Batch
  buildings: Batch
  trees: TreePlacement[]
  cuts: Point2[][]
  placements: PlacementGrid
  obstacles: SurfaceReservations
  /** `parcelKey`s of cropped parcels, so loose trees stay out of the crops */
  tinted: Set<string>
}

/** Lattice cell of a world position, in the same indexing `farmParcels` uses. */
export function parcelKey(x: number, z: number): string {
  const [u, v] = toLattice(x, z)
  return `${Math.floor(u / LOT_U)}:${Math.floor(v / LOT_V)}`
}

export function farmland(shape: TerrainShape, roads: { shape: Flat; width: number }[], treeLimit: number, reservations?: SurfaceReservations): Farmland {
  if (!reservations) {
    reservations = new SurfaceReservations(shape, waterCuts(shape))
    const occupiedRoads = new Batch()
    for (const road of roads) drapedStrip(occupiedRoads, road.shape, road.width, shape, PALETTE.asphaltMajor, 0.4, [], reservations)
  }
  const placements = new PlacementGrid()
  // parcels mostly under the suburb are dropped; the rest are cut around its tiles like any other reservation
  const claimed = reservations
  const parcels = farmParcels(shape, roads, (x, z) => claimed.intersectsCircle(x, z, 150))
  const fields = new Batch(TEXTURE_RECIPES.grass.metres)
  const lanes = new Batch(TEXTURE_RECIPES.asphalt.metres)
  const buildings = new Batch()
  const trees: (TreePlacement & { priority: number })[] = []
  const cuts: Point2[][] = []
  const tinted = new Set<string>()
  drapedLanes(lanes, shape, parcels, cuts, reservations)
  const obstacles = new SurfaceReservations(shape, reservations.all)
  const [cx, cz] = [(shape.pack[0] + shape.pack[2]) / 2, (shape.pack[1] + shape.pack[3]) / 2]
  for (const parcel of parcels) {
    if (parcel.tint) {
      drapedField(fields, parcel, shape, parcel.tint, reservations)
      cuts.push(parcel.corners)
      tinted.add(`${parcel.i}:${parcel.j}`)
    }
    const near = Math.hypot(parcel.centre[0] - cx, parcel.centre[1] - cz)
    if (parcel.farmstead) {
      for (const [x, z] of farmstead(buildings, parcel, shape, placements, obstacles)) {
        for (let k = 0; k < 3; k++) {
          const a = hash2(parcel.i + k, parcel.j) * Math.PI * 2, r = 16 + 10 * hash2(parcel.j + k, parcel.i)
          const tx = x + Math.cos(a) * r, tz = z + Math.sin(a) * r
          trees.push({ x: tx, z: tz, y: shape.surface(tx, tz), scale: 1.3 + 0.6 * hash2(k, parcel.i), shade: hash2(parcel.i, k), priority: near })
        }
      }
    }
    if (parcel.hedgerow) {
      const [a, , , d] = parcel.corners
      const n = Math.floor(Math.hypot(d[0] - a[0], d[1] - a[1]) / 28)
      for (let k = 1; k < n; k++) {
        const t = k / n
        const x = a[0] + (d[0] - a[0]) * t, z = a[1] + (d[1] - a[1]) * t
        trees.push({ x, z, y: shape.surface(x, z), scale: 1.1 + 0.5 * hash2(parcel.i + k, parcel.j - k), shade: hash2(k, parcel.j), priority: near + 1500 })
      }
    }
  }
  const placed: TreePlacement[] = []
  for (const { x, y = 0, z, scale, shade } of trees.sort((p, q) => p.priority - q.priority || p.x - q.x || p.z - q.z)) {
    if (placed.length >= treeLimit) break
    const radius = TREE_RADIUS * scale + 0.2
    if (obstacles.intersectsCircle(x, z, radius) || !placements.reserve(x, z, radius, y, y + TREE_HEIGHT * scale)) continue
    placed.push({ x, y, z, scale, shade })
  }
  return { fields, lanes, buildings, tinted, cuts, placements, obstacles, trees: placed }
}

// ---------------------------------------------------------------------------------------------- suburban fringe

/**
 * Filler blocks around the compiled city: the street grid carried on across the plate and up into the hills on the
 * same survey tilt, fully built for `FRINGE_DENSE` metres from the last mapped buildings and then thinning out into
 * the farm parcels by `FRINGE_REACH`, so the city does not stop on a survey line.  Blocks go wherever the land is
 * unmapped (`surfaces.meadow` inside the pack, everything but water beyond it), are cut around every real road, path,
 * rail line and horizon road, and each block has a character — tower cluster, mid-rise, walk-ups or house rows — so
 * the skyline varies.  Purely presentational: nothing here is in the SUMO network, `BuildingIndex`, or the pack.
 */
const BLOCK_U = 150
const BLOCK_V = 64
const LOCAL_STREET = 11
const ARTERIAL_STREET = 20
const ARTERIALS_EVERY_U = 4
const ARTERIALS_EVERY_V = 8
/** metres from the mapped buildings the blocks stay fully built */
export const FRINGE_DENSE = 2200
/** metres from the mapped buildings by which the blocks have thinned out to nothing */
export const FRINGE_REACH = 3800
const ROAD_VERGE = 6
const TILE_LIFT = 0.08
const SLAB_LIFT = 0.16

export type BlockKind = 'tower' | 'midrise' | 'walkup' | 'houses'

export interface FringeBlock {
  i: number
  j: number
  kind: BlockKind
  /** metres from the nearest mapped buildings */
  distance: number
  /** 0 while fully built, 1 where the fringe has faded out */
  t: number
  /** the whole lattice cell, street centre-line to centre-line, clipped around the real roads */
  tiles: Point2[][]
  /** the block inside its streets, clipped the same way */
  slabs: Point2[][]
  slab: RGB
  lots: WorldBuilding[]
  trees: TreePlacement[]
}

const streetWidth = (index: number, every: number): number => (index % every === 0 ? ARTERIAL_STREET : LOCAL_STREET)

function boxesOverlap(a: readonly number[], b: readonly number[]): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
}

/** Point-in-surface lookup over compiled surface polygons (they are tiled, so a cell hash keeps this cheap). */
class SurfaceIndex {
  private readonly cells = new Map<string, { ring: Flat; holes: Flat[]; box: [number, number, number, number] }[]>()
  constructor(polygons: readonly { ring: Flat; holes?: Flat[] }[]) {
    for (const p of polygons) {
      const box = bounds(p.ring)
      const entry = { ring: p.ring, holes: p.holes ?? [], box }
      for (let i = Math.floor(box[0] / 400); i <= Math.floor(box[2] / 400); i++) for (let j = Math.floor(box[1] / 400); j <= Math.floor(box[3] / 400); j++) {
        const key = `${i}:${j}`
        if (!this.cells.has(key)) this.cells.set(key, [])
        this.cells.get(key)!.push(entry)
      }
    }
  }
  contains(x: number, z: number): boolean {
    return (this.cells.get(`${Math.floor(x / 400)}:${Math.floor(z / 400)}`) ?? []).some((p) =>
      x >= p.box[0] && x <= p.box[2] && z >= p.box[1] && z <= p.box[3] && pointInRing(x, z, p.ring) && !p.holes.some((h) => pointInRing(x, z, h)))
  }
}

/** A convex no-build area (a road with its verge, a mapped building's box) with its signed clearance, positive outside. */
interface Cut { ring: Point2[]; box: [number, number, number, number]; clearance(x: number, z: number): number }

/** Convex cuts hashed by 200 m cell, so a block can be clipped around, and lots kept off, everything real nearby. */
class CutIndex {
  private readonly cells = new Map<string, Cut[]>()
  private insert(cut: Cut): void {
    for (let i = Math.floor(cut.box[0] / 200); i <= Math.floor(cut.box[2] / 200); i++) for (let j = Math.floor(cut.box[1] / 200); j <= Math.floor(cut.box[3] / 200); j++) {
      const key = `${i}:${j}`
      if (!this.cells.has(key)) this.cells.set(key, [])
      this.cells.get(key)!.push(cut)
    }
  }
  /** a straight strip of `width` plus `verge` either side */
  strip(ax: number, az: number, bx: number, bz: number, width: number, verge = ROAD_VERGE): void {
    const len = Math.hypot(bx - ax, bz - az)
    if (len < 0.5) return
    const half = width / 2 + verge
    const ox = (-(bz - az) / len) * half, oz = ((bx - ax) / len) * half
    const ring: Point2[] = [[ax + ox, az + oz], [ax - ox, az - oz], [bx - ox, bz - oz], [bx + ox, bz + oz]]
    this.insert({ ring, box: bounds(ring.flat()), clearance: (x, z) => segmentDistance(x, z, [ax, az, bx, bz]) - half })
  }
  /** an axis-aligned box grown by `margin` */
  box(inner: readonly number[], margin: number): void {
    const box: [number, number, number, number] = [inner[0] - margin, inner[1] - margin, inner[2] + margin, inner[3] + margin]
    this.insert({ ring: [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]], box, clearance: (x, z) => boxDistance(box, x, z) })
  }
  near(box: readonly number[]): Cut[] {
    const out = new Set<Cut>()
    for (let i = Math.floor(box[0] / 200); i <= Math.floor(box[2] / 200); i++) for (let j = Math.floor(box[1] / 200); j <= Math.floor(box[3] / 200); j++) {
      for (const cut of this.cells.get(`${i}:${j}`) ?? []) if (boxesOverlap(box, cut.box)) out.add(cut)
    }
    return [...out]
  }
  /** no cut within `margin` metres of the point (negative `margin` accepts points just inside a cut) */
  clear(x: number, z: number, margin: number): boolean {
    for (let i = Math.floor((x - margin) / 200); i <= Math.floor((x + margin) / 200); i++) for (let j = Math.floor((z - margin) / 200); j <= Math.floor((z + margin) / 200); j++) {
      for (const cut of this.cells.get(`${i}:${j}`) ?? []) {
        if (x < cut.box[0] - margin || x > cut.box[2] + margin || z < cut.box[1] - margin || z > cut.box[3] + margin) continue
        if (cut.clearance(x, z) < margin) return false
      }
    }
    return true
  }
}

/**
 * Metres to the nearest mapped building, on a 100 m grid over `box`: brushfire from every building's cell, each cell
 * remembering its nearest source (near-exact Euclidean, one pass over a few ten-thousand cells).
 */
export function cityDistanceField(buildings: readonly Pick<WorldBuilding, 'ring'>[], box: readonly number[], cell = 100): (x: number, z: number) => number {
  const x0 = Math.floor(box[0] / cell), z0 = Math.floor(box[1] / cell)
  const nx = Math.ceil(box[2] / cell) - x0 + 1, nz = Math.ceil(box[3] / cell) - z0 + 1
  const src = new Int32Array(nx * nz).fill(-1)
  const queue: number[] = []
  for (const b of buildings) {
    if (b.ring.length < 6) continue
    const [cx, cz] = centroid(b.ring)
    const i = Math.floor(cx / cell) - x0, j = Math.floor(cz / cell) - z0
    if (i < 0 || j < 0 || i >= nx || j >= nz) continue
    const k = j * nx + i
    if (src[k] !== k) {
      src[k] = k
      queue.push(k)
    }
  }
  const dist2 = (k: number, s: number): number => {
    const di = (k % nx) - (s % nx), dj = Math.floor(k / nx) - Math.floor(s / nx)
    return di * di + dj * dj
  }
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head], s = src[k], i = k % nx, j = Math.floor(k / nx)
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ni = i + di, nj = j + dj
      if ((!di && !dj) || ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue
      const n = nj * nx + ni
      if (src[n] === -1 || dist2(n, s) < dist2(n, src[n])) {
        src[n] = s
        queue.push(n)
      }
    }
  }
  return (x, z) => {
    const i = Math.floor(x / cell) - x0, j = Math.floor(z / cell) - z0
    if (i < 0 || j < 0 || i >= nx || j >= nz) return Infinity
    const s = src[j * nx + i]
    if (s < 0) return Infinity
    return Math.max(0, Math.hypot(x - ((s % nx) + x0 + 0.5) * cell, z - (Math.floor(s / nx) + z0 + 0.5) * cell) - cell / 2)
  }
}

type FringeWorld = Pick<WorldData, 'roads' | 'rail' | 'water' | 'buildings' | 'landmarks' | 'massing' | 'surfaces'>

/** Deterministic filler blocks on the concession lattice around the mapped city. */
export function fringeBlocks(shape: TerrainShape, horizon: { shape: Flat; width: number }[], world: FringeWorld): FringeBlock[] {
  // Inside the plate the compiled surfaces say what is bare land (never a park, beach, rail yard or water); beyond
  // it everything but the lake is.  Old packs without compiled surfaces only get the ring outside the pack.
  const open = world.surfaces
    ? new SurfaceIndex([...(world.surfaces.meadow ?? []), ...world.surfaces.ground])
    : { contains: (x: number, z: number) => boxDistance(shape.pack, x, z) > 0 }
  const openAt = (x: number, z: number): boolean => boxDistance(shape.plate, x, z) > 0 ? !shape.inWater(x, z) : open.contains(x, z)
  const buildings = new BuildingIndex(world)
  const cuts = new CutIndex(), rails = new CutIndex()
  for (const r of horizon) cuts.strip(r.shape[0], r.shape[1], r.shape[2], r.shape[3], r.width, ROAD_VERGE + 6)
  for (const r of world.roads) {
    const verge = ROAD_VERGE + (/motorway|trunk/.test(r.type) ? 10 : 0)
    for (let i = 0; i + 3 < r.shape.length; i += 2) cuts.strip(r.shape[i], r.shape[i + 1], r.shape[i + 2], r.shape[i + 3], Math.max(r.w, 3), verge)
  }
  for (const line of world.rail) for (let i = 0; i + 3 < line.length; i += 2) rails.strip(line[i], line[i + 1], line[i + 2], line[i + 3], 3)
  for (const b of world.buildings) if (b.ring.length >= 6) cuts.box(bounds(b.ring), 5)
  const [px0, pz0, px1, pz1] = shape.pack
  const region = [px0 - FRINGE_REACH, pz0 - FRINGE_REACH, px1 + FRINGE_REACH, pz1 + FRINGE_REACH]
  const cityDistance = cityDistanceField(world.buildings, region)
  const water = world.water.map((w) => ({ ...w, box: bounds(w.ring) }))
  const nearWater = (x: number, z: number, margin: number): boolean => water.some((w) =>
    x > w.box[0] - margin && x < w.box[2] + margin && z > w.box[1] - margin && z < w.box[3] + margin
    && (boundaryDistance(x, z, w.ring) < margin || w.holes?.some((h) => boundaryDistance(x, z, h) < margin)))
  // Islands and spits stay green: how much of a 600 m circle around the block is water, from a 150 m raster of
  // "not on any compiled land surface" inside the plate and the far lake beyond it.
  const land = world.surfaces ? new SurfaceIndex(Object.values(world.surfaces).flat().filter((p) => p !== undefined)) : null
  const waterCells = new Map<number, boolean>()
  const isWater = (x: number, z: number): boolean => {
    const key = Math.floor(x / 150) * 1048576 + Math.floor(z / 150)
    let value = waterCells.get(key)
    if (value === undefined) {
      const sx = (Math.floor(x / 150) + 0.5) * 150, sz = (Math.floor(z / 150) + 0.5) * 150
      value = land && boxDistance(shape.plate, sx, sz) <= 0 ? !land.contains(sx, sz) : shape.inWater(sx, sz)
      waterCells.set(key, value)
    }
    return value
  }
  const waterFraction = (x: number, z: number): number => {
    let n = 0
    for (let k = 0; k < 24; k++) if (isWater(x + Math.cos((k / 24) * Math.PI * 2) * 600, z + Math.sin((k / 24) * Math.PI * 2) * 600)) n++
    return n / 24
  }
  const corners = [[region[0], region[1]], [region[2], region[1]], [region[2], region[3]], [region[0], region[3]]].map(([x, z]) => toLattice(x, z))
  const u0 = Math.min(...corners.map((c) => c[0])), u1 = Math.max(...corners.map((c) => c[0]))
  const v0 = Math.min(...corners.map((c) => c[1])), v1 = Math.max(...corners.map((c) => c[1]))
  const clear = (x: number, z: number, margin: number): boolean => openAt(x, z) && cuts.clear(x, z, margin) && rails.clear(x, z, margin)
  const clip = (ring: Point2[]): Point2[][] => {
    const box = bounds(ring.flat())
    let pieces = [ring]
    for (const cut of [...cuts.near(box), ...rails.near(box)]) {
      // each cut only touches the pieces whose box it overlaps; the rest pass through untouched
      pieces = pieces.flatMap((piece) => (boxesOverlap(bounds(piece.flat()), cut.box) ? subtractPolygon(piece, cut.ring) : [piece]))
      if (!pieces.length) break
    }
    return pieces.filter((piece) => signedArea(piece.flat()) > 30)
  }
  // A point the cell may cover: bare land, or something the cell will be cut around anyway.  Corners and edge
  // midpoints are shared between neighbouring cells, so they are looked up once by half-lattice index.
  const usableCache = new Map<number, boolean>()
  const usable = (iu: number, iv: number): boolean => {
    const key = iu * 1048576 + iv
    let value = usableCache.get(key)
    if (value === undefined) {
      const [x, z] = fromLattice(iu * BLOCK_U / 2, iv * BLOCK_V / 2)
      usableCache.set(key, (value = openAt(x, z) || !cuts.clear(x, z, 0)))
    }
    return value
  }
  const out: FringeBlock[] = []
  for (let i = Math.floor(u0 / BLOCK_U); i * BLOCK_U < u1; i++) {
    for (let j = Math.floor(v0 / BLOCK_V); j * BLOCK_V < v1; j++) {
      const ua = i * BLOCK_U + streetWidth(i, ARTERIALS_EVERY_U) / 2, ub = (i + 1) * BLOCK_U - streetWidth(i + 1, ARTERIALS_EVERY_U) / 2
      const va = j * BLOCK_V + streetWidth(j, ARTERIALS_EVERY_V) / 2, vb = (j + 1) * BLOCK_V - streetWidth(j + 1, ARTERIALS_EVERY_V) / 2
      const [cx, cz] = fromLattice((ua + ub) / 2, (va + vb) / 2)
      const distance = cityDistance(cx, cz)
      if (distance >= FRINGE_REACH || boxDistance(shape.farBounds, cx, cz) > -300) continue
      // fully built out to FRINGE_DENSE, then thinning in clumps to nothing at FRINGE_REACH
      const t = smooth((distance - FRINGE_DENSE) / (FRINGE_REACH - FRINGE_DENSE))
      const h = hash2(i * 13 + 7, j * 31 - 3), h2 = hash2(i - 991, j + 577)
      const mask = 0.5 + 0.5 * rollingNoise(cx + 4321, cz - 1234, 1100)
      if (h >= (t > 0 ? 0.97 * (1 - t) * (0.7 + 0.3 * mask) : 0.97)) continue
      // cheap rejections first: the mapped core, rail corridors, then the surfaces and water
      if (buildings.overlapsCircle(cx, cz, 90, -1, 1000) || !rails.clear(cx, cz, 50) || !openAt(cx, cz)) continue
      if (shape.shoreDistance(cx, cz) < 60 || nearWater(cx, cz, 60) || waterFraction(cx, cz) > 0.45) continue
      if ([[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]].some(([du, dv]) => !usable(2 * i + du, 2 * j + dv))) continue
      const tile = ([[i * BLOCK_U, j * BLOCK_V], [(i + 1) * BLOCK_U, j * BLOCK_V], [(i + 1) * BLOCK_U, (j + 1) * BLOCK_V], [i * BLOCK_U, (j + 1) * BLOCK_V]] as Point2[]).map(([u, v]) => fromLattice(u, v))
      const tiles = clip(tile)
      if (!tiles.length) continue
      const slabs = clip(([[ua, va], [ub, va], [ub, vb], [ua, vb]] as Point2[]).map(([u, v]) => fromLattice(u, v)))
      // taller blocks cluster toward the city; heights ease down with distance
      const rise = 1 - smooth(distance / FRINGE_REACH)
      const kind: BlockKind = distance < 1200 && h2 < 0.06 ? 'tower' : distance < 2000 && h2 < 0.36 ? 'midrise' : distance < 3000 && h2 < 0.56 ? 'walkup' : 'houses'
      const lots: WorldBuilding[] = []
      const trees: TreePlacement[] = []
      const rowDepth = (vb - va) / 2
      for (const row of [0, 1]) {
        const arterial = streetWidth(row ? j + 1 : j, ARTERIALS_EVERY_V) === ARTERIAL_STREET && t < 0.5
        let u = ua + 2, k = 0
        while (u < ub - 8) {
          const r1 = hash2(i * 8191 + row, j * 131 + k), r2 = hash2(i * 8191 + row + 3, j * 131 + k + 7), r3 = hash2(i * 8191 + row + 5, j * 131 + k + 11)
          const r4 = hash2(i * 8191 + row + 9, j * 131 + k + 13)
          const shop = kind === 'houses' && arterial && r3 < 0.5
          // house rows are a mix of detached lots and terraces of 3–8 units drawn as one strip
          const terrace = kind === 'houses' && !shop && r4 < 0.6
          const width = Math.min(ub - 2 - u,
            kind === 'tower' ? 38 + r1 * 12 : kind === 'midrise' ? 26 + r1 * 14 : kind === 'walkup' ? 16 + r1 * 10 : shop ? 14 + r1 * 8 : terrace ? 22 + r1 * 36 : 11 + r1 * 6)
          if (width < 9) break
          const depth = Math.min(rowDepth - 4, kind === 'tower' ? 22 + r2 * 4 : kind === 'midrise' ? 17 + r2 * 5 : kind === 'walkup' ? 13 + r2 * 4 : shop ? 15 + r2 * 5 : 10 + r2 * 4)
          const setback = kind === 'tower' ? 2 : kind === 'midrise' ? 2.5 : kind === 'walkup' ? 3 : shop ? 1.5 : 3 + r2 * 3
          const gap = kind === 'tower' ? 6 : kind === 'midrise' ? 4 : shop || terrace ? 1 : 2.5
          const near = row ? vb - setback - depth : va + setback, far = near + depth
          const ring = ([[u + gap / 2, near], [u + width - gap / 2, near], [u + width - gap / 2, far], [u + gap / 2, far]] as Point2[]).map(([lu, lv]) => fromLattice(lu, lv))
          const [lx, lz] = fromLattice(u + width / 2, (near + far) / 2)
          const occupied = r2 < 0.97 - 0.5 * t
          if (ring.every(([x, z]) => clear(x, z, 1.5)) && clear(lx, lz, 1.5)) {
            if (occupied) {
              // an occasional walk-up among the houses, and the odd slab among the walk-ups, keep the roofline uneven
              const spike = (kind === 'houses' && r3 < 0.08) || (kind === 'walkup' && r3 < 0.06)
              const jitter = 0.85 + 0.3 * r4
              const height = kind === 'tower' ? (42 + r3 * 38) * (0.5 + 0.5 * rise) * jitter
                : kind === 'midrise' ? (16 + r3 * 22) * (0.6 + 0.4 * rise) * jitter
                : kind === 'walkup' ? (10 + r3 * 7) * (spike ? 2.2 : 1) * jitter
                : shop ? (5 + r3 * 4) * jitter : (6 + r1 * 5) * (spike ? 1.9 : 1) * jitter
              const cat: BuildingCategory = kind === 'tower' ? (r3 < 0.6 ? 'tower' : 'apartments')
                : kind === 'midrise' ? (r3 < 0.55 ? 'apartments' : r3 < 0.75 ? 'commercial' : 'generic')
                : kind === 'walkup' || spike ? (r4 < 0.5 ? 'generic' : 'apartments')
                : shop ? 'retail' : r3 < 0.35 ? 'residential' : 'generic'
              lots.push({ id: `fringe:${i}:${j}:${row}:${k}`, ring: ring.flat(), h: Math.round(height * 10) / 10, cat })
            } else if (r3 < 0.6) {
              trees.push({ x: lx, z: lz, y: shape.surface(lx, lz), scale: 1 + r1 * 0.5, shade: r2 })
            }
          }
          u += width
          k++
        }
      }
      const slab = kind === 'houses' ? mix(PALETTE.land, PALETTE.meadow, 0.04 + 0.4 * t) : PALETTE.land
      out.push({ i, j, kind, distance, t, tiles, slabs, slab, lots, trees })
    }
  }
  return out
}

/** Heightfield vertex data; grid lines are pinned to the plate edges so the terrain meets the plate without a trench. */
export function terrainVertexData(shape: TerrainShape, cutouts: Point2[][] = []): VertexData {
  const { xs, zs } = shape.grid
  const water = new Batch()
  for (const polygon of shape.water) water.polygon(polygon.ring, polygon.holes, 0, [1, 1, 1])
  const cuts = [...cutouts]
  for (let i = 0; i < water.indices.length; i += 3) {
    cuts.push(water.indices.slice(i, i + 3).map((v) => [water.positions[v * 3], water.positions[v * 3 + 2]]))
  }
  const cells = new Map<number, Point2[][]>()
  for (const cut of cuts) {
    const [x0, z0, x1, z1] = bounds(cut.flat())
    const i0 = gridInterval(xs, x0), i1 = gridInterval(xs, x1)
    const j0 = gridInterval(zs, z0), j1 = gridInterval(zs, z1)
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const key = j * xs.length + i
      if (!cells.has(key)) cells.set(key, [])
      cells.get(key)!.push(cut)
    }
  }
  const land = new Batch(TEXTURE_RECIPES.grass.metres)
  const vertex = (x: number, z: number) => {
    const y = Math.max(shape.plateY, gridHeight(shape.grid, x, z))
    const [nx, ny, nz] = slopeNormal(shape, x, z)
    // the meadow tint at the plate edge, drifting drier on the hills and deeper in the hollows
    const tone = 0.5 + 0.5 * rollingNoise(x - 9000, z + 4000, 1300)
    const away = smooth(boxDistance(shape.plate, x, z) / 1500)
    let c: RGB = mix(PALETTE.meadow, mix(mix(PALETTE.green, GRASS_DRY, tone), GRASS_DEEP, smooth((shape.plateY + 12 - y) / 40) * 0.35), away)
    // the shore tint only reaches 140 m: beyond that the lookup stops at the polygons' bounding boxes
    const shore = shape.shoreDistance(x, z, 140)
    if (shore < 140) c = mix(SHORE, c, smooth(shore / 140))
    return land.vertex(x, y, z, nx, ny, nz, c)
  }
  for (let j = 0; j < zs.length - 1; j++) for (let i = 0; i < xs.length - 1; i++) {
    if (boxDistance(shape.plate, (xs[i] + xs[i + 1]) / 2, (zs[j] + zs[j + 1]) / 2) < 0) continue
    const a: Point2 = [xs[i], zs[j]], b: Point2 = [xs[i + 1], zs[j]]
    const c: Point2 = [xs[i], zs[j + 1]], d: Point2 = [xs[i + 1], zs[j + 1]]
    // positive shoelace in (x, z), the same up-facing front side Batch.polygon emits
    for (const triangle of [[a, b, c], [b, d, c]]) {
      let pieces = [triangle]
      for (const cut of cells.get(j * xs.length + i) ?? []) {
        pieces = pieces.flatMap((piece) => subtractPolygon(piece, cut))
        if (!pieces.length) break
      }
      for (const polygon of pieces) {
        const base = land.vertexCount
        for (const [x, z] of polygon) vertex(x, z)
        for (let k = 1; k < polygon.length - 1; k++) {
          if (signedArea([polygon[0], polygon[k], polygon[k + 1]].flat()) > 0.0001) land.indices.push(base, base + k, base + k + 1)
        }
      }
    }
  }
  const vd = new VertexData()
  vd.positions = new Float32Array(land.positions)
  vd.normals = new Float32Array(land.normals)
  vd.colors = new Float32Array(land.colors)
  vd.uvs = new Float32Array(land.uvs)
  vd.indices = new Uint32Array(land.indices)
  return vd
}

export interface Terrain {
  meshes: Mesh[]
  /** filler buildings inside the pack, where the city's shadow map reaches */
  shadowCasters: Mesh[]
  shape: TerrainShape
  dispose(): void
}

export function buildTerrain(scene: Scene, world: WorldData, materials: CityMaterials, opts: Partial<TerrainOptions> = {}): Terrain {
  const o = { ...TERRAIN_DEFAULTS, ...opts }
  const shape = terrainShape(world, o)
  performance.mark('terrain:shape')
  const foliage: StandardMaterial = vertexColorMaterial('country-foliage', scene, 0.015)
  const flat: StandardMaterial = vertexColorMaterial('country-flat', scene, 0.03)
  const meshes: Mesh[] = []
  const cuts: Point2[][] = []
  const reservations = new SurfaceReservations(shape, waterCuts(shape))

  if (shape.water.length) {
    const water = new Batch(TEXTURE_RECIPES.water.metres)
    for (const w of shape.water) water.polygon(w.ring, w.holes, Y.water, PALETTE.water)
    if (!water.isEmpty()) {
      const mesh = meshFromBatch('far-water', water, scene, materials.get('water'))
      mesh.receiveShadows = false
      meshes.push(mesh)
    }
  }

  performance.mark('terrain:water')
  const roads = horizonRoads(world.roads, world.crs.bounds_world, shape.farBounds, o.roadLimit)
  const add = (name: string, batch: Batch, material: Material) => {
    if (batch.isEmpty()) return
    const mesh = meshFromBatch(name, batch, scene, material)
    mesh.receiveShadows = false
    meshes.push(mesh)
  }
  const asphalt = new Batch(TEXTURE_RECIPES.asphalt.metres)
  for (const road of roads) drapedStrip(asphalt, road.shape, road.width, shape, PALETTE.asphaltMajor, 0.4, cuts, reservations)
  add('horizon-roads', asphalt, materials.get('asphalt'))
  performance.mark('terrain:roads')

  // Filler blocks on the unmapped land, chunked so the camera only draws the side of town it is looking at.  Chunks
  // inside the pack share the city's shadow map; the ring beyond it is unlit like the rest of the countryside.
  const fringeTrees: TreePlacement[] = []
  const shadowCasters: Mesh[] = []
  if (o.fringe) {
    // low boxes (houses, shops, walk-ups) are batched apart from the taller buildings, so only the latter cast shadows
    const chunks = new Map<string, { batches: Map<TextureKind, Batch>; low: Map<TextureKind, Batch>; inPack: boolean }>()
    const chunkAt = (x: number, z: number) => {
      const key = `${Math.floor(x / 1500)}:${Math.floor(z / 1500)}`
      let chunk = chunks.get(key)
      if (!chunk) chunks.set(key, (chunk = { batches: new Map(), low: new Map(), inPack: false }))
      return chunk
    }
    const batchFor = (chunk: ReturnType<typeof chunkAt>, kind: TextureKind, low = false): Batch => {
      const batches = low ? chunk.low : chunk.batches
      let batch = batches.get(kind)
      if (!batch) batches.set(kind, (batch = new Batch(TEXTURE_RECIPES[kind].metres)))
      return batch
    }
    for (const block of fringeBlocks(shape, roads, world)) {
      const [cx, cz] = centroid(block.tiles[0].flat())
      const chunk = chunkAt(cx, cz)
      chunk.inPack ||= boxDistance(shape.pack, cx, cz) < 0
      // streets and slabs follow the surface (flat on the plate, the hills beyond it), and the land beneath goes
      for (const tile of block.tiles) {
        drape(batchFor(chunk, 'asphalt'), tile, shape, PALETTE.asphaltMinor, TILE_LIFT)
        reservations.add(tile)
        cuts.push(tile)
      }
      for (const slab of block.slabs) drape(batchFor(chunk, 'concrete'), slab, shape, block.slab, SLAB_LIFT)
      for (const lot of block.lots) {
        // sit on the highest corner, sunk half a metre into the lowest, so a slope never shows under a wall
        const levels = [0, 2, 4, 6].map((k) => shape.surface(lot.ring[k], lot.ring[k + 1]))
        const floor = Math.min(...levels) - 0.6, top = Math.max(...levels) + lot.h
        const colour = buildingColor(lot), low = lot.h <= 20
        const facade = batchFor(chunk, facadeFor(lot), low), roof = batchFor(chunk, 'roof', low)
        if (low) {
          // houses, shops and walk-ups are plain boxes; there are a great many of them
          facade.walls(lot.ring, undefined, floor, top, colour.wall, 1)
          roof.polygon(lot.ring, undefined, top, colour.roof)
          continue
        }
        const base = Math.max(0, floor - 0.3)
        addArchitecture({ facade, roof, stone: batchFor(chunk, 'concrete'), glass: batchFor(chunk, 'glass'), metal: batchFor(chunk, 'industrial') },
          { ...lot, base, h: top - 0.3 - base }, colour, false)
      }
      fringeTrees.push(...block.trees)
    }
    for (const [key, chunk] of chunks) {
      for (const [group, batches] of [['', chunk.batches], ['low-', chunk.low]] as const) {
        for (const [kind, batch] of batches) {
          if (batch.isEmpty()) continue
          const mesh = meshFromBatch(`fringe-${key}-${group}${kind}`, batch, scene, materials.get(kind))
          mesh.receiveShadows = chunk.inPack
          if (chunk.inPack && !group && kind !== 'asphalt' && kind !== 'concrete') shadowCasters.push(mesh)
          meshes.push(mesh)
        }
      }
    }
  }

  performance.mark('terrain:fringe')
  const farm = farmland(shape, roads, Math.round(o.treeLimit * 0.8), reservations)
  add('fields', farm.fields, materials.get('grass'))
  add('lanes', farm.lanes, materials.get('asphalt'))
  add('farmsteads', farm.buildings, flat)
  performance.mark('terrain:farmland')

  const land = new Mesh('countryside', scene)
  terrainVertexData(shape, [...cuts, ...farm.cuts]).applyToMesh(land, false)
  performance.mark('terrain:land')
  land.material = materials.get('grass')
  land.isPickable = false
  land.receiveShadows = false
  land.freezeWorldMatrix()
  meshes.push(land)

  // coarse cells: the countryside is a 30 km box, and these trees are only ever seen from afar
  for (const t of o.reservedTrees ?? []) farm.placements.reserve(t.x, t.z, TREE_RADIUS * t.scale + 0.1, t.y ?? shape.plateY, (t.y ?? shape.plateY) + TREE_HEIGHT * t.scale)
  const cropped = (x: number, z: number, radius: number) => farm.tinted.has(parcelKey(x, z)) || farm.obstacles.intersectsCircle(x, z, radius)
  const trees = buildVegetation(scene, [...countryTrees(shape, roads, o.treeLimit, cropped, farm.placements), ...farm.trees], foliage, 0, 3000)
  for (const tree of trees) {
    tree.name = `country-${tree.name}`
    tree.receiveShadows = false
  }
  meshes.push(...trees)
  const yards = buildVegetation(scene, fringeTrees, foliage, shape.plateY, 1500)
  for (const tree of yards) {
    tree.name = `fringe-${tree.name}`
    tree.receiveShadows = false
  }
  meshes.push(...yards)
  performance.mark('terrain:trees')

  return {
    meshes,
    shadowCasters,
    shape,
    dispose() {
      for (const m of meshes) m.dispose()
      foliage.dispose()
      flat.dispose()
    },
  }
}
