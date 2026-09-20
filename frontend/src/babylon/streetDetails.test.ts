import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'

import { buildStreetDetails } from './streetDetails'
import type { WorldData } from './worldData'

const square = (x: number, z: number, r: number) => [x-r, z-r, x+r, z-r, x+r, z+r, x-r, z+r]
const fixture = (): WorldData => ({
  version: 1, pack_id: 'test', network_fingerprint: '',
  crs: { proj: '', utm_zone: 17, net_offset: [0, 0], origin_net: [0, 0], origin_lonlat: [0, 0], bounds_world: [-200, -200, 200, 200] },
  anchors: [], venue: { x: 0, z: 0, edge: 'road' }, zones: [], buildings: [], landmarks: [], green: [], sand: [], water: [], junctions: [], counts: {}, provenance: [],
  roads: [{ id: 'road', name: 'Main', shape: [0, -60, 0, 60], w: 8, kind: 'road', type: 'residential', allow: ['car', 'ped'], speed: 10, prio: 1, from: 'a', to: 'b', lanes: [
    { shape: [0, -60, 0, 60], w: 4, allow: ['car'] }, { shape: [12, -60, 12, 60], w: 4, allow: ['ped'] },
  ] }],
  rail: [[-30, -60, -30, 60]],
  stops: [{ id: 'stop', name: 'Main stop', edge: 'road', x: 0, z: 0 }],
  surfaces: { ground: [], grass: [], sand: [], rail: [], pavement: [], asphalt: [], meadow: [] },
})

describe('Street detail clearance', () => {
  it('does not put cosmetic props, curbs or rails inside an official building', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const world = fixture()
    world.massing = { version: 1, network_fingerprint: '', source: '', source_url: '', license: '', excluded_osm_ids: [], buildings: [
      { id: 'official', cat: 'office', x: 0, z: 0, h: 40, tiers: [{ ring: square(0, 0, 100), holes: [], y0: 0, y1: 40 }] },
    ] }
    const before = JSON.stringify(world)
    const meshes = buildStreetDetails(scene, world)
    expect(meshes).toHaveLength(0)
    expect(JSON.stringify(world)).toBe(before)
    scene.dispose()
    engine.dispose()
  })

  it('uses vehicle-lane widths instead of treating the sidewalk as a vehicle lane', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const world = fixture()
    world.roads[0].w = 28
    world.stops = []
    world.rail = []
    const meshes = buildStreetDetails(scene, world)
    expect(meshes.some(mesh => mesh.name.startsWith('street-trees-'))).toBe(true)
    scene.dispose()
    engine.dispose()
  })

  it('keeps stop shelters off the vehicle lane without changing the stop location', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const world = fixture()
    world.roads[0].name = undefined
    world.rail = []
    const meshes = buildStreetDetails(scene, world)
    expect(meshes.length).toBeGreaterThan(0)
    for (const mesh of meshes) {
      const vertices = mesh.getVerticesData('position')!
      for (let i = 0; i < vertices.length; i += 3) expect(Math.abs(vertices[i])).toBeGreaterThan(world.roads[0].lanes![0].w / 2)
    }
    expect(world.stops[0]).toMatchObject({ x: 0, z: 0 })
    scene.dispose()
    engine.dispose()
  })
})
