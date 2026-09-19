/**
 * Static miniature Toronto: ground, water, parks, rail, SUMO roads (lane by lane, so sidewalks come for free),
 * junction caps, 10k procedural OSM buildings and hand-modelled landmarks.  Everything is batched into a few
 * dozen meshes by spatial chunk so frustum culling still works.  Nothing here moves; traffic and crowds are
 * separate systems driven by replay tracks.
 */

import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import type { Scene } from '@babylonjs/core/scene'
import type { Material } from '@babylonjs/core/Materials/material'
import { addArchitecture } from './architecture'
import { appendMassing } from './massing'

import { Batch, bounds, centroid, hash01, mix, scale, signedArea, type RGB } from './geometry'
import { facadeFor, TEXTURE_RECIPES, type TextureKind } from './appearance'
import { roadDashes, treePlacements } from './details'
import { CityMaterials } from './materials'
import { buildVegetation } from './vegetation'
import type { BuildingCategory, WorldBuilding, WorldData, WorldLandmark, WorldRoad } from './worldData'

export const Y = {
  ground: 0,
  water: -1.2,
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
  land: hex('#b7b6a5'),
  water: hex('#327781'),
  green: hex('#78985b'),
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
  engineering_7: { wall: hex('#c7b99f'), roof: hex('#879399') },
  engineering_5: { wall: hex('#c5cbd0'), roof: hex('#879299') },
  engineering_6: { wall: hex('#b4c0c6'), roof: hex('#77858e') },
  davis_centre: { wall: hex('#d9c4ae'), roof: hex('#b38b75') },
  quantum_nano: { wall: hex('#b5c2c5'), roof: hex('#73868b') },
}

export interface CityMeshes {
  ground: Mesh
  chunks: Mesh[]
  landmarks: Mesh
  stops: Mesh
  shadowCasters: Mesh[]
  dispose(): void
}

export function meshFromBatch(name: string, batch: Batch, scene: Scene, material: Material): Mesh {
  const mesh = new Mesh(name, scene)
  if (!batch.isEmpty()) {
    const vd = new VertexData()
    vd.positions = new Float32Array(batch.positions)
    vd.normals = new Float32Array(batch.normals)
    vd.colors = new Float32Array(batch.colors)
    vd.uvs = new Float32Array(batch.uvs)
    vd.indices = batch.vertexCount > 65535 ? new Uint32Array(batch.indices) : new Uint16Array(batch.indices)
    vd.applyToMesh(mesh, false)
  }
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
  const glass = [hex('#7f9b94'), hex('#c4c4ae'), hex('#688b98'), hex('#ad9e80'), hex('#89978a'), hex('#adb8b8'), hex('#77847f')][Math.floor(hash01(`${b.id}:glazing`) * 7)]
  return { wall: mix(wall, glass, Math.max(tall * 0.88, b.cat === 'office' ? 0.85 : 0)), roof: mix(c.roof, PALETTE.roofDark, tall * 0.5) }
}

export function buildCity(scene: Scene, world: WorldData, facadeResolution = 1024): CityMeshes {
  const [bx0, bz0, bx1, bz1] = world.crs.bounds_world
  const w = bx1 - bx0
  const d = bz1 - bz0

  const materials = new CityMaterials(scene, facadeResolution)
  const land = new Batch(TEXTURE_RECIPES.concrete.metres)
  const plate = [bx0 - w * 0.3, bz0 - d * 0.3, bx1 + w * 0.3, bz0 - d * 0.3, bx1 + w * 0.3, bz1 + d * 0.3, bx0 - w * 0.3, bz1 + d * 0.3]
  land.polygon(plate, world.water.map((p) => p.ring), Y.ground, PALETTE.land)
  for (const poly of world.water) {
    for (const island of poly.holes ?? []) land.polygon(island, undefined, Y.ground, PALETTE.land)
  }
  const ground = meshFromBatch('ground', land, scene, materials.get('concrete'))
  ground.receiveShadows = true
  ground.isPickable = true

  const flatMat = vertexColorMaterial('flat', scene, 0.02)
  const foliageMat = vertexColorMaterial('foliage', scene, 0.02)
  const landmarkMat = materials.get('concrete')

  const chunks: Mesh[] = []
  const casters: Mesh[] = []
  const makeBatches = () => new Map<TextureKind | 'paint', Batch>()
  const batchFor = (cell: ReturnType<typeof makeBatches>, kind: TextureKind | 'paint'): Batch => {
    let batch = cell.get(kind)
    if (!batch) {
      batch = new Batch(kind === 'paint' ? undefined : TEXTURE_RECIPES[kind].metres)
      cell.set(kind, batch)
    }
    return batch
  }
  const flush = (grid: ChunkGrid<ReturnType<typeof makeBatches>>, prefix: string, shadows: boolean) => {
    for (const [key, cell] of grid.cells) {
      for (const [kind, batch] of cell) {
        if (batch.isEmpty()) continue
        const mesh = meshFromBatch(`${prefix}-${key}-${kind}`, batch, scene, kind === 'paint' ? flatMat : materials.get(kind))
        mesh.receiveShadows = true
        chunks.push(mesh)
        if (shadows) casters.push(mesh)
      }
    }
  }

  // --- water (one mesh; the lake polygon is huge and culls badly anyway)
  const water = new Batch(TEXTURE_RECIPES.water.metres)
  const shoreline = new Batch(TEXTURE_RECIPES.concrete.metres)
  for (const poly of world.water) {
    water.polygon(poly.ring, poly.holes, Y.water, PALETTE.water)
    shoreline.walls(poly.ring, poly.holes, Y.water, Y.ground, [0.58, 0.56, 0.49], 1, true)
  }
  if (!water.isEmpty()) {
    chunks.push(meshFromBatch('water', water, scene, materials.get('water')))
    chunks.push(meshFromBatch('shoreline', shoreline, scene, materials.get('concrete')))
  }

  // --- surfaces: parks, sand, rail, paths, roads, junctions — chunked 1.2 km
  const surf = new ChunkGrid(1200, makeBatches)
  for (const ring of world.green) {
    const [cx, cz] = centroid(ring)
    batchFor(surf.at(cx, cz), 'grass').polygon(ring, undefined, Y.green, mix(PALETTE.green, hex('#7ea55f'), hash01(String(ring[0])) * 0.6))
  }
  for (const ring of world.sand) {
    const [cx, cz] = centroid(ring)
    batchFor(surf.at(cx, cz), 'sand').polygon(ring, undefined, Y.sand, PALETTE.sand)
  }
  for (const r of world.roads) {
    const cell = surf.at(r.shape[0], r.shape[1])
    if (r.kind === 'path' || !r.lanes?.length) {
      batchFor(cell, 'pavement').ribbon(r.shape, Math.max(1.6, Math.min(r.w, 4)), Y.path, PALETTE.pathway)
      continue
    }
    for (const ln of r.lanes) {
      const pedOnly = ln.allow.length === 1 && ln.allow[0] === 'ped'
      batchFor(cell, pedOnly ? 'pavement' : 'asphalt').ribbon(ln.shape, ln.w + 0.25, pedOnly ? Y.path : Y.road, roadColor(r, pedOnly))
    }
    const lanes = r.lanes.filter((ln) => ln.allow.includes('car') || ln.allow.includes('bus'))
    for (const ln of lanes.slice(0, -1)) {
      for (const dash of roadDashes(ln.shape, ln.w / 2)) batchFor(cell, 'paint').ribbon(dash, 0.16, Y.road + 0.035, [0.88, 0.86, 0.75])
    }
  }
  for (const j of world.junctions) {
    if (j.ring.length < 6) continue
    const roadJ = j.kind === 'road'
    batchFor(surf.at(j.x, j.z), roadJ ? 'asphalt' : 'pavement').polygon(j.ring, undefined, roadJ ? Y.junction : Y.path, roadJ ? PALETTE.asphaltMinor : PALETTE.pathway)
  }
  for (const line of world.rail) {
    batchFor(surf.at(line[0], line[1]), 'roof').ribbon(line, 1.6, Y.rail, PALETTE.rail)
  }
  flush(surf, 'surface', false)

  // --- buildings, chunked 800 m so the camera only draws what it sees
  const bld = new ChunkGrid(500, makeBatches)
  const focus = world.landmarks.find(l => l.kind === 'cn_tower') ?? world.venue
  const replaced = new Set(world.massing?.excluded_osm_ids ?? [])
  for (const b of world.buildings) {
    if (replaced.has(b.id)) continue
    if (b.cat === 'landmark' && world.landmarks.some((l) => l.id === b.id)) continue
    if (b.ring.length < 6 || Math.abs(signedArea(b.ring)) < 4) continue
    const [cx, cz] = centroid(b.ring)
    const c = buildingColor(b)
    const cell = bld.at(cx, cz)
    addArchitecture({
      facade: batchFor(cell, facadeFor(b)), roof: batchFor(cell, 'roof'),
      stone: batchFor(cell, 'concrete'), glass: batchFor(cell, 'glass'), metal: batchFor(cell, 'industrial'),
    }, b, c, Math.hypot(cx - focus.x, cz - focus.z) < 1500)
  }
  for (const b of world.massing?.buildings ?? []) {
    const cell = bld.at(b.x, b.z)
    const color = buildingColor({ ...b, ring: [] })
    appendMassing(b, batchFor(cell, facadeFor(b)), batchFor(cell, 'roof'), color.wall)
  }
  flush(bld, 'buildings', true)

  const trees = buildVegetation(scene, treePlacements(world), foliageMat)
  chunks.push(...trees)
  casters.push(...trees)

  // --- landmarks; individual fallback meshes stay visible until their GLB is ready.
  const landmarks = new Mesh('landmarks', scene)
  for (const l of world.landmarks) {
    const lm = new Batch(TEXTURE_RECIPES.concrete.metres)
    const landmarkGlass = new Batch(TEXTURE_RECIPES.glass.metres)
    buildLandmark(lm, landmarkGlass, l)
    for (const [suffix, batch, mat] of [['solid', lm, landmarkMat], ['glass', landmarkGlass, materials.get('glass')]] as const) {
      if (batch.isEmpty()) continue
      const mesh = meshFromBatch(`landmark-${l.kind}-${suffix}`, batch, scene, mat)
      mesh.metadata = { landmarkKind: l.kind }
      mesh.receiveShadows = true
      chunks.push(mesh)
      casters.push(mesh)
    }
  }

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
      flatMat.dispose()
      foliageMat.dispose()
      materials.dispose()
    },
  }
}

function buildLandmark(batch: Batch, glazing: Batch, l: WorldLandmark): void {
  const c = LANDMARK_COLOR[l.kind] ?? CATEGORY.landmark
  switch (l.kind) {
    case 'engineering_7':
    case 'engineering_5':
    case 'engineering_6':
    case 'davis_centre':
    case 'quantum_nano': {
      const top = Y.building + l.h
      const plinth = Y.building + Math.min(1.4, l.h * 0.1)
      batch.walls(l.ring, l.holes, Y.building, plinth, c.wall, 1)
      let glassStart = plinth
      for (let y = Y.building + 3.3; y < top - 0.45; y += 3.3) {
        glazing.walls(l.ring, l.holes, glassStart, y, c.wall, 1)
        glassStart = Math.min(y + 0.3, top - 0.45)
        batch.walls(l.ring, l.holes, y, glassStart, scale(c.wall, 1.08), 1)
      }
      glazing.walls(l.ring, l.holes, glassStart, top - 0.45, c.wall, 1)
      batch.walls(l.ring, l.holes, top - 0.45, top, c.wall, 1)
      batch.polygon(l.ring, l.holes, top, c.roof)
      return
    }
    case 'cn_tower': {
      // The real thing: 553 m to the antenna tip, main pod 335-350 m, SkyPod at 447 m.  Footprint centroid = axis.
      const x = l.x
      const z = l.z
      const concrete = c.wall
      const glass: RGB = hex('#bdcfdb')
      batch.lathe(x, z, [[30, Y.building], [26, 6], [16, 40], [12, 120], [9.5, 250], [9, 330]], concrete, 24)
      batch.lathe(x, z, [[9, 328], [24, 333], [32, 340]], concrete, 48)
      glazing.lathe(x, z, [[32, 340], [33, 347], [31, 352]], glass, 48)
      batch.lathe(x, z, [[31, 352], [24, 357], [12, 361], [9, 362]], concrete, 48)
      batch.lathe(x, z, [[33.4, 339.5], [33.4, 341]], concrete, 48)
      batch.lathe(x, z, [[33.6, 346.5], [33.6, 347.4]], concrete, 48)
      batch.lathe(x, z, [[32.2, 351], [32.2, 352.5]], concrete, 48)
      batch.lathe(x, z, [[9, 361], [7.5, 440]], concrete, 16)
      glazing.lathe(x, z, [[7.5, 440], [11.5, 444], [12, 451], [8.5, 456], [6.5, 457]], glass, 32)
      batch.lathe(x, z, [[12.4, 450], [12.4, 451.2]], concrete, 32)
      batch.lathe(x, z, [[6.5, 456], [4, 470], [2.6, 510], [1.2, 553]], concrete, 12)
      for (let y = 477; y < 542; y += 14) {
        const r = y < 510 ? 4 - (y - 470) * 0.035 : 2.6 - (y - 510) * (1.4 / 43)
        batch.lathe(x, z, [[r + 0.12, y], [r - 0.1, y + 6]], [0.65, 0.27, 0.22], 12)
      }
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
      domeRibs(batch, (x0 + x1) / 2, (z0 + z1) / 2, rx, rz, Y.building + wallH - 2, Math.max(20, l.h - wallH))
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

function domeRibs(batch: Batch, x: number, z: number, rx: number, rz: number, y0: number, h: number): void {
  if (rx <= 1 || rz <= 1) return
  for (let k = -4; k <= 4; k++) {
    const offset = (k / 5) * rx
    const span = rz * Math.sqrt(1 - (offset / rx) ** 2) * 0.98
    const base = batch.vertexCount
    for (let i = 0; i <= 24; i++) {
      const dz = -span + (i / 24) * span * 2
      for (const dx of [offset - 0.65, offset + 0.65]) {
        const height = y0 + h * Math.sqrt(Math.max(0, 1 - (dx / rx) ** 2 - (dz / rz) ** 2)) + 0.4
        batch.vertex(x + dx, height, z + dz, 0, 1, 0, [0.69, 0.73, 0.74])
      }
    }
    for (let i = 0; i < 24; i++) {
      const a = base + i * 2
      batch.indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
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
