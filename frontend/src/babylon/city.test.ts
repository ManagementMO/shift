import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'

import { Ray } from '@babylonjs/core/Culling/ray'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'

import { buildCity, HIDDEN_Y, PALETTE, Y } from './city'
import { cityPose } from './camera'
import { Overlay, MARK } from './overlay'
import { RoadIndex } from './roadIndex'
import { WorldFrame } from './coords'
import { facadeFor } from './appearance'
import type { WorldData, WorldLandmark } from './worldData'
import { cityPose as mapCityPose } from '../world/camera'

const fixture = (): WorldData => ({
  version: 1, pack_id: 'new-city', network_fingerprint: 'fixture',
  crs: { proj: '', utm_zone: 10, net_offset: [0, 0], origin_net: [0, 0], origin_lonlat: [-123, 49], bounds_world: [4000, 7000, 4400, 7400] },
  anchors: [], venue: { x: 4200, z: 7200, edge: 'road' }, stops: [], zones: [], landmarks: [],
  buildings: [
    { id: 'office', cat: 'office', h: 80, ring: [4100, 7100, 4130, 7100, 4130, 7130, 4100, 7130] },
    { id: 'house', cat: 'residential', h: 9, ring: [4140, 7100, 4150, 7100, 4150, 7110, 4140, 7110] },
    { id: 'unmodeled-landmark', cat: 'landmark', h: 20, ring: [4160, 7100, 4180, 7100, 4180, 7120, 4160, 7120] },
  ],
  roads: [], junctions: [], green: [[4220, 7220, 4320, 7220, 4320, 7320, 4220, 7320]], sand: [], rail: [], water: [], counts: {}, provenance: [],
})

describe('New-city rendering without appearance configuration', () => {
  it('preserves building clearance and does not widen source road lanes', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const world = fixture()
    world.buildings = [{ id: 'raised', cat: 'office', base: 10, h: 20, ring: [4100, 7100, 4130, 7100, 4130, 7130, 4100, 7130] }]
    world.green = []
    world.roads = [{ id: 'r', shape: [4200, 7200, 4300, 7200], w: 4, kind: 'road', type: 'residential', allow: ['car'], prio: 1, speed: 10, from: 'a', to: 'b', lanes: [{ shape: [4200, 7200, 4300, 7200], w: 4, allow: ['car'] }] }]
    const city = buildCity(scene, world)
    const wall = city.chunks.find((m) => m.material?.name === `city-${facadeFor(world.buildings[0])}`)!
    const ys = wall.getVerticesData('position')!.filter((_, i) => i % 3 === 1)
    expect(Math.min(...ys)).toBeCloseTo(Y.building + 10)
    expect(Math.max(...ys)).toBeCloseTo(Y.building + 30)
    const road = city.chunks.find((m) => m.material?.name === 'city-asphalt')!
    const zs = road.getVerticesData('position')!.filter((_, i) => i % 3 === 2)
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(4)
    const overlay = new Overlay(scene, new RoadIndex(world), new WorldFrame(world.crs))
    overlay.set({ closed: ['r', 'r'], ghost: ['r'], focus: ['r'], ghostStops: [] })
    const mark = scene.getMeshByName('overlay')!
    // one focus ribbon (the ghost of the same edge is not drawn twice), then the closure's barricades and cones
    const colors = mark.getVerticesData('color')!
    colors.slice(0, 3).forEach((v, i) => expect(v).toBeCloseTo(MARK.focus[i]))
    expect(mark.getTotalVertices()).toBeGreaterThan(4)
    const orange = new Set<number>()
    for (let i = 0; i < colors.length; i += 4) if (Math.abs(colors[i] - MARK.closed[0]) < 0.02 && Math.abs(colors[i + 2] - MARK.closed[2]) < 0.02) orange.add(i / 4)
    expect(orange.size).toBeGreaterThan(0)
    // a closed edge listed twice is furnished once
    const once = mark.getTotalVertices()
    overlay.set({ closed: ['r'], ghost: ['r'], focus: ['r'], ghostStops: [] })
    expect(scene.getMeshByName('overlay')!.getTotalVertices()).toBe(once)
    overlay.dispose()
    city.dispose()
    scene.dispose()
    engine.dispose()
  })

  it('collapses exactly the demolished buildings and landmarks by their ids, and restores them', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const world = fixture()
    world.green = []
    world.landmarks = [{ id: 'w-tower', kind: 'cn_tower', name: 'CN Tower', x: 4300, z: 7300, h: 553, ring: [4290, 7290, 4310, 7290, 4310, 7310, 4290, 7310] }]
    const city = buildCity(scene, world)
    const buildings = city.chunks.filter((m) => m.name.startsWith('buildings-'))
    expect(buildings.length).toBeGreaterThan(0)
    const house = city.buildingRanges.get('osm:house')!
    const office = city.buildingRanges.get('osm:office')!
    expect(house.length).toBeGreaterThan(0)
    expect(office.length).toBeGreaterThan(0)
    const landmark = city.chunks.find((m) => m.metadata?.landmarkId === 'w-tower')!
    const before = buildings.map((m) => new Float32Array(m.getVerticesData('position')!))
    const heights = (ranges: typeof house) => ranges.flatMap((r) => { const p = r.mesh.getVerticesData('position')!; const out: number[] = []; for (let v = r.start; v < r.end; v++) out.push(p[v * 3 + 1]); return out })

    city.hideBuildings(['house', 'w-tower'])
    expect(city.isHidden('house')).toBe(true)
    expect(city.isHidden('office')).toBe(false)
    expect(landmark.isEnabled()).toBe(false)
    expect(heights(house).every((y) => y === HIDDEN_Y)).toBe(true) // the demolished house draws nothing
    expect(heights(office).some((y) => y > 0)).toBe(true) // its neighbour is untouched

    city.hideBuildings([]) // restoring puts every vertex back and re-enables the landmark
    buildings.forEach((mesh, i) => expect(Array.from(mesh.getVerticesData('position')!)).toEqual(Array.from(before[i])))
    expect(landmark.isEnabled()).toBe(true)
    expect(city.isHidden('house')).toBe(false)
    city.dispose()
    scene.dispose()
    engine.dispose()
  })

  it('keeps reconciled thin building bands exact and omits covered roofs and trim', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const world = fixture()
    world.green = []
    world.buildings = [{ id: 'tower:band', source_id: 'tower', source_height: 120, cat: 'tower', base: 13.2, h: 0.6, roofs: [], ring: [4100, 7100, 4130, 7100, 4130, 7130, 4100, 7130] }]
    const city = buildCity(scene, world)
    const walls = city.chunks.filter((m) => m.name.startsWith('buildings-'))
    expect(walls).toHaveLength(1)
    expect(walls[0].material?.name).toBe(`city-${facadeFor({ id: 'tower', cat: 'tower', h: 120 })}`)
    const ys = walls[0].getVerticesData('position')!.filter((_, i) => i % 3 === 1)
    expect(Math.min(...ys)).toBeCloseTo(Y.building + 13.2)
    expect(Math.max(...ys)).toBeCloseTo(Y.building + 13.8)
    city.dispose()
    scene.dispose()
    engine.dispose()
  })

  it('uses one shared height for partitioned terrain without drawing legacy overlapping layers', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const world = fixture()
    world.buildings = []
    world.surfaces = {
      ground: [{ ring: [4000, 7000, 4400, 7000, 4400, 7400, 4000, 7400], holes: [[4200, 7200, 4300, 7200, 4300, 7300, 4200, 7300]] }],
      grass: [{ ring: [4200, 7200, 4240, 7200, 4240, 7300, 4200, 7300] }],
      pavement: [{ ring: [4240, 7200, 4250, 7200, 4250, 7300, 4240, 7300] }],
      sand: [{ ring: [4250, 7200, 4300, 7200, 4300, 7300, 4250, 7300] }],
      asphalt: [], rail: [],
    }
    const city = buildCity(scene, world)
    const surfaces = [city.ground, ...city.chunks.filter((m) => m.name.startsWith('surface-'))]
    for (const x of [4100, 4220, 4245, 4270]) {
      const ray = new Ray(new Vector3(x, 100, 7243), new Vector3(0, -1, 0), 200)
      const hits = surfaces.map((m) => ray.intersectsMesh(m)).filter((h) => h.hit)
      expect(hits).toHaveLength(1)
      expect(hits[0].pickedPoint!.y).toBeCloseTo(Y.road)
    }
    const colors = city.ground.getVerticesData('color')!
    for (let i = 0; i < 3; i++) expect(colors[i]).toBeCloseTo(PALETTE.land[i])
    city.dispose()
    scene.dispose()
    engine.dispose()
  })

  it('continues meadow through unclassified city land while preserving explicitly paved surfaces', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const world = fixture()
    world.buildings = []
    world.surfaces = {
      ground: [{ ring: [4000, 7000, 4200, 7000, 4200, 7400, 4000, 7400] }], meadow: [],
      pavement: [{ ring: [4200, 7000, 4400, 7000, 4400, 7400, 4200, 7400] }],
      grass: [], asphalt: [], rail: [], sand: [],
    }
    const city = buildCity(scene, world)
    expect(city.ground.material?.name).toBe('city-grass')
    const colors = city.ground.getVerticesData('color')!
    for (let i = 0; i < 3; i++) expect(colors[i]).toBeCloseTo(PALETTE.meadow[i])
    expect(city.chunks.some((mesh) => mesh.material?.name === 'city-pavement')).toBe(true)
    city.dispose()
    scene.dispose()
    engine.dispose()
  })

  it('textures the entire base plate and preserves its land tint under bright lighting', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const city = buildCity(scene, fixture())
    const ground = city.ground
    const material = ground.material as PBRMaterial
    expect(material).toBeInstanceOf(PBRMaterial)
    expect(material.albedoTexture?.name).toBe('city-concrete-albedo')
    expect(ground.getVerticesData('uv')).toHaveLength(ground.getTotalVertices() * 2)
    const colors = ground.getVerticesData('color')!
    for (let i = 0; i < 3; i++) expect(colors[i]).toBeCloseTo(PALETTE.land[i])
    const brdf = material.environmentBRDFTexture
    city.dispose()
    expect(scene.textures).toEqual([brdf])
    scene.dispose()
    expect(scene.textures).toHaveLength(0)
    engine.dispose()
  })

  it.each([512, 1024])('preserves the requested %i px facade quality', (resolution) => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const city = buildCity(scene, fixture(), resolution)
    const facade = scene.getMaterialByName('city-masonry') as PBRMaterial
    expect(facade.albedoTexture?.getSize().width).toBe(resolution)
    expect((city.ground.material as PBRMaterial).albedoTexture?.getSize().width).toBe(512)
    city.dispose()
    scene.dispose()
    engine.dispose()
  })

  it('keeps water below the base plate with open lake cutouts, solid islands and shoreline walls', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const world = fixture()
    world.water = [{
      ring: [4300, 7000, 4400, 7000, 4400, 7100, 4300, 7100],
      holes: [[4340, 7040, 4360, 7040, 4360, 7060, 4340, 7060]],
    }]
    const city = buildCity(scene, world)
    expect(Y.water).toBeLessThan(Y.ground - 0.5)
    const down = (x: number, z: number) => new Ray(new Vector3(x, 100, z), new Vector3(0, -1, 0), 200)
    expect(down(4320, 7020).intersectsMesh(city.ground).hit).toBe(false)
    expect(down(4350, 7050).intersectsMesh(city.ground).hit).toBe(true)
    expect(down(4200, 7200).intersectsMesh(city.ground).hit).toBe(true)
    const water = city.chunks.find((m) => m.name === 'water')!
    const hit = down(4320, 7020).intersectsMesh(water)
    expect(hit.hit).toBe(true)
    expect(hit.pickedPoint!.y).toBeCloseTo(Y.water)
    expect(down(4350, 7050).intersectsMesh(water).hit).toBe(false)
    expect(city.chunks.some((m) => m.name === 'shoreline')).toBe(true)
    city.dispose()
    scene.dispose()
    engine.dispose()
  })

  it('automatically textures buildings, roofs and parks and leaves source geometry unchanged', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const world = fixture()
    const original = JSON.stringify(world)
    const city = buildCity(scene, world)
    const textured = city.chunks.filter((m) => m.name.startsWith('buildings-') || m.name.startsWith('surface-'))
    expect(textured.length).toBeGreaterThan(4)
    for (const mesh of textured) {
      expect(mesh.getVerticesData('uv')?.length).toBe(mesh.getTotalVertices() * 2)
      expect(mesh.material?.getActiveTextures().length).toBeGreaterThanOrEqual(1)
    }
    expect(textured.some((m) => m.material?.name === 'city-masonry')).toBe(true)
    expect(city.chunks.some((m) => m.name.startsWith('trees-') && m.thinInstanceCount > 0)).toBe(true)
    expect(JSON.stringify(world)).toBe(original)
    expect(cityPose(world).target).toEqual([4200, 7200])
    city.dispose()
    expect(scene.meshes).toHaveLength(0)
    expect(scene.textures.filter(t => t.name.startsWith('city-'))).toHaveLength(0)
    scene.dispose()
    expect(scene.textures).toHaveLength(0)
    engine.dispose()
  })
})

describe('Waterloo E7 district', () => {
  const e7: WorldLandmark = {
    id: 'w382735686', kind: 'engineering_7', name: 'Engineering 7 (E7)',
    x: 4250, z: 7150, h: 27,
    ring: [4230, 7130, 4270, 7130, 4270, 7170, 4230, 7170],
  }

  it('frames E7 instead of the network midpoint and retains a venue fallback', () => {
    const world = fixture()
    world.pack_id = 'waterloo_e7'
    world.landmarks = [e7]
    expect(cityPose(world).target).toEqual([e7.x, e7.z])
    expect(cityPose(world).radius).toBeLessThan(1500)
    world.landmarks = []
    expect(cityPose(world).target).toEqual([world.venue.x, world.venue.z])
    expect(mapCityPose('waterloo_e7', [-80.5395046, 43.4729528]).center).toEqual([-80.5395046, 43.4729528])
    expect(mapCityPose('waterloo_e7', [-80.5395046, 43.4729528]).zoom).toBeGreaterThan(15)
  })

  it('uses shared glass and concrete textures on campus landmarks without filling courtyards', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const world = fixture()
    world.pack_id = 'waterloo_e7'
    const davis: WorldLandmark = {
      id: 'r8765264', kind: 'davis_centre', name: 'Davis Centre', x: 4350, z: 7150, h: 13.8,
      ring: [4330, 7130, 4370, 7130, 4370, 7170, 4330, 7170],
      holes: [[4340, 7140, 4360, 7140, 4360, 7160, 4340, 7160]],
    }
    world.landmarks = [e7, davis]
    world.buildings.push(...world.landmarks.map((lm) => ({ ...lm, cat: 'landmark' as const, lm: lm.kind })))
    const original = JSON.stringify(world)
    const city = buildCity(scene, world)
    const e7Glass = city.chunks.find((m) => m.name === 'landmark-engineering_7-glass')!
    const davisGlass = city.chunks.find((m) => m.name === 'landmark-davis_centre-glass')!
    const e7Solid = city.chunks.find((m) => m.name === 'landmark-engineering_7-solid')!
    const davisSolid = city.chunks.find((m) => m.name === 'landmark-davis_centre-solid')!
    expect(e7Glass).toBeDefined()
    expect(e7Glass.material?.name).toBe('city-glass')
    expect(e7Glass.material).toBe(davisGlass.material)
    expect(e7Solid.material?.name).toBe('city-concrete')
    const down = (x: number, z: number) => new Ray(new Vector3(x, 100, z), new Vector3(0, -1, 0), 200)
    expect(down(e7.x, e7.z).intersectsMesh(e7Solid).hit).toBe(true)
    expect(down(davis.x, davis.z).intersectsMesh(davisSolid).hit).toBe(false)
    expect(down(davis.x, davis.z).intersectsMesh(davisGlass).hit).toBe(false)
    expect(JSON.stringify(world)).toBe(original)
    city.dispose()
    expect(scene.meshes).toHaveLength(0)
    expect(scene.textures.filter(t => t.name.startsWith('city-'))).toHaveLength(0)
    scene.dispose()
    expect(scene.textures).toHaveLength(0)
    engine.dispose()
  })
})
