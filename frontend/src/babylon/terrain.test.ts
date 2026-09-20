import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { Ray } from '@babylonjs/core/Culling/ray'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'

import { Y } from './city'
import { CityMaterials } from './materials'
import { boxDistance, buildTerrain, countryTrees, farmland, farmParcels, horizonRoads, parcelKey, rollingNoise, terrainShape, terrainVertexData } from './terrain'
import type { WorldData, WorldRoad } from './worldData'

const segDist = ([x, z]: [number, number], [ax, az, bx, bz]: number[]): number => {
  const dx = bx - ax, dz = bz - az
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)))
  return Math.hypot(x - ax - t * dx, z - az - t * dz)
}

const world = (): WorldData => ({
  version: 1, pack_id: 'fixture', network_fingerprint: 'fixture',
  crs: { proj: '', utm_zone: 17, net_offset: [0, 0], origin_net: [0, 0], origin_lonlat: [-79, 43], bounds_world: [-1000, -1000, 1000, 1000] },
  anchors: [], venue: { x: 0, z: 0, edge: 'e' }, stops: [], zones: [], landmarks: [], buildings: [], junctions: [],
  roads: [
    { id: 'hwy', shape: [0, 0, 0, 990], w: 12, type: 'highway.motorway', kind: 'road', allow: ['car'], prio: 10, speed: 30, from: 'a', to: 'b' },
    { id: 'hwy-back', shape: [0, 990, 0, 0], w: 12, type: 'highway.motorway', kind: 'road', allow: ['car'], prio: 10, speed: 30, from: 'b', to: 'a' },
    { id: 'lane', shape: [200, 0, 200, 995], w: 4, type: 'highway.residential', kind: 'road', allow: ['car'], prio: 1, speed: 10, from: 'c', to: 'd' },
    { id: 'grazing', shape: [-900, 990, 900, 990], w: 12, type: 'highway.primary', kind: 'road', allow: ['car'], prio: 8, speed: 20, from: 'e', to: 'f' },
    { id: 'inner', shape: [0, -500, 0, 500], w: 12, type: 'highway.trunk', kind: 'road', allow: ['car'], prio: 9, speed: 25, from: 'g', to: 'h' },
  ],
  green: [], sand: [], rail: [], water: [], counts: {}, provenance: [],
  surfaces: { ground: [], grass: [], sand: [], pavement: [], asphalt: [], rail: [] },
  far_water: [{ ring: [-5000, -5000, 5000, -5000, 5000, -1000, -5000, -1000] }],
  far_bounds: [-5000, -5000, 5000, 5000],
})

describe('Placeholder countryside', () => {
  it('stays hidden under the compiled plate, rolls only beyond it and drops under the far lake', () => {
    const shape = terrainShape(world())
    expect(shape.plate).toEqual([-1600, -1600, 1600, 1600])
    expect(shape.height(0, 0)).toBeLessThan(Y.water - 1)
    expect(shape.height(1600, 0)).toBeCloseTo(shape.plateY)
    expect(shape.surface(1500, 0)).toBe(shape.plateY)
    const heights = Array.from({ length: 40 }, (_, i) => shape.height(1700 + i * 80, 300 + i * 70))
    expect(Math.max(...heights)).toBeGreaterThan(shape.plateY + 8)
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(shape.plateY - 0.26)
    expect(shape.inWater(0, -3000)).toBe(true)
    expect(shape.height(0, -3000)).toBeLessThan(Y.water - 2)
    expect(shape.surface(0, -3000)).toBeLessThan(Y.water - 2)
    // land flattens into a beach next to the water rather than forming a cliff
    expect(shape.height(3000, -960)).toBeLessThan(shape.plateY + 1)
    expect(boxDistance([0, 0, 10, 10], 5, 5)).toBe(-5)
    expect(boxDistance([0, 0, 10, 10], 13, 14)).toBe(5)
    expect(Math.abs(rollingNoise(123, 456, 2000))).toBeLessThanOrEqual(1)
    expect(rollingNoise(123, 456, 2000)).toBe(rollingNoise(123, 456, 2000))
  })

  it('continues only the major roads that leave the pack, once per carriageway pair', () => {
    const w = world()
    const roads = horizonRoads(w.roads as WorldRoad[], w.crs.bounds_world, w.far_bounds!)
    expect(roads).toHaveLength(1)
    expect(roads[0].shape).toEqual([0, 990, 0, 5000])
    expect(roads[0].width).toBe(12)
  })

  it('places trees on land away from water, roads and the plate, at terrain height', () => {
    const shape = terrainShape(world())
    const roads = horizonRoads(world().roads, [-1000, -1000, 1000, 1000], shape.farBounds)
    const trees = countryTrees(shape, roads, 400)
    expect(trees.length).toBeGreaterThan(50)
    for (const t of trees) {
      expect(shape.inWater(t.x, t.z)).toBe(false)
      expect(boxDistance(shape.pack, t.x, t.z)).toBeGreaterThanOrEqual(150)
      expect(t.y).toBeCloseTo(shape.surface(t.x, t.z))
      if (t.z > 990) expect(Math.abs(t.x)).toBeGreaterThan(12 + 30 - 1e-9)
    }
    // a few stand on the meadow ring at plate height, the rest out on the hills
    expect(trees.some((t) => boxDistance(shape.plate, t.x, t.z) < 0 && t.y === shape.plateY)).toBe(true)
    expect(trees.some((t) => boxDistance(shape.plate, t.x, t.z) > 0)).toBe(true)
  })

  it('lays farm parcels on the tilted concession lattice, off the pack, the lake and the horizon roads, with fields that follow the hills', () => {
    const shape = terrainShape(world())
    const roads = horizonRoads(world().roads, [-1000, -1000, 1000, 1000], shape.farBounds)
    const parcels = farmParcels(shape, roads)
    expect(parcels.length).toBeGreaterThan(40)
    for (const p of parcels) {
      expect(boxDistance(shape.plate, p.centre[0], p.centre[1])).toBeGreaterThan(250)
      expect(shape.inWater(p.centre[0], p.centre[1])).toBe(false)
      for (const r of roads) expect(segDist(p.centre, r.shape)).toBeGreaterThanOrEqual(r.width / 2 + Math.hypot(260, 420) / 2)
      // corners are positively wound and tilted 17° off the world axes
      const [a, b, , d] = p.corners
      expect((b[0] - a[0]) * (d[1] - a[1]) - (d[0] - a[0]) * (b[1] - a[1])).toBeGreaterThan(0)
      expect(Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0]) - 0.3)).toBeLessThan(1e-6)
      expect(parcelKey(p.centre[0], p.centre[1])).toBe(`${p.i}:${p.j}`)
    }
    expect(parcels.some((p) => p.tint)).toBe(true)
    expect(parcels.some((p) => !p.tint)).toBe(true)
    const farm = farmland(shape, roads, 300)
    expect(farm.fields.isEmpty()).toBe(false)
    expect(farm.lanes.isEmpty()).toBe(false)
    expect(farm.buildings.isEmpty()).toBe(false)
    expect(farm.trees.length).toBeGreaterThan(0)
    expect(farm.trees.length).toBeLessThanOrEqual(300)
    // every field and lane vertex sits just above the placeholder surface, and every field triangle faces up
    for (const batch of [farm.fields, farm.lanes]) {
      for (let i = 0; i < batch.positions.length; i += 3) {
        const s = shape.surface(batch.positions[i], batch.positions[i + 2])
        expect(batch.positions[i + 1]).toBeGreaterThan(s)
        expect(batch.positions[i + 1]).toBeLessThan(s + 0.5)
      }
    }
    const p = farm.fields.positions, idx = farm.fields.indices
    for (let i = 0; i < idx.length; i += 3) {
      const [a, b, c] = [idx[i], idx[i + 1], idx[i + 2]]
      expect((p[b * 3] - p[a * 3]) * (p[c * 3 + 2] - p[a * 3 + 2]) - (p[c * 3] - p[a * 3]) * (p[b * 3 + 2] - p[a * 3 + 2])).toBeGreaterThan(0)
    }
    for (let i = 0; i < farm.lanes.positions.length; i += 3) expect(shape.inWater(farm.lanes.positions[i], farm.lanes.positions[i + 2])).toBe(false)
  })

  it('meets the compiled meadow without a vertical step at the plate edge', () => {
    const shape = terrainShape(world())
    expect(Math.abs(shape.surface(1600.001, 0) - shape.surface(1599.999, 0))).toBeLessThan(0.001)
    expect(shape.height(1600, 0)).toBeCloseTo(shape.plateY)
  })

  it('continues a terminal arterial even when the network ends before its rectangular bounds', () => {
    const w = world()
    w.roads = w.roads.slice(0, 2).map((road, i) => ({ ...road, shape: i ? [0, 740, 0, 0] : [0, 0, 0, 740] }))
    const roads = horizonRoads(w.roads, w.crs.bounds_world, w.far_bounds!)
    expect(roads).toHaveLength(1)
    expect(roads[0].shape).toEqual([0, 740, 0, 5000])
  })

  it.each([24, 96])('keeps field and road triangles above the actual %i-cell terrain mesh, not just the noise function', (cells) => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const materials = new CityMaterials(scene, 512)
    const terrain = buildTerrain(scene, world(), materials, { cells, treeLimit: 0 })
    try {
      const land = terrain.meshes.find((m) => m.name === 'countryside')!
      for (const mesh of terrain.meshes.filter((m) => ['fields', 'lanes', 'horizon-roads'].includes(m.name))) {
        const positions = mesh.getVerticesData('position')!, indices = mesh.getIndices()!
        const stride = Math.max(3, Math.ceil(indices.length / 180 / 3) * 3)
        for (let i = 0; i < indices.length; i += stride) {
          const vertices = [indices[i], indices[i + 1], indices[i + 2]]
          const x = vertices.reduce((sum, v) => sum + positions[v * 3], 0) / 3
          const y = vertices.reduce((sum, v) => sum + positions[v * 3 + 1], 0) / 3
          const z = vertices.reduce((sum, v) => sum + positions[v * 3 + 2], 0) / 3
          if (boxDistance(terrain.shape.plate, x, z) <= 0 || terrain.shape.inWater(x, z)) continue
          const hit = new Ray(new Vector3(x, 500, z), new Vector3(0, -1, 0), 1000).intersectsMesh(land)
          expect(hit.hit, mesh.name).toBe(true)
          const clearance = y - hit.pickedPoint!.y
          expect(clearance, `${mesh.name} at ${x.toFixed(1)}, ${z.toFixed(1)}`).toBeGreaterThan(0.01)
          expect(clearance, mesh.name).toBeLessThan(0.51)
        }
      }
    } finally {
      terrain.dispose()
      materials.dispose()
      scene.dispose()
      engine.dispose()
    }
  })

  it('builds a heightfield the camera ray hits at the placeholder height, and the plate edge is pinned to the grid', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const w = world()
    const shape = terrainShape(w, { cells: 20 })
    const vd = terrainVertexData(shape)
    const xs = new Set<number>()
    for (let i = 0; i < vd.positions!.length; i += 3) xs.add(vd.positions![i])
    expect(xs.has(1600)).toBe(true)
    expect(xs.has(-1600)).toBe(true)
    // every triangle faces up (positive shoelace in x/z), or back-face culling hides the whole countryside
    const p = vd.positions!, idx = vd.indices!
    for (let i = 0; i < idx.length; i += 3) {
      const [a, b, c] = [idx[i], idx[i + 1], idx[i + 2]]
      const area = (p[b * 3] - p[a * 3]) * (p[c * 3 + 2] - p[a * 3 + 2]) - (p[c * 3] - p[a * 3]) * (p[b * 3 + 2] - p[a * 3 + 2])
      expect(area).toBeGreaterThan(0)
    }
    const terrain = buildTerrain(scene, w, new CityMaterials(scene, 512), { cells: 20, treeLimit: 40 })
    const land = terrain.meshes.find((m) => m.name === 'countryside')!
    const hit = new Ray(new Vector3(2600, 500, 2600), new Vector3(0, -1, 0), 1000).intersectsMesh(land)
    expect(hit.hit).toBe(true)
    expect(hit.pickedPoint!.y).toBeGreaterThan(shape.plateY - 0.3)
    expect(terrain.meshes.some((m) => m.name === 'far-water')).toBe(true)
    expect(terrain.meshes.some((m) => m.name === 'horizon-roads')).toBe(true)
    expect(terrain.meshes.filter((m) => m.name.startsWith('country-trees-')).length).toBeGreaterThan(0)
    terrain.dispose()
    expect(scene.meshes.filter((m) => m.name === 'countryside')).toHaveLength(0)
    scene.dispose()
    engine.dispose()
  })
})
