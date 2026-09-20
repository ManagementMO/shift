import { describe, expect, it } from 'vitest'
import { WorldFrame } from './babylon/coords'
import { BUILDING_KIND_ORDER, BUILDING_KINDS, developmentActivity, developmentArrowFraction, developmentCounts, developmentDirection, developmentError, developmentKind, developmentLabel, developmentPolygon, developmentPreset, developmentRing, scenarioForView } from './development'
import { fixtureBundle, fixturePack, fixtureScenario } from './development.fixtures'

const frame = new WorldFrame({ utm_zone: 17, net_offset: [-626705.41, -4831652.88], origin_net: [3203.875, 2450.355], origin_lonlat: [-79.3891482, 43.6485798], bounds_world: [-3203.9, -2450.4, 3203.9, 2450.4] })

describe('declared development inputs', () => {
  it('offers exactly four kinds, each a valid preset with its own direction and look', () => {
    expect(BUILDING_KIND_ORDER).toEqual(['park', 'townhouse', 'apartment', 'skyscraper'])
    const specs = Object.fromEntries(BUILDING_KIND_ORDER.map((kind) => [kind, developmentPreset(fixturePack, 1800, kind)]))
    expect(developmentDirection(specs.townhouse)).toBe('outbound')
    expect(developmentDirection(specs.apartment)).toBe('outbound')
    expect(developmentDirection(specs.skyscraper)).toBe('inbound')
    expect(developmentDirection(specs.park)).toBe('inbound')
    expect(specs.park.land_use).toBe('park')
    expect(specs.park.people_per_unit).toBe(1)
    expect(specs.skyscraper.height_m).toBeGreaterThan(specs.apartment.height_m)
    expect(specs.apartment.height_m).toBeGreaterThan(specs.townhouse.height_m)
    for (const kind of BUILDING_KIND_ORDER) {
      expect(developmentError(specs[kind], 1800)).toBeNull()
      expect(developmentKind(specs[kind])).toBe(kind)
      expect(developmentLabel(specs[kind])).toBe(BUILDING_KINDS[kind].label)
      expect(specs[kind].name).toBe(BUILDING_KINDS[kind].label)
    }
    expect(developmentPreset(fixturePack, 1800, 'park', 3).name).toBe('Park 3')
    expect(new Set(BUILDING_KIND_ORDER.map((kind) => BUILDING_KINDS[kind].color)).size).toBe(4)
  })

  it('still labels specs made by other tooling instead of guessing a kind', () => {
    const school = { ...developmentPreset(fixturePack, 1800, 'skyscraper'), land_use: 'school' as const }
    expect(developmentKind(school)).toBeNull()
    expect(developmentLabel(school)).toBe('School')
  })

  it('counts participants and one-way trips independently of the mesh', () => {
    const spec = developmentPreset(fixturePack, 1800)
    const original = developmentCounts(spec)
    expect(original).toEqual({ participants: 120, trips: 120, cars: 42 })
    expect(developmentCounts({ ...spec, height_m: 200, footprint_m: [120, 80] })).toEqual(original)
    expect(developmentCounts({ ...spec, return_wave: { start_s: 1200, end_s: 1800, profile: 'uniform' } }).trips).toBe(240)
  })

  it('switches direction for return waves and is inactive between them', () => {
    const spec = { ...developmentPreset(fixturePack, 1800, 'skyscraper'), first_wave: { start_s: 0, end_s: 300, profile: 'triangular' as const }, return_wave: { start_s: 1200, end_s: 1500, profile: 'triangular' as const } }
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
