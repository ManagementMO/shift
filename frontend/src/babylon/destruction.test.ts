import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'

import { buildCity, HIDDEN_Y, Y } from './city'
import { WorldFrame } from './coords'
import { crushFactor, DISPLAY_SCALE, dustPose, fragmentPose, nearestOnPath, planDamage, sliceCount, slicePose, stormCenter, swayAngles, type StormPath } from './destruction'
import { hazardPath, StormSystem } from './tornado'
import type { HazardTrack } from '../types'
import type { WorldData } from './worldData'

const crs = { proj: '', utm_zone: 10, net_offset: [0, 0] as [number, number], origin_net: [0, 0] as [number, number], origin_lonlat: [-123, 49] as [number, number], bounds_world: [4000, 7000, 4400, 7400] as [number, number, number, number] }

const fixture = (): WorldData => ({
  version: 1, pack_id: 'fixture', network_fingerprint: 'fixture', crs,
  anchors: [], venue: { x: 4200, z: 7200, edge: 'road' }, stops: [], zones: [], landmarks: [{ id: 'dome', kind: 'rogers_centre', name: 'Dome', x: 4210, z: 7010, h: 40, ring: [4200, 7000, 4220, 7000, 4220, 7020, 4200, 7020] }],
  buildings: [
    { id: 'office', cat: 'office', h: 80, ring: [4090, 7190, 4110, 7190, 4110, 7210, 4090, 7210] }, // on the path
    { id: 'house', cat: 'residential', h: 9, ring: [4140, 7140, 4150, 7140, 4150, 7150, 4140, 7150] }, // near the path
    { id: 'far', cat: 'retail', h: 12, ring: [4380, 7380, 4395, 7380, 4395, 7395, 4380, 7395] }, // out of reach
    { id: 'shed', cat: 'utility', h: 2, ring: [4200, 7205, 4204, 7205, 4204, 7209, 4200, 7209] }, // too small to matter
    { id: 'dome', cat: 'landmark', h: 40, ring: [4200, 7000, 4220, 7000, 4220, 7020, 4200, 7020] },
    { id: 'tower:a', source_id: 'tower', source_height: 60, cat: 'tower', base: 0, h: 30, roofs: [], ring: [4250, 7190, 4270, 7190, 4270, 7210, 4250, 7210] },
    { id: 'tower:b', source_id: 'tower', source_height: 60, cat: 'tower', base: 30, h: 30, roofs: [{ ring: [4250, 7190, 4270, 7190, 4270, 7210, 4250, 7210] }], ring: [4250, 7190, 4270, 7190, 4270, 7210, 4250, 7210] },
  ],
  roads: [], junctions: [], green: [], sand: [], rail: [], water: [], counts: {}, provenance: [],
})

const path: StormPath = { points: [[4000, 7200], [4400, 7200]], radius: 60, start: 100, end: 500 }

describe('storm path geometry', () => {
  it('moves the centre along the path with equal time per segment and reports direction', () => {
    expect(stormCenter(path, 99)).toBeNull()
    expect(stormCenter(path, 501)).toBeNull()
    const mid = stormCenter(path, 300)!
    expect(mid.x).toBeCloseTo(4200)
    expect(mid.z).toBeCloseTo(7200)
    expect(mid.dir).toEqual([1, 0])
    const bent: StormPath = { ...path, points: [[0, 0], [100, 0], [100, 1000]] }
    expect(stormCenter(bent, 300)!.x).toBeCloseTo(100) // half the window covers the short first leg
    expect(stormCenter(bent, 300)!.z).toBeCloseTo(0)
  })

  it('keeps a valid direction for a stationary or repeated waypoint', () => {
    const stationary = { ...path, points: [[4100, 7200], [4100, 7200]] as [number, number][] }
    expect(stormCenter(stationary, 300)!.dir).toEqual([0, 1])
    expect(nearestOnPath(stationary, 4100, 7200).dir).toEqual([0, 1])
  })

  it('finds the closest approach and when it happens', () => {
    const near = nearestOnPath(path, 4100, 7250)
    expect(near.d).toBeCloseTo(50)
    expect(near.t).toBeCloseTo(200)
    expect(nearestOnPath(path, 4500, 7200).d).toBeCloseTo(100)
    expect(nearestOnPath(path, 4500, 7200).t).toBeCloseTo(500)
  })
})

describe('damage plan', () => {
  it('reaches the buildings in the path, fells the closest, and leaves landmarks and distant blocks alone', () => {
    const plan = planDamage(fixture(), path, { collapseChance: 1 })
    const keys = plan.map((d) => d.key)
    expect(keys).toContain('osm:office')
    expect(keys).toContain('osm:house')
    expect(keys).toContain('osm:tower')
    expect(keys).not.toContain('osm:far')
    expect(keys).not.toContain('osm:shed')
    expect(keys).not.toContain('osm:dome')
    const office = plan.find((d) => d.key === 'osm:office')!
    expect(office.collapse).toBe(true)
    expect(office.tCollapse).toBeGreaterThanOrEqual(path.start)
    expect(office.tCollapse).toBeLessThanOrEqual(path.end)
    expect(Math.abs(office.tCollapse - office.tClosest)).toBeLessThan(DISPLAY_SCALE)
    const tower = plan.find((d) => d.key === 'osm:tower')!
    expect(tower.tiers).toHaveLength(2)
    expect(tower.h).toBeCloseTo(60)
    expect(tower.base).toBeCloseTo(Y.building)
    expect(plan[0].dMin).toBeLessThanOrEqual(plan[plan.length - 1].dMin)
  })

  it('is deterministic and honours the collapse cap', () => {
    const a = planDamage(fixture(), path, { collapseChance: 1 })
    const b = planDamage(fixture(), path, { collapseChance: 1 })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    const capped = planDamage(fixture(), path, { collapseChance: 1, maxCollapse: 1 })
    expect(capped.filter((d) => d.collapse)).toHaveLength(1)
    expect(planDamage(fixture(), path, { collapseChance: 0 }).some((d) => d.collapse)).toBe(false)
  })
})

describe('choreography is a pure function of time', () => {
  const d = { key: 'osm:office', x: 4100, z: 7200, base: 0.3, h: 80, radius: 11, wall: [0.7, 0.7, 0.7] as [number, number, number], dir: [1, 0] as [number, number], seed: 0.3 }

  it('stands still before failure and rests in a crushed stack afterwards', () => {
    const K = sliceCount(d.h)
    expect(K).toBe(5)
    for (let k = 0; k < K; k++) {
      const start = slicePose(d, k, K, 0)
      expect(start.y).toBeCloseTo((k * d.h) / K)
      expect(start.tilt).toBe(0)
      expect(start.scaleY).toBe(1)
      const late = slicePose(d, k, K, 40)
      expect(late.settled).toBe(1)
      expect(late.scaleY).toBeCloseTo(crushFactor(d.h))
      expect(late.y).toBeCloseTo(((k * d.h) / K) * crushFactor(d.h))
      expect(crushFactor(10)).toBeCloseTo(0.32)
      expect(crushFactor(146)).toBeCloseTo(0.1) // a tower pancakes to about a tenth
      expect(crushFactor(60) * 60).toBeCloseTo(14)
      expect(late.tilt).toBeGreaterThan(0)
      expect(JSON.stringify(slicePose(d, k, K, 80))).toBe(JSON.stringify(late))
    }
  })

  it('throws rubble that lands and stays put, and dust that clears', () => {
    expect(fragmentPose(d, 3, 5, 0)).toBeNull()
    const flying = fragmentPose(d, 3, 5, 1.6)!
    expect(flying.y).toBeGreaterThan(Y.road)
    const rest = fragmentPose(d, 3, 5, 30)!
    expect(rest.landed).toBe(true)
    expect(rest.y).toBeCloseTo(Y.road + rest.size[1] / 2)
    expect(JSON.stringify(fragmentPose(d, 3, 5, 60))).toBe(JSON.stringify(rest))
    expect(dustPose(d, 2, 0)).toBeNull()
    expect(dustPose(d, 2, 2.5)).not.toBeNull()
    expect(dustPose(d, 2, 2.5)!.alpha).toBeGreaterThan(0)
    expect(dustPose(d, 2, 30)).toBeNull()
  })

  it('sways only within reach and leans toward the funnel', () => {
    expect(swayAngles(d, null, 60, 10).lean).toBe(0)
    const far = swayAngles(d, { x: 4400, z: 7200, dir: [1, 0], progress: 0.5 }, 60, 10)
    expect(far.lean).toBe(0)
    const close = swayAngles(d, { x: 4130, z: 7200, dir: [1, 0], progress: 0.5 }, 60, 10)
    expect(close.lean).toBeGreaterThan(0)
    expect(close.lean).toBeLessThan(0.1)
    expect(close.ux).toBeCloseTo(1)
  })
})

describe('folding a batched building away and back', () => {
  it('parks exactly that building below ground and restores the original vertices', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const city = buildCity(scene, fixture())
    const ranges = city.buildingRanges.get('osm:office')!
    expect(ranges.length).toBeGreaterThan(0)
    expect(city.buildingRanges.get('osm:tower')!.length).toBeGreaterThan(0)
    const before = ranges.map((r) => Float32Array.from(r.mesh.getVerticesData('position')!))
    city.setBuildingsHidden(['osm:office'], true)
    ranges.forEach((r, i) => {
      const pos = r.mesh.getVerticesData('position')!
      for (let v = r.start; v < r.end; v++) expect(pos[v * 3 + 1]).toBe(HIDDEN_Y)
      // other buildings sharing the chunk keep their heights
      for (let v = 0; v < pos.length / 3; v++) if (v < r.start || v >= r.end) expect(pos[v * 3 + 1]).toBe(before[i][v * 3 + 1])
    })
    city.setBuildingsHidden(['osm:office'], false)
    ranges.forEach((r, i) => expect(Array.from(r.mesh.getVerticesData('position')!)).toEqual(Array.from(before[i])))
    city.dispose()
    scene.dispose()
    engine.dispose()
  })
})

describe('storm system lifecycle', () => {
  it('builds a tornado per hazard, shows it only during its window, and puts the city back when it is gone', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const world = fixture()
    const frame = new WorldFrame(world.crs)
    const city = buildCity(scene, world)
    const office = city.buildingRanges.get('osm:office')![0]
    const original = Float32Array.from(office.mesh.getVerticesData('position')!)
    const [lon0, lat0] = frame.worldToLonLat(4000, 7200)
    const [lon1, lat1] = frame.worldToLonLat(4400, 7200)
    const hazard: HazardTrack = { track_id: 'storm-1', waypoints: [[lon0, lat0], [lon1, lat1]], radius_m: 60, start_s: 100, end_s: 500, modes: ['passenger'], label: 'test' }
    const p = hazardPath(frame, hazard)
    expect(p.points[0][0]).toBeCloseTo(4000, 0)
    expect(p.points[1][1]).toBeCloseTo(7200, 0)

    const storms = new StormSystem(scene, frame, world, city, null)
    storms.setHazards([hazard])
    expect(storms.count).toBe(1)
    const storm = storms.storm(hazard)!
    expect(storm.damage.plan.map((d) => d.key)).toContain('osm:office')
    expect(office.mesh.getVerticesData('position')![office.start * 3 + 1]).toBe(HIDDEN_Y)

    storms.update(50)
    expect(storm.visible).toBe(false)
    expect(storm.root.isEnabled()).toBe(false)
    expect(scene.getMeshByName('wall-cloud')!.isEnabled()).toBe(false)
    storms.update(300)
    expect(storm.visible).toBe(true)
    expect(storm.root.isEnabled()).toBe(true)
    expect(scene.getMeshByName('wall-cloud')!.isEnabled()).toBe(false)
    expect(scene.getMeshByName('tornado-smoke')!.isEnabled()).toBe(true)
    expect(scene.getMeshByName('tornado-smoke')!.getTotalVertices()).toBe(4)
    for (const name of ['funnel-1', 'funnel-2', 'funnel-3', 'skirt-0', 'skirt-1', 'funnel-shadow']) {
      expect(scene.getMeshByName(name)!.isEnabled()).toBe(false)
    }
    expect(storm.root.position.x).toBeGreaterThan(4150)
    expect(storm.root.position.x).toBeLessThan(4250)
    storms.update(600)
    expect(storm.visible).toBe(false)
    storms.update(300) // rewinding is just another time
    expect(storm.visible).toBe(true)

    const fallen = storm.damage.plan.find((d) => d.collapse)!
    expect(fallen).toBeDefined()
    const intact = scene.meshes.filter((m) => m.name.startsWith(`live-${fallen.key}-`) && !m.name.includes('-slab'))
    const slab = scene.getTransformNodeByName(`live-${fallen.key}-slab1`)!
    const slabMeshes = slab.getChildMeshes()
    storms.update(fallen.tCollapse + 100)
    expect(intact.every((m) => !m.isEnabled())).toBe(true)
    expect(slabMeshes.every((m) => m.isEnabled())).toBe(true)
    expect(slab.scaling.y).toBeLessThan(0.4)
    const collapsedPose = [...slab.position.asArray(), ...slab.scaling.asArray(), ...slab.rotationQuaternion!.asArray()]
    storms.update(0)
    expect(intact.every((m) => m.isEnabled())).toBe(true)
    expect(slabMeshes.every((m) => !m.isEnabled())).toBe(true)
    expect(scene.getMeshByName('rubble')!.isEnabled()).toBe(false)
    expect(scene.getMeshByName('collapse-dust')!.isEnabled()).toBe(false)
    storms.update(fallen.tCollapse + 100)
    expect([...slab.position.asArray(), ...slab.scaling.asArray(), ...slab.rotationQuaternion!.asArray()]).toEqual(collapsedPose)

    storms.setHazards([hazard]) // same track: nothing rebuilt
    expect(storms.storm(hazard)).toBe(storm)
    const overlapping = { ...hazard, track_id: 'storm-2', start_s: 120, end_s: 520 }
    storms.setHazards([hazard, overlapping])
    expect(storms.count).toBe(2)
    const plannedKeys = [hazard, overlapping].flatMap((h) => storms.storm(h)!.damage.plan.map((d) => d.key))
    expect(new Set(plannedKeys).size).toBe(plannedKeys.length)
    storms.setHazards([overlapping])
    expect(office.mesh.getVerticesData('position')![office.start * 3 + 1]).toBe(HIDDEN_Y)
    storms.setHazards([])
    expect(storms.count).toBe(0)
    expect(Array.from(office.mesh.getVerticesData('position')!)).toEqual(Array.from(original))
    storms.dispose()
    city.dispose()
    scene.dispose()
    engine.dispose()
  })
})
