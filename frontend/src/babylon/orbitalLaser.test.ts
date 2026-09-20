import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { developmentPreset } from '../development'
import { fixturePack } from '../development.fixtures'
import { BuildingIndex } from './buildingIndex'
import { buildCity, HIDDEN_Y } from './city'
import { WorldFrame } from './coords'
import { LASER_DURATION, LASER_IMPACT_TIME, laserEnvelope, laserRadius, OrbitalLaserSystem, type OrbitalStrike } from './orbitalLaser'
import { LASER_EXPANSION_END } from './orbitalLaserModel'
import { Traffic, type LiveTrafficSource } from './traffic'
import { StormSystem } from './tornado'
import type { WorldData } from './worldData'

const fixture = (): WorldData => ({
  version: 1, pack_id: 'laser-test', network_fingerprint: 'laser-test',
  crs: { proj: '', utm_zone: 10, net_offset: [0, 0], origin_net: [0, 0], origin_lonlat: [-123, 49], bounds_world: [-1000, -1000, 1000, 1000] },
  anchors: [], venue: { x: 0, z: 0, edge: 'road' }, stops: [{ id: 'stop', name: 'Stop', x: 0, z: 0, edge: 'road' }], zones: [],
  landmarks: [{ id: 'dome', kind: 'rogers_centre', name: 'Dome', x: 50, z: 50, h: 40, ring: [40, 40, 60, 40, 60, 60, 40, 60] }],
  buildings: [
    { id: 'near', cat: 'office', h: 80, ring: [-10, -10, 10, -10, 10, 10, -10, 10] },
    { id: 'far', cat: 'retail', h: 12, ring: [400, 400, 420, 400, 420, 420, 400, 420] },
    { id: 'section-a', source_id: 'tower', source_height: 60, cat: 'tower', h: 30, roofs: [], ring: [90, -10, 110, -10, 110, 10, 90, 10] },
    { id: 'section-b', source_id: 'tower', source_height: 60, cat: 'tower', base: 30, h: 30, roofs: [{ ring: [90, -10, 110, -10, 110, 10, 90, 10] }], ring: [90, -10, 110, -10, 110, 10, 90, 10] },
  ],
  roads: [], junctions: [], green: [], sand: [], rail: [], water: [], counts: {}, provenance: [],
})
const strike: OrbitalStrike = { id: 'laser-1', x: 0, z: 0, radius: 100, firedAt: 10 }
const view = { x: 0, y: 100, z: 0, radius: 300 }

it('bounds and snaps the selectable radius, including non-finite input', () => {
  expect(laserRadius(1)).toBe(25)
  expect(laserRadius(4000)).toBe(1000)
  expect(laserRadius(138)).toBe(150)
  expect(laserRadius(NaN)).toBe(150)
})

it('doubles every phase to a 2.4-second sequence rather than only extending the fade', () => {
  expect(LASER_DURATION).toBe(2.4)
  expect(LASER_IMPACT_TIME).toBe(0.4)
  expect(LASER_EXPANSION_END).toBe(1.64)
  expect(laserEnvelope(0.2).bottom).toBeCloseTo(0.5)
  expect(laserEnvelope(0.14).intensity).toBeCloseTo(0.5)
  expect(laserEnvelope(0.56).width).toBeLessThanOrEqual(0.06)
  expect(laserEnvelope(1.18).width).toBeCloseTo(0.52)
  expect(laserEnvelope(1.2).intensity).toBe(1)
  expect(laserEnvelope(2.02).intensity).toBeCloseTo(0.5)
  expect(laserEnvelope(2.4).intensity).toBe(0)
})

it('descends from the sky, holds a luminous column, and fades smoothly in real-time seconds', () => {
  expect(laserEnvelope(-1).intensity).toBe(0)
  expect(laserEnvelope(0).bottom).toBe(1)
  expect(laserEnvelope(0.08).bottom).toBeGreaterThan(0)
  expect(laserEnvelope(0.08).bottom).toBeLessThan(1)
  expect(laserEnvelope(0.6).bottom).toBe(0)
  expect(laserEnvelope(0.5).intensity).toBeCloseTo(1)
  expect(laserEnvelope(LASER_DURATION - 0.08).intensity).toBeGreaterThan(0)
  expect(laserEnvelope(LASER_DURATION).intensity).toBe(0)
  expect(laserEnvelope(100).intensity).toBe(0)
  for (let t = 0.01; t < LASER_DURATION; t += 0.01) {
    expect(Math.abs(laserEnvelope(t).intensity - laserEnvelope(t - 0.01).intensity)).toBeLessThan(0.15)
  }
})

it('lands a thin central beam before expanding smoothly to the full radius', () => {
  const needle = laserEnvelope(0.1).width
  expect(needle).toBeLessThanOrEqual(0.06)
  expect(laserEnvelope(0.56).bottom).toBe(0)
  expect(laserEnvelope(0.56).width).toBe(needle)
  expect(laserEnvelope(1).width).toBeGreaterThan(needle)
  expect(laserEnvelope(1).width).toBeLessThan(0.5)
  expect(laserEnvelope(1.3).width).toBeGreaterThan(laserEnvelope(1).width)
  expect(laserEnvelope(1.64).width).toBe(1)
  for (let t = 0.01; t < LASER_DURATION; t += 0.01) {
    const width = laserEnvelope(t).width, previous = laserEnvelope(t - 0.01).width
    expect(width).toBeGreaterThanOrEqual(previous)
    expect(width - previous).toBeLessThan(0.04)
  }
})

it.each([25, 150, 1000])('keeps the initial shaft narrow at a %s m target radius', radius => {
  const width = laserEnvelope(0.56, radius).width
  expect(width * radius).toBeLessThanOrEqual(6)
  expect(width).toBeLessThanOrEqual(0.06)
  expect(laserEnvelope(LASER_EXPANSION_END, radius).width).toBe(1)
})

describe('orbital laser lifecycle', () => {
  let engine: NullEngine
  let scene: Scene
  let city: ReturnType<typeof buildCity>
  let buildings: BuildingIndex
  let traffic: Traffic
  let laser: OrbitalLaserSystem

  beforeEach(() => {
    engine = new NullEngine()
    scene = new Scene(engine)
    const world = fixture()
    const frame = new WorldFrame(world.crs)
    city = buildCity(scene, world)
    buildings = new BuildingIndex(world)
    traffic = new Traffic(scene, frame, null)
    laser = new OrbitalLaserSystem(scene, frame, city, buildings, traffic, vi.fn())
  })

  afterEach(() => {
    laser.dispose()
    traffic.dispose()
    city.dispose()
    scene.dispose()
    engine.dispose()
  })

  it('clears intersecting buildings, reconciled sections and landmarks only after impact', () => {
    const onComplete = vi.fn()
    laser.onComplete = onComplete
    const original = city.buildingRanges.get('osm:near')!.map(r => Float32Array.from(r.mesh.getVerticesData('position')!))
    laser.setStrikes([strike])
    laser.update(strike.firedAt + 0.1)
    expect(city.isHidden('near')).toBe(false)
    expect(laser.clearedAt(0, 0)).toBe(false)
    laser.update(strike.firedAt + LASER_IMPACT_TIME + 0.01)
    expect(city.isHidden('near')).toBe(true)
    expect(city.isHidden('tower')).toBe(false)
    expect(city.isHidden('dome')).toBe(false)
    laser.update(strike.firedAt + LASER_EXPANSION_END + 0.01)
    expect(city.isHidden('tower')).toBe(true)
    expect(city.isHidden('dome')).toBe(true)
    expect(city.isHidden('far')).toBe(false)
    expect(laser.clearedAt(0, 0)).toBe(true)
    expect(laser.clearedAt(101, 0)).toBe(false)
    expect(city.chunks.filter(m => m.metadata?.landmarkId === 'dome').every(m => !m.isEnabled())).toBe(true)
    laser.update(strike.firedAt + LASER_DURATION + 0.1)
    laser.update(strike.firedAt + 100)
    expect(onComplete).toHaveBeenCalledExactlyOnceWith(strike.id, { buildings: 3, entities: 0, developments: 0 })
    expect(scene.meshes.some(m => m.name.startsWith('orbital-beam-'))).toBe(false)
    expect(city.isHidden('near')).toBe(true)
    laser.setStrikes([])
    expect(laser.clearedAt(0, 0)).toBe(false)
    expect(city.isHidden('near')).toBe(false)
    city.buildingRanges.get('osm:near')!.forEach((r, i) => expect(r.mesh.getVerticesData('position')).toEqual(original[i]))
  })

  it('sweeps clearing outwards with the beam and keeps the early ground flash small', () => {
    laser.setStrikes([strike])
    laser.update(strike.firedAt + 0.56)
    const beam = scene.getMeshByName(`orbital-beam-${strike.id}-0`)!
    const flare = scene.getMeshByName(`orbital-flare-${strike.id}`)!
    const scar = scene.getMeshByName(`orbital-scar-${strike.id}`)!
    expect(beam.scaling.x).toBeLessThan(10)
    expect(flare.scaling.x).toBeLessThanOrEqual(0.06)
    expect(scar.scaling.x).toBeLessThanOrEqual(0.06)
    expect(city.isHidden('near')).toBe(true)
    expect(city.isHidden('dome')).toBe(false)
    expect(city.isHidden('tower')).toBe(false)
    expect(laser.clearedAt(30, 0)).toBe(false)
    laser.update(strike.firedAt + 1.18)
    expect(beam.scaling.x).toBeGreaterThan(40)
    expect(beam.scaling.x).toBeLessThan(80)
    expect(laser.clearedAt(30, 0)).toBe(true)
    expect(laser.clearedAt(80, 0)).toBe(false)
    expect(city.isHidden('dome')).toBe(false)
    laser.update(strike.firedAt + 1.4)
    expect(city.isHidden('dome')).toBe(true)
    expect(city.isHidden('tower')).toBe(false)
    laser.update(strike.firedAt + 1.66)
    expect(city.isHidden('tower')).toBe(true)
    expect(laser.clearedAt(99, 0)).toBe(true)
    expect(laser.clearedAt(101, 0)).toBe(false)
  })

  it('reaches snapshotted travelers and developments in radial order', () => {
    const frame = new WorldFrame(fixture().crs)
    const development = { development_id: 'edge-development', spec: { ...developmentPreset(fixturePack, 1800), position: frame.worldToLonLat(75, 0) }, access: [] }
    traffic.setLiveSource({
      entity: index => ({ id: index ? 'edge' : 'center', kind: 'person' }), releasedAt: () => 2,
      forEachAt: (_t, visit) => { visit(0, 0, 0, 0, 0, 1, 1, 0); visit(1, 80, 0, 0, 0, 1, 1, 0); return true },
    })
    traffic.update(0, view)
    laser.setStrikes([strike], [development])
    laser.update(strike.firedAt + 0.56)
    traffic.update(0, view)
    expect(traffic.poseOf('center')).toBeNull()
    expect(traffic.poseOf('edge')).not.toBeNull()
    expect(laser.isDevelopmentHidden(development.development_id)).toBe(false)
    laser.update(strike.firedAt + 1.18)
    traffic.update(0, view)
    expect(traffic.poseOf('edge')).not.toBeNull()
    expect(laser.isDevelopmentHidden(development.development_id)).toBe(false)
    laser.update(strike.firedAt + 1.4)
    traffic.update(0, view)
    expect(traffic.poseOf('edge')).toBeNull()
    expect(laser.isDevelopmentHidden(development.development_id)).toBe(true)
  })

  it('restores a partially expanded strike without finishing its destruction', () => {
    const onComplete = vi.fn()
    laser.onComplete = onComplete
    laser.setStrikes([strike])
    laser.update(strike.firedAt + 1.18)
    expect(city.isHidden('near')).toBe(true)
    expect(city.isHidden('tower')).toBe(false)
    laser.setStrikes([])
    laser.update(strike.firedAt + LASER_DURATION)
    expect(city.isHidden('near')).toBe(false)
    expect(laser.clearedAt(0, 0)).toBe(false)
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('does not resurrect buildings owned by another strike or a tornado', () => {
    const second = { ...strike, id: 'laser-2', x: 20 }
    laser.setStrikes([strike, second])
    laser.update(12)
    laser.setStrikes([second])
    expect(city.isHidden('near')).toBe(true)
    city.setBuildingsHidden(['osm:near'], true)
    laser.setStrikes([])
    const range = city.buildingRanges.get('osm:near')![0]
    expect(range.mesh.getVerticesData('position')![range.start * 3 + 1]).toBe(HIDDEN_Y)
    city.setBuildingsHidden(['osm:near'], false)
    expect(range.mesh.getVerticesData('position')![range.start * 3 + 1]).toBeGreaterThan(HIDDEN_Y)
  })

  it('snapshots travelers, keeps the struck ones gone as they move, and restores them without editing SUMO', () => {
    let x = 0
    const source: LiveTrafficSource = {
      entity: index => ({ id: index ? 'outside' : 'inside', kind: 'person' }), releasedAt: () => 2,
      forEachAt: (_t, visit) => { visit(0, x, 0, 0, 1, 1, 1, 0); visit(1, 500, 0, 0, 1, 1, 1, 0); return true },
    }
    traffic.setLiveSource(source)
    traffic.update(0, view)
    laser.setStrikes([strike])
    laser.update(12)
    traffic.update(0, view)
    expect(traffic.poseOf('inside')).toBeNull()
    expect(traffic.poseOf('outside')).not.toBeNull()
    x = 300
    traffic.update(1, view)
    expect(traffic.poseOf('inside')).toBeNull()
    expect(traffic.pick(300, 0, (px, _py, pz) => ({ x: px, y: pz }))).toBeNull()
    laser.setStrikes([])
    traffic.update(1, view)
    expect(traffic.poseOf('inside')?.x).toBe(300)
  })

  it('clears existing developments but allows later construction without changing saved specs', () => {
    const frame = new WorldFrame(fixture().crs)
    const spec = { ...developmentPreset(fixturePack, 1800), position: frame.worldToLonLat(0, 0) }
    const before = { development_id: 'before', spec, access: [] }
    const distant = { development_id: 'distant', spec: { ...spec, position: frame.worldToLonLat(500, 500) }, access: [] }
    const original = JSON.stringify([before, distant])
    laser.setStrikes([strike], [before, distant])
    laser.update(12)
    expect(laser.isDevelopmentHidden('before')).toBe(true)
    expect(laser.isDevelopmentHidden('distant')).toBe(false)
    laser.setStrikes([strike], [before, distant, { ...before, development_id: 'after' }])
    expect(laser.isDevelopmentHidden('after')).toBe(false)
    expect(JSON.stringify([before, distant])).toBe(original)
    laser.setStrikes([])
    expect(laser.isDevelopmentHidden('before')).toBe(false)
  })

  it('removes animated tornado copies too and restores each effect independently', () => {
    const world = fixture(), frame = new WorldFrame(world.crs)
    const storms = new StormSystem(scene, frame, world, city, null)
    storms.setHazards([{ track_id: 'storm', waypoints: [frame.worldToLonLat(0, 0)], radius_m: 100, start_s: 0, end_s: 300, power: 5, modes: [], label: 'Visual storm' }])
    storms.update(2)
    const animated = scene.getTransformNodeByName('live-osm:near')!
    expect(animated.isEnabled()).toBe(true)
    laser.setStrikes([strike])
    laser.update(12)
    storms.update(12)
    expect(animated.isEnabled()).toBe(false)
    laser.setStrikes([])
    storms.update(12)
    expect(animated.isEnabled()).toBe(true)
    laser.setStrikes([strike])
    laser.update(12)
    storms.setHazards([])
    expect(city.isHidden('near')).toBe(true)
    const range = city.buildingRanges.get('osm:near')![0]
    expect(range.mesh.getVerticesData('position')![range.start * 3 + 1]).toBe(HIDDEN_Y)
    storms.dispose()
  })

  it('ignores cancelled shots, preserves unrelated demolitions and cleans up all effect resources', () => {
    city.hideBuildings(['far'])
    const before = scene.meshes.length
    laser.setStrikes([strike])
    laser.update(10.1)
    laser.setStrikes([])
    expect(city.isHidden('near')).toBe(false)
    expect(city.isHidden('far')).toBe(true)
    expect(scene.meshes.length).toBe(before)
    expect(laser.clearedAt(0, 0)).toBe(false)
  })
})
