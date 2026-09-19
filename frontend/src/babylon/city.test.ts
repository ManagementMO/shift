import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'

import { Ray } from '@babylonjs/core/Culling/ray'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'

import { buildCity, PALETTE, Y } from './city'
import { cityPose } from './camera'
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
