import { describe, expect, it } from 'vitest'
import { WorldFrame } from './babylon/coords'
import { developmentActivity, developmentArrowFraction, developmentCounts, developmentDirection, developmentError, developmentPolygon, developmentPreset, developmentRing, scenarioForView } from './development'
import { fixtureBundle, fixturePack, fixtureScenario } from './development.fixtures'

const frame = new WorldFrame({ utm_zone: 17, net_offset: [-626705.41, -4831652.88], origin_net: [3203.875, 2450.355], origin_lonlat: [-79.3891482, 43.6485798], bounds_world: [-3203.9, -2450.4, 3203.9, 2450.4] })

describe('declared development inputs', () => {
  it('uses different directions and schedules for residential, office and school presets', () => {
    const residential = developmentPreset(fixturePack, 1800, 'residential')
    const office = developmentPreset(fixturePack, 1800, 'office')
    const school = developmentPreset(fixturePack, 1800, 'school')
    expect(developmentDirection(residential)).toBe('outbound')
    expect(developmentDirection(office)).toBe('inbound')
    expect(developmentDirection(school)).toBe('inbound')
    expect(residential.first_wave.profile).toBe('uniform')
    expect(school.first_wave.end_s).toBeLessThan(office.first_wave.end_s)
    for (const spec of [residential, office, school]) expect(developmentError(spec, 1800)).toBeNull()
  })

  it('counts participants and one-way trips independently of the mesh', () => {
    const spec = developmentPreset(fixturePack, 1800)
    const original = developmentCounts(spec)
    expect(original).toEqual({ participants: 500, trips: 500, cars: 175 })
    expect(developmentCounts({ ...spec, height_m: 200, footprint_m: [120, 80] })).toEqual(original)
    expect(developmentCounts({ ...spec, return_wave: { start_s: 1200, end_s: 1800, profile: 'uniform' } }).trips).toBe(1000)
  })

  it('switches direction for return waves and is inactive between them', () => {
    const spec = { ...developmentPreset(fixturePack, 1800, 'school'), return_wave: { start_s: 1200, end_s: 1500, profile: 'triangular' as const } }
    expect(developmentActivity(spec, 0)).toBe('inbound')
    expect(developmentActivity(spec, 300)).toBeNull()
    expect(developmentActivity(spec, 1200)).toBe('outbound')
    expect(developmentActivity(spec, 1500)).toBeNull()
  })

  it('keeps direction arrowheads near the building even when counterpart zones are kilometres away', () => {
    const spec = developmentPreset(fixturePack, 1800)
    const out = developmentArrowFraction(spec, 'outbound', 2000)
    const incoming = developmentArrowFraction(spec, 'inbound', 2000)
    expect(out * 2000).toBeGreaterThan(spec.footprint_m[0] / 2)
    expect(out * 2000).toBeLessThan(100)
    expect((1 - incoming) * 2000).toBeCloseTo(out * 2000)
  })

  it('matches the longitude/latitude footprint to the Babylon metre frame', () => {
    const spec = developmentPreset(fixturePack, 1800)
    const ring = developmentRing(spec, frame)
    expect(ring[2] - ring[0]).toBeCloseTo(spec.footprint_m[0])
    expect(ring[5] - ring[1]).toBeCloseTo(spec.footprint_m[1])
    const converted = developmentPolygon(spec).flatMap(([lon, lat]) => frame.lonLatToWorld(lon, lat))
    converted.forEach((n, i) => expect(n).toBeCloseTo(ring[i], 3))
  })

  it('rejects invalid geometry, schedules and inconsistent occupancy', () => {
    const spec = developmentPreset(fixturePack, 1800)
    expect(developmentError({ ...spec, position: [181, 43] }, 1800)).not.toBeNull()
    expect(developmentError({ ...spec, land_use: 'office', people_per_unit: 2 }, 1800)).not.toBeNull()
    expect(developmentError({ ...spec, footprint_m: [Infinity, 20] }, 1800)).not.toBeNull()
    expect(developmentError({ ...spec, first_wave: { start_s: 100, end_s: 50, profile: 'uniform' } }, 1800)).not.toBeNull()
    expect(developmentError({ ...spec, zone_shares: { east: 0.5 } }, 1800)).not.toBeNull()
  })

  it('renders each run’s own scenario and never puts the child building on the parent', () => {
    const parent = fixtureScenario()
    const child = fixtureScenario('child', 'parent')
    child.developments = [{ development_id: 'new-building', spec: developmentPreset(fixturePack, 1800), access: [] }]
    expect(scenarioForView([parent, child], child.scenario_id, fixtureBundle(parent, []), 'left')).toBe(parent)
    expect(scenarioForView([parent, child], child.scenario_id, fixtureBundle(child, []), 'right')).toBe(child)
    expect(scenarioForView([parent, child], child.scenario_id, null, 'left')).toBeNull()
    expect(scenarioForView([parent, child], child.scenario_id, null, 'solo')).toBe(child)
  })
})
