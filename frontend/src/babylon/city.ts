/**
 * Static miniature Toronto: ground, water, parks, rail, SUMO roads (lane by lane, so sidewalks come for free),
 * junction caps, 10k procedural OSM buildings and hand-modelled landmarks.  Everything is batched into a few
 * dozen meshes by spatial chunk so frustum culling still works.  Nothing here moves; traffic and crowds are
 * separate systems driven by replay tracks.
 */

import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import type { Scene } from '@babylonjs/core/scene'

import { Batch, bounds, centroid, hash01, mix, scale, signedArea, type RGB } from './geometry'
import type { BuildingCategory, WorldBuilding, WorldData, WorldLandmark, WorldRoad } from './worldData'

export const Y = {
  ground: 0,
  water: 0.12,
  green: 0.22,
  sand: 0.22,
  path: 0.36,
  road: 0.5,
  junction: 0.56,
  rail: 0.62,
  stop: 0.7,
  building: 0.3,
}

export const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]

export const PALETTE = {
  land: hex('#d8d2c4'),
  water: hex('#3f7392'),
  green: hex('#93b96f'),
  sand: hex('#e3d3a8'),
  rail: hex('#6f685e'),
  asphaltMajor: hex('#55585e'),
  asphaltMinor: hex('#66696f'),
  asphaltService: hex('#75777c'),
  pavement: hex('#c9c1b3'),
  pathway: hex('#bfb6a6'),
  stop: hex('#d7263d'),
  roofDark: hex('#6d6a66'),
}

const CATEGORY: Record<BuildingCategory, { wall: RGB; alt: RGB; roof: RGB }> = {
  generic: { wall: hex('#d9d2c5'), alt: hex('#c8bfae'), roof: hex('#a39c90') },
  residential: { wall: hex('#dccab5'), alt: hex('#b98a72'), roof: hex('#8e7d70') },
  apartments: { wall: hex('#d3d6da'), alt: hex('#c2b8ad'), roof: hex('#8f9296') },
  retail: { wall: hex('#dcc09f'), alt: hex('#cfae8d'), roof: hex('#9c8b78') },
  utility: { wall: hex('#aca89f'), alt: hex('#9d9992'), roof: hex('#7b7873') },
  civic: { wall: hex('#e6e1d4'), alt: hex('#d8d1c1'), roof: hex('#a7a195') },
  office: { wall: hex('#a9bdcf'), alt: hex('#8fa6bb'), roof: hex('#6f7f8c') },
  tower: { wall: hex('#9fb6cb'), alt: hex('#7d97ae'), roof: hex('#5f6d79') },
  commercial: { wall: hex('#c9c4ba'), alt: hex('#b7b0a4'), roof: hex('#8b8579') },
  hotel: { wall: hex('#cfc4d6'), alt: hex('#bfb2c8'), roof: hex('#8c8494') },
  industrial: { wall: hex('#b9b3a8'), alt: hex('#a59f94'), roof: hex('#7d7870') },
  landmark: { wall: hex('#e4dfd3'), alt: hex('#e4dfd3'), roof: hex('#b3ada1') },
}

const LANDMARK_COLOR: Record<string, { wall: RGB; roof: RGB }> = {
  cn_tower: { wall: hex('#dcdcd8'), roof: hex('#b7b7b3') },
  rogers_centre: { wall: hex('#d9d6cd'), roof: hex('#f0eee8') },
  scotiabank_arena: { wall: hex('#b7a793'), roof: hex('#8c7f70') },
  union_station: { wall: hex('#dbceb2'), roof: hex('#a89b82') },
  city_hall: { wall: hex('#cfd3d8'), roof: hex('#9aa0a7') },
  roy_thomson_hall: { wall: hex('#9fb6c8'), roof: hex('#7d94a6') },
  ripleys_aquarium: { wall: hex('#83aabe'), roof: hex('#5f8a9f') },
}

export interface CityMeshes {
  ground: Mesh
  chunks: Mesh[]
  landmarks: Mesh
  stops: Mesh
  shadowCasters: Mesh[]
  dispose(): void
}

export function meshFromBatch(name: string, batch: Batch, scene: Scene, material: StandardMaterial): Mesh {
  const mesh = new Mesh(name, scene)
  const vd = new VertexData()
  vd.positions = new Float32Array(batch.positions)
  vd.normals = new Float32Array(batch.normals)
  vd.colors = new Float32Array(batch.colors)
  vd.indices = batch.vertexCount > 65535 ? new Uint32Array(batch.indices) : new Uint16Array(batch.indices)
  vd.applyToMesh(mesh, false)
  mesh.material = material
  mesh.isPickable = false
  mesh.freezeWorldMatrix()
  mesh.doNotSyncBoundingInfo = true
  return mesh
}

export function vertexColorMaterial(name: string, scene: Scene, specular = 0.05): StandardMaterial {
  const m = new StandardMaterial(name, scene)
  m.diffuseColor = Color3.White()
  m.ambientColor = Color3.White()
  m.specularColor = new Color3(specular, specular, specular)
  m.specularPower = 32
  m.backFaceCulling = true
  return m
}

class ChunkGrid<T> {
  readonly cells = new Map<string, T>()
  readonly size: number
  readonly make: () => T
  constructor(size: number, make: () => T) {
    this.size = size
    this.make = make
  }
  at(x: number, z: number): T {
    const k = `${Math.floor(x / this.size)}:${Math.floor(z / this.size)}`
    let c = this.cells.get(k)
    if (!c) {
      c = this.make()
      this.cells.set(k, c)
    }
    return c
  }
}

function roadColor(r: WorldRoad, pedOnlyLane: boolean): RGB {
  if (pedOnlyLane) return PALETTE.pavement
  const t = r.type
  if (t.includes('motorway') || t.includes('primary') || t.includes('trunk') || t.includes('secondary')) return PALETTE.asphaltMajor
  if (t.includes('service') || t.includes('living') || t.includes('unclassified')) return PALETTE.asphaltService
  return PALETTE.asphaltMinor
}

function buildingColor(b: WorldBuilding): { wall: RGB; roof: RGB } {
  const c = CATEGORY[b.cat] ?? CATEGORY.generic
  const j = hash01(b.id)
  const wall = mix(c.wall, c.alt, j * 0.9)
  // taller = cooler/glassier; short = warmer
  const tall = Math.min(1, Math.max(0, (b.h - 30) / 120))
  const glass: RGB = hex('#98b3c9')
  return { wall: mix(wall, glass, tall * 0.55), roof: mix(c.roof, PALETTE.roofDark, tall * 0.5) }
}

export function buildCity(scene: Scene, world: WorldData): CityMeshes {
  const [bx0, bz0, bx1, bz1] = world.crs.bounds_world
  const w = bx1 - bx0
  const d = bz1 - bz0

  const groundMat = new StandardMaterial('ground', scene)
  groundMat.diffuseColor = Color3.FromArray(PALETTE.land)
  groundMat.ambientColor = Color3.FromArray(PALETTE.land).scale(0.35)
  groundMat.specularColor = Color3.Black()
  const ground = CreateGround('ground', { width: w * 1.6, height: d * 1.6, subdivisions: 2 }, scene)
  ground.position = new Vector3((bx0 + bx1) / 2, Y.ground, (bz0 + bz1) / 2)
  ground.material = groundMat
  ground.receiveShadows = true
  ground.isPickable = true
  ground.freezeWorldMatrix()

  const flatMat = vertexColorMaterial('flat', scene, 0.02)
  const waterMat = vertexColorMaterial('water', scene, 0.35)
  waterMat.specularPower = 96
  const buildingMat = vertexColorMaterial('buildings', scene, 0.08)
  const landmarkMat = vertexColorMaterial('landmarks', scene, 0.12)

  const chunks: Mesh[] = []
  const casters: Mesh[] = []

  // --- water (one mesh; the lake polygon is huge and culls badly anyway)
  const water = new Batch()
  for (const poly of world.water) water.polygon(poly.ring, poly.holes, Y.water, PALETTE.water)
  if (!water.isEmpty()) chunks.push(meshFromBatch('water', water, scene, waterMat))

  // --- surfaces: parks, sand, rail, paths, roads, junctions — chunked 1.2 km
  const surf = new ChunkGrid(1200, () => new Batch())
  for (const ring of world.green) {
    const [cx, cz] = centroid(ring)
    surf.at(cx, cz).polygon(ring, undefined, Y.green, mix(PALETTE.green, hex('#7ea55f'), hash01(String(ring[0])) * 0.6))
  }
  for (const ring of world.sand) {
    const [cx, cz] = centroid(ring)
    surf.at(cx, cz).polygon(ring, undefined, Y.sand, PALETTE.sand)
  }
  for (const r of world.roads) {
    const b = surf.at(r.shape[0], r.shape[1])
    if (r.kind === 'path' || !r.lanes?.length) {
      b.ribbon(r.shape, Math.max(1.6, Math.min(r.w, 4)), Y.path, PALETTE.pathway)
      continue
    }
    for (const ln of r.lanes) {
      const pedOnly = ln.allow.length === 1 && ln.allow[0] === 'ped'
      b.ribbon(ln.shape, ln.w + 0.25, pedOnly ? Y.path : Y.road, roadColor(r, pedOnly))
    }
  }
  for (const j of world.junctions) {
    if (j.ring.length < 6) continue
    const roadJ = j.kind === 'road'
    surf.at(j.x, j.z).polygon(j.ring, undefined, roadJ ? Y.junction : Y.path, roadJ ? PALETTE.asphaltMinor : PALETTE.pathway)
  }
  for (const line of world.rail) {
    surf.at(line[0], line[1]).ribbon(line, 1.6, Y.rail, PALETTE.rail)
  }
  let i = 0
  for (const b of surf.cells.values()) {
    if (b.isEmpty()) continue
    const m = meshFromBatch(`surface-${i++}`, b, scene, flatMat)
    m.receiveShadows = true
    chunks.push(m)
  }

  // --- buildings, chunked 800 m so the camera only draws what it sees
  const bld = new ChunkGrid(800, () => new Batch())
  for (const b of world.buildings) {
    if (b.cat === 'landmark') continue
    if (b.ring.length < 6 || Math.abs(signedArea(b.ring)) < 4) continue
    const [cx, cz] = centroid(b.ring)
    const c = buildingColor(b)
    const h = Math.max(3, b.h)
    const batch = bld.at(cx, cz)
    batch.extrude(b.ring, b.holes, Y.building, Y.building + h, c.wall, c.roof)
    if (h > 40) {
      // a slim rooftop plant box reads as "tower" at miniature scale
      const [x0, z0, x1, z1] = bounds(b.ring)
      const sx = (x1 - x0) * 0.22
      const sz = (z1 - z0) * 0.22
      if (sx > 3 && sz > 3) {
        const mx = (x0 + x1) / 2
        const mz = (z0 + z1) / 2
        const box = [mx - sx, mz - sz, mx + sx, mz - sz, mx + sx, mz + sz, mx - sx, mz + sz]
        batch.extrude(box, undefined, Y.building + h, Y.building + h + Math.min(6, h * 0.08), scale(c.wall, 0.9), scale(c.roof, 0.9))
      }
    }
  }
  i = 0
  for (const b of bld.cells.values()) {
    if (b.isEmpty()) continue
    const m = meshFromBatch(`buildings-${i++}`, b, scene, buildingMat)
    m.receiveShadows = true
    chunks.push(m)
    casters.push(m)
  }

  // --- landmarks
  const lm = new Batch()
  for (const l of world.landmarks) buildLandmark(lm, l)
  const landmarks = meshFromBatch('landmarks', lm, scene, landmarkMat)
  landmarks.receiveShadows = true
  casters.push(landmarks)

  // --- stops
  const st = new Batch()
  for (const s of world.stops) st.disc(s.x, s.z, 3.2, Y.stop, PALETTE.stop, 12)
  const stops = meshFromBatch('stops', st, scene, flatMat)

  return {
    ground,
    chunks,
    landmarks,
    stops,
    shadowCasters: casters,
    dispose() {
      ground.dispose()
      for (const c of chunks) c.dispose()
      landmarks.dispose()
      stops.dispose()
      groundMat.dispose()
      flatMat.dispose()
      waterMat.dispose()
      buildingMat.dispose()
      landmarkMat.dispose()
    },
  }
}

function buildLandmark(batch: Batch, l: WorldLandmark): void {
  const c = LANDMARK_COLOR[l.kind] ?? CATEGORY.landmark
  switch (l.kind) {
    case 'cn_tower': {
      // The real thing: 553 m to the antenna tip, main pod 335-350 m, SkyPod at 447 m.  Footprint centroid = axis.
      const x = l.x
      const z = l.z
      const concrete = c.wall
      const glass: RGB = hex('#4d5f6e')
      batch.lathe(x, z, [[30, Y.building], [26, 6], [16, 40], [12, 120], [9.5, 250], [9, 330]], concrete, 18)
      batch.lathe(x, z, [[9, 328], [24, 333], [32, 340], [33, 347], [31, 352], [24, 357], [12, 361], [9, 362]], glass, 24)
      batch.lathe(x, z, [[9, 361], [7.5, 440]], concrete, 12)
      batch.lathe(x, z, [[7.5, 440], [11.5, 444], [12, 451], [8.5, 456], [6.5, 457]], glass, 16)
      batch.lathe(x, z, [[6.5, 456], [4, 470], [2.6, 510], [1.2, 553]], concrete, 8)
      return
    }
    case 'rogers_centre': {
      const wallH = 32
      batch.walls(l.ring, undefined, Y.building, Y.building + wallH, c.wall)
      batch.polygon(l.ring, undefined, Y.building + wallH, scale(c.wall, 0.95))
      const [x0, z0, x1, z1] = bounds(l.ring)
      const rx = ((x1 - x0) / 2) * 0.93
      const rz = ((z1 - z0) / 2) * 0.93
      dome(batch, (x0 + x1) / 2, (z0 + z1) / 2, rx, rz, Y.building + wallH - 2, Math.max(20, l.h - wallH), c.roof)
      return
    }
    case 'union_station': {
      // Beaux-Arts hall: base block, tall central hall, colonnade hinted by pilasters on the north face.
      batch.extrude(l.ring, undefined, Y.building, Y.building + l.h * 0.7, c.wall, c.roof)
      const inset = insetBox(l.ring, 0.62, 0.55)
      batch.extrude(inset, undefined, Y.building + l.h * 0.7, Y.building + l.h * 1.25, c.wall, scale(c.roof, 0.9))
      return
    }
    case 'city_hall': {
      // two curved towers + the council chamber "saucer"
      const [x0, z0, x1, z1] = bounds(l.ring)
      const cx = (x0 + x1) / 2
      const cz = (z0 + z1) / 2
      batch.extrude(l.ring, undefined, Y.building, Y.building + 8, c.wall, c.roof)
      dome(batch, cx, cz - 10, 22, 22, Y.building + 4, 14, c.roof)
      batch.lathe(cx - 34, cz + 14, [[18, Y.building], [18, 99]], c.wall, 20)
      batch.lathe(cx + 34, cz + 18, [[16, Y.building], [16, 79]], c.wall, 20)
      return
    }
    default: {
      batch.extrude(l.ring, undefined, Y.building, Y.building + l.h, c.wall, c.roof)
      if (l.kind === 'scotiabank_arena') {
        const inset = insetBox(l.ring, 0.7, 0.7)
        batch.extrude(inset, undefined, Y.building + l.h, Y.building + l.h * 1.3, c.wall, scale(c.roof, 0.9))
      }
    }
  }
}

function insetBox(ring: number[], fx: number, fz: number): number[] {
  const [x0, z0, x1, z1] = bounds(ring)
  const mx = (x0 + x1) / 2
  const mz = (z0 + z1) / 2
  const sx = ((x1 - x0) / 2) * fx
  const sz = ((z1 - z0) / 2) * fz
  return [mx - sx, mz - sz, mx + sx, mz - sz, mx + sx, mz + sz, mx - sx, mz + sz]
}

/** Elliptical dome (quarter-ellipse profile), light from the south-west like the walls. */
function dome(batch: Batch, x: number, z: number, rx: number, rz: number, y0: number, h: number, c: RGB): void {
  const rings = 8
  const segs = 32
  const idx: number[][] = []
  for (let j = 0; j <= rings; j++) {
    const t = j / rings
    const y = y0 + Math.sin((t * Math.PI) / 2) * h
    const k = Math.cos((t * Math.PI) / 2)
    const row: number[] = []
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2
      const nx = Math.cos(a) * k
      const nz = Math.sin(a) * k
      const ny = Math.sin((t * Math.PI) / 2)
      const shade = 0.78 + 0.22 * Math.max(0, ny * 0.7 - nx * 0.4 - nz * 0.5)
      row.push(batch.vertex(x + Math.cos(a) * rx * k, y, z + Math.sin(a) * rz * k, nx, ny, nz, scale(c, shade)))
    }
    idx.push(row)
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segs; i++) {
      const i2 = (i + 1) % segs
      batch.indices.push(idx[j][i], idx[j + 1][i], idx[j][i2], idx[j][i2], idx[j + 1][i], idx[j + 1][i2])
    }
  }
}
