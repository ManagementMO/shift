import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'

import { Ray } from '@babylonjs/core/Culling/ray'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'

import { buildCity, PALETTE, Y } from './city'
import { cityPose } from './camera'
import type { WorldData } from './worldData'

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
    expect(ground.material?.getActiveTextures()).toHaveLength(1)
    expect(ground.getVerticesData('uv')).toHaveLength(ground.getTotalVertices() * 2)
    const colors = ground.getVerticesData('color')!
    for (let i = 0; i < 3; i++) expect(colors[i]).toBeCloseTo(PALETTE.land[i])
    city.dispose()
    expect(scene.textures).toHaveLength(0)
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
      expect(mesh.material?.getActiveTextures().length).toBe(1)
    }
    expect(textured.some((m) => m.material?.name === 'city-masonry')).toBe(true)
    expect(city.chunks.some((m) => m.name.startsWith('trees-') && m.thinInstanceCount > 0)).toBe(true)
    expect(JSON.stringify(world)).toBe(original)
    expect(cityPose(world).target).toEqual([4200, 7200])
    city.dispose()
    expect(scene.meshes).toHaveLength(0)
    expect(scene.textures).toHaveLength(0)
    scene.dispose()
    engine.dispose()
  })
})
