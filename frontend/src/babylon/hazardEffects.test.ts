import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import { Scene } from '@babylonjs/core/scene'
import { WorldFrame, utmForward } from './coords'
import { guideTrack, HazardEffects, sampleHazardPoints } from './hazardEffects'
import type { HazardTrack } from '../types'

const base: HazardTrack = {
  track_id: 'zone', waypoints: [[-79.39, 43.64]], radius_m: 100, start_s: 100, end_s: 300,
  modes: ['passenger', 'bus'], kind: 'flood', label: 'Flood exclusion',
  footprint: [[[-79.3912, 43.6391], [-79.3888, 43.6391], [-79.3888, 43.6409], [-79.3912, 43.6409], [-79.3912, 43.6391]]],
}
const rings = base.footprint.map((ring) => ring.flatMap(([lon, lat]) => [(lon + 79.39) * 81000, (lat - 43.64) * 111000]))

describe('Hazard footprint sampling', () => {
  it('produces deterministic, in-polygon points scaled to the footprint area', () => {
    const first = sampleHazardPoints(rings, 'zone', 40)
    const second = sampleHazardPoints(rings, 'zone', 40)
    expect(first).toEqual(second)
    expect(first.length).toBeGreaterThan(8)
    expect(first.length).toBeLessThanOrEqual(40)
    for (const [x, z] of first) {
      expect(Math.abs(x)).toBeLessThanOrEqual(98)
      expect(Math.abs(z)).toBeLessThanOrEqual(100)
    }
    expect(sampleHazardPoints(rings, 'other', 40)).not.toEqual(first)
  })

  it('excludes holes and rejects degenerate geometry', () => {
    const hole = [-30, -30, 30, -30, 30, 30, -30, 30]
    for (const [x, z] of sampleHazardPoints([rings[0], hole], 'zone', 60)) expect(Math.max(Math.abs(x), Math.abs(z))).toBeGreaterThan(30)
    expect(sampleHazardPoints([[0, 0, 1, 1]], 'zone', 10)).toEqual([])
    expect(sampleHazardPoints([[0, 0, NaN, 1, 1, 1]], 'zone', 10)).toEqual([])
  })
})

describe('Babylon hazard effects', () => {
  let engine: NullEngine
  let scene: Scene
  let effects: HazardEffects

  beforeEach(() => {
    engine = new NullEngine()
    scene = new Scene(engine)
    const frame = new WorldFrame({
      utm_zone: 17, net_offset: [0, 0], origin_net: utmForward(-79.39, 43.64, 17),
      origin_lonlat: [-79.39, 43.64], bounds_world: [-1000, -1000, 1000, 1000],
    })
    effects = new HazardEffects(scene, frame)
  })

  afterEach(() => {
    effects.dispose()
    scene.dispose()
    engine.dispose()
  })

  const names = () => scene.meshes.map((m) => m.name).sort()
  const instances = (name: string) => (scene.getMeshByName(name) as Mesh).thinInstanceCount

  it('spreads fire with the simulation clock, rewinds deterministically, and disposes everything at expiry', () => {
    const fireTrack: HazardTrack = { ...base, kind: 'fire' }
    const original = JSON.stringify(fireTrack)
    effects.set([fireTrack], 100)
    expect(names()).toEqual(['hazard-fire-core-zone', 'hazard-fire-ember-zone', 'hazard-fire-flame-zone', 'hazard-fire-glow-zone', 'hazard-fire-scorch-zone', 'hazard-fire-smoke-zone'])
    const scorch = scene.getMeshByName('hazard-fire-scorch-zone')!
    expect(scorch.getVerticesData('position')?.every(Number.isFinite)).toBe(true)
    expect(scorch.isPickable).toBe(false)
    const fire = effects.fireFor('zone')!
    const flames = effects.spriteFor('hazard-fire-flame-zone')!
    const lit = () => flames.points.filter((_, i) => flames.colors[i * 4 + 3] > 0.01).length
    const start = fire.front.front
    const initial = lit()
    // Spread starts at waypoint 0 and stays bounded by the authoritative footprint, even while rewinding.
    expect(start).toBeGreaterThan(0)
    expect(start).toBeLessThan(fire.reach * 0.3)
    expect(initial).toBeGreaterThan(0)
    expect(initial).toBeLessThan(flames.points.length)
    const plugin = (scorch.material as StandardMaterial).pluginManager!.getPlugin('SpreadFront')!
    const defines: Record<string, { type: string; default: unknown }> = {}
    plugin.collectDefines(defines)
    expect(defines.HAZARD_SPREAD_FRONT.default).toBe(true)
    effects.set([fireTrack], 160)
    expect(effects.fireFor('zone')!.front.front).toBeGreaterThan(start)
    expect(lit()).toBeGreaterThan(initial)
    expect(scene.getMeshByName('hazard-fire-scorch-zone')).toBe(scorch)
    effects.set([fireTrack], 220)
    expect(fire.front.front).toBeCloseTo(fire.reach + fire.front.band, 5)
    expect(lit()).toBe(flames.points.length)
    effects.set([fireTrack], 100)
    expect(fire.front.front).toBe(start)
    expect(lit()).toBe(initial)
    expect(JSON.stringify(fireTrack)).toBe(original)
    const meshes = [...scene.meshes]
    effects.set([fireTrack], 300)
    expect(scene.meshes).toHaveLength(0)
    expect(scene.materials.filter((m) => m.name !== 'default material')).toHaveLength(0)
    expect(meshes.every((m) => m.isDisposed())).toBe(true)
    effects.set([fireTrack], 99)
    expect(scene.meshes).toHaveLength(0)
  })

  it('keeps flickering while paused without advancing the spread, and handles timing changes', () => {
    const fire: HazardTrack = { ...base, kind: 'fire' }
    effects.set([fire], 150)
    const front = effects.fireFor('zone')!.front.front
    const flames = effects.spriteFor('hazard-fire-flame-zone')!
    const before = Array.from(flames.matrices)
    effects.animate(2)
    expect(effects.fireFor('zone')!.front.front).toBe(front)
    expect(Array.from(flames.matrices)).not.toEqual(before)
    effects.set([{ ...fire, start_s: 150, end_s: 750 }], 150)
    expect(effects.fireFor('zone')!.front.front).toBeLessThan(front)
    effects.set([], 150)
    expect(scene.meshes).toHaveLength(0)
    expect(scene.materials.filter((m) => m.name !== 'default material')).toHaveLength(0)
  })

  it('still renders saved flood records without reinterpreting them as fire', () => {
    effects.set([{ ...base, kind: 'flood' }], 150)
    expect(names()).toEqual(['hazard-flood-water-zone'])
    effects.set([], 150)
    expect(scene.meshes).toHaveLength(0)
  })

  it('renders rain as a white opaque cloud with falling drops, splashes and a wet sheen', () => {
    effects.set([{ ...base, kind: 'rain', label: 'Rain' }], 150)
    expect(names()).toEqual(['hazard-rain-cloud-zone', 'hazard-rain-rain-zone', 'hazard-rain-shadow-zone', 'hazard-rain-splash-zone'])
    const cloud = scene.getMeshByName('hazard-rain-cloud-zone')!
    const puffs = effects.cloudFor('zone')!
    // White, not the storm's slate grey, with layered density and soft edges.
    expect(Math.min(...puffs[0].color)).toBeGreaterThan(0.8)
    expect(cloud.material!.needAlphaBlending()).toBe(true)
    const y0 = puffs[0].y
    effects.animate(2)
    expect(effects.cloudFor('zone')![0].y).not.toBe(y0)
    expect(instances('hazard-rain-rain-zone')).toBeGreaterThan(8)
    expect(instances('hazard-rain-rain-zone')).toBeLessThan(600)
    expect(instances('hazard-rain-splash-zone')).toBe(instances('hazard-rain-rain-zone'))
    const drops = effects.spriteFor('hazard-rain-rain-zone')!
    expect(drops.colors.some((_, i) => i % 4 === 3 && drops.colors[i] > 0)).toBe(true)
  })

  it('renders a storm as a cloud, heavier rain, splashes and lightning that flashes on a schedule', () => {
    effects.set([{ ...base, kind: 'storm', label: 'Storm' }], 150)
    const all = names()
    expect(all).toContain('hazard-storm-cloud-zone')
    expect(all).toContain('hazard-storm-rain-zone')
    expect(all).toContain('hazard-storm-splash-zone')
    expect(all.filter((n) => n.startsWith('hazard-storm-bolt-zone-')).length).toBeGreaterThanOrEqual(2)
    expect(instances('hazard-storm-rain-zone')).toBeGreaterThan(20)
    const bolts = scene.meshes.filter((m) => m.name.startsWith('hazard-storm-bolt-zone-'))
    let lit = 0
    for (let i = 0; i < 400; i++) {
      effects.animate(0.05)
      if (bolts.some((m) => m.isEnabled())) lit++
    }
    expect(lit).toBeGreaterThan(0)
    expect(lit).toBeLessThan(200)
    for (const b of bolts) expect(b.getVerticesData('position')?.every(Number.isFinite)).toBe(true)
  })

  it.each(['rain', 'storm'] as const)('builds %s entirely from soft particles and a feathered shadow', (kind) => {
    const track = { ...base, kind }
    const original = JSON.stringify(track)
    effects.set([track], 150)
    const cloud = scene.getMeshByName(`hazard-${kind}-cloud-zone`)!
    const shadow = scene.getMeshByName(`hazard-${kind}-shadow-zone`)!
    expect(cloud.getTotalVertices()).toBe(4)
    expect(shadow.getTotalVertices()).toBe(4)
    expect(instances(cloud.name)).toBeGreaterThan(40)
    expect(instances(cloud.name)).toBeLessThanOrEqual(360)
    expect(cloud.material!.needAlphaBlending()).toBe(true)
    expect(cloud.material!.disableDepthWrite).toBe(true)
    expect(cloud.isPickable).toBe(false)
    expect(scene.getMeshByName(`hazard-${kind}-sheen-zone`)).toBeNull()
    expect(effects.cloudFor('zone')!.every((p) => [p.x, p.y, p.z, p.alpha, p.width].every(Number.isFinite))).toBe(true)
    effects.set([track], 200)
    expect(scene.getMeshByName(cloud.name)).toBe(cloud)
    expect(JSON.stringify(track)).toBe(original)
    effects.set([], 200)
    expect(cloud.isDisposed()).toBe(true)
    expect(shadow.isDisposed()).toBe(true)
    expect(scene.materials.filter((m) => m.name !== 'default material')).toHaveLength(0)
    expect(scene.textures).toHaveLength(0)
  })

  it('animates rain within the footprint without changing which events are drawn', () => {
    effects.set([{ ...base, kind: 'storm' }], 150)
    const rain = effects.spriteFor('hazard-storm-rain-zone')!
    const before = Array.from(rain.matrices.slice(0, 16))
    const drawn = names()
    effects.animate(0.5)
    const after = Array.from(rain.matrices.slice(0, 16))
    expect(after).not.toEqual(before)
    // Drops fall vertically onto their sampled point, which stays inside the footprint.
    const [x, z] = rain.points[0]
    expect(rain.wind).toEqual([0, 0])
    expect(after[12]).toBe(before[12])
    expect(after[14]).toBe(before[14])
    expect(after[12]).toBeCloseTo(x, 4)
    expect(after[14]).toBeCloseTo(z, 4)
    for (let i = 0; i < 40; i++) {
      effects.animate(0.05)
      const y = rain.matrices[13]
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(rain.height + 1)
    }
    expect(names()).toEqual(drawn)
  })

  it('draws previews in a muted style and replaces effects when hazards change or are removed', () => {
    effects.set([base], 150, base.track_id)
    const preview = scene.getMeshByName('hazard-flood-water-zone')!
    expect(preview.visibility).toBeLessThan(1)
    effects.set([{ ...base, kind: 'rain' }], 150)
    expect(names()).toEqual(['hazard-rain-cloud-zone', 'hazard-rain-rain-zone', 'hazard-rain-shadow-zone', 'hazard-rain-splash-zone'])
    effects.set([], 150)
    expect(scene.meshes).toHaveLength(0)
    expect(scene.materials.filter((m) => m.name !== 'default material')).toHaveLength(0)
  })

  it('starts fire previews small and spreads without restarting on each brush update', () => {
    const track: HazardTrack = { ...base, kind: 'fire', track_id: 'weather-guide' }
    effects.set([track], 0, 'weather-guide')
    const guide = effects.fireFor('weather-guide')!
    const initial = guide.front.front
    expect(initial).toBeLessThan(guide.reach * 0.3)
    effects.animate(10)
    expect(guide.front.front).toBeGreaterThan(initial)
    const meshes = [...scene.meshes]
    effects.set([track], 0, 'weather-guide')
    expect(scene.meshes).toEqual(meshes)
    effects.set([], 0)
    expect(scene.meshes).toHaveLength(0)
  })

  it('ignites along the whole painted stroke and preserves the stroke in its guide', () => {
    const frame = new WorldFrame({ utm_zone: 17, net_offset: [0, 0], origin_net: utmForward(-79.39, 43.64, 17), origin_lonlat: [-79.39, 43.64], bounds_world: [-1000, -1000, 1000, 1000] })
    const path = [frame.worldToLonLat(-75, 0), frame.worldToLonLat(75, 0)]
    const track = guideTrack({ ...base, kind: 'fire', radius_m: 30, waypoints: path }, frame)!
    expect(track.waypoints).toEqual(path)
    effects.set([track], 100, track.track_id)
    const fire = effects.fireFor(track.track_id)!
    expect(fire.front.path).toHaveLength(2)
    const flames = effects.spriteFor(`hazard-fire-flame-${track.track_id}`)!
    expect(flames.points.some((p, i) => p[0] < -60 && flames.colors[i * 4 + 3] > 0.1)).toBe(true)
    expect(flames.points.some((p, i) => p[0] > 60 && flames.colors[i * 4 + 3] > 0.1)).toBe(true)
    expect(fire.reach).toBe(30)
  })

  it.each(['rain', 'fire', 'storm'] as const)('limits %s instance counts for very large footprints', (kind) => {
    const huge = { ...base, radius_m: 5000, footprint: [[[-79.45, 43.6], [-79.33, 43.6], [-79.33, 43.68], [-79.45, 43.68], [-79.45, 43.6]]] as [number, number][][] }
    effects.set([{ ...huge, kind }], 150)
    expect(instances(`hazard-${kind}-${kind === 'fire' ? 'flame' : 'rain'}-zone`)).toBeLessThanOrEqual(600)
    if (kind === 'fire') {
      expect(instances('hazard-fire-smoke-zone')).toBeLessThanOrEqual(80)
      expect(instances('hazard-fire-ember-zone')).toBeLessThanOrEqual(300)
    }
  })

  it('keeps ignition samples out of polygon holes and ignores invalid footprints', () => {
    const hole: [number, number][] = [[-79.3904, 43.6397], [-79.3896, 43.6397], [-79.3896, 43.6403], [-79.3904, 43.6403]]
    const frame = new WorldFrame({ utm_zone: 17, net_offset: [0, 0], origin_net: utmForward(-79.39, 43.64, 17), origin_lonlat: [-79.39, 43.64], bounds_world: [-1000, -1000, 1000, 1000] })
    effects.set([{ ...base, kind: 'fire', footprint: [...base.footprint, hole] }], 220)
    const flames = effects.spriteFor('hazard-fire-flame-zone')!
    for (const [x, z] of flames.points) {
      const [lon, lat] = frame.worldToLonLat(x, z)
      expect(lon < -79.3904 || lon > -79.3896 || lat < 43.6397 || lat > 43.6403).toBe(true)
    }
    effects.set([{ ...base, kind: 'fire', footprint: [[[NaN, 0], [0, 1], [1, 0]]] }], 150)
    expect(scene.meshes).toHaveLength(0)
    expect(scene.materials.filter((m) => m.name !== 'default material')).toHaveLength(0)
  })
})

describe('Drag guide', () => {
  it('builds a memoised local circle for the draft and refreshes it when the draft changes', () => {
    const frame = new WorldFrame({
      utm_zone: 17, net_offset: [0, 0], origin_net: utmForward(-79.39, 43.64, 17),
      origin_lonlat: [-79.39, 43.64], bounds_world: [-1000, -1000, 1000, 1000],
    })
    const draft = { waypoints: [[-79.39, 43.64]] as [number, number][], radius_m: 120, start_s: 0, end_s: 600, modes: ['passenger', 'bus'] as ('passenger' | 'bus')[], kind: 'rain' as const, label: 'Rain' }
    const a = guideTrack(draft, frame)!
    expect(a.track_id).toBe('weather-guide')
    expect(a.footprint[0]).toHaveLength(49)
    for (const [lon, lat] of a.footprint[0]) {
      const [x, z] = frame.lonLatToWorld(lon, lat)
      expect(Math.hypot(x, z)).toBeCloseTo(120, 0)
    }
    expect(guideTrack({ ...draft }, frame)).toBe(a)
    expect(guideTrack({ ...draft, radius_m: 90 }, frame)).not.toBe(a)
    expect(guideTrack({ ...draft, waypoints: [] }, frame)).toBeNull()
    expect(guideTrack({ ...draft, radius_m: 0 }, frame)).toBeNull()
    // Drawn areas: the corners are the footprint, closed back to the first corner; fewer than three corners is no area yet.
    const corners: [number, number][] = [[-79.391, 43.639], [-79.389, 43.639], [-79.389, 43.641]]
    const area = guideTrack({ ...draft, kind: 'flood', shape: 'polygon', radius_m: 0, waypoints: corners }, frame)!
    expect(area.footprint[0]).toEqual([...corners, corners[0]])
    expect(guideTrack({ ...draft, kind: 'flood', shape: 'polygon', radius_m: 0, waypoints: corners }, frame)).toBe(area)
    expect(guideTrack({ ...draft, kind: 'flood', shape: 'polygon', radius_m: 0, waypoints: corners.slice(0, 2) }, frame)).toBeNull()
  })
})
