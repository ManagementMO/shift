import { describe, expect, it } from 'vitest'

import type { ReplayIndex } from '../replay'
import { WorldFrame } from './coords'
import { activeReleases, LOD_CITY_RADIUS_M, LOD_FIGURE_M, lodFor, pulse, PULSE_RADIUS_M, PULSE_S, releasesFrom } from './crowd'

const frame = new WorldFrame({
  utm_zone: 17,
  net_offset: [-626705.41, -4831652.88],
  origin_net: [3203.875, 2450.355],
  origin_lonlat: [-79.3891482, 43.6485798],
  bounds_world: [-3203.9, -2450.4, 3203.9, 2450.4],
})

function rx(): ReplayIndex {
  const ev = (t: number, person_id: string, event: 'depart' | 'arrive') => ({ t, person_id, event, vehicle_id: null, stop_id: null })
  const track = (id: string, t0: number) => ({
    track: { entity_id: id, kind: 'person' as const, samples: [[t0, -79.3902085, 43.6406769, 0, 0]], breaks: [] },
    times: [t0],
    breakSet: new Set<number>(),
  })
  return {
    bundle: { events: [] } as unknown as ReplayIndex['bundle'],
    population: null,
    tracks: { p1: track('p1', 7), p2: track('p2', 55), p3: track('p3', 60) },
    personEvents: { p2: [ev(55, 'p2', 'depart')], p1: [ev(7, 'p1', 'depart'), ev(900, 'p1', 'arrive')], p3: [ev(60, 'p3', 'arrive')] },
    occupancy: {},
    stopQueue: {},
    tMax: 1000,
  }
}

describe('pedestrian level of detail', () => {
  it('draws figures up close and markers far away', () => {
    expect(lodFor(50, 300)).toBe('figure')
    expect(lodFor(LOD_FIGURE_M + 1, 300)).toBe('marker')
  })
  it('collapses the whole crowd to markers from the city camera', () => {
    expect(lodFor(10, LOD_CITY_RADIUS_M)).toBe('marker')
  })
})

describe('venue release pulses', () => {
  it('builds one release per recorded depart at the first sampled position, sorted by time', () => {
    const r = releasesFrom(rx(), frame)
    expect(r.map((v) => v.id)).toEqual(['p1', 'p2']) // p3 never departs
    const [x, z] = frame.lonLatToWorld(-79.3902085, 43.6406769)
    expect(r[0].x).toBeCloseTo(x, 6)
    expect(r[0].z).toBeCloseTo(z, 6)
    expect(Math.hypot(x - 12, z + 774)).toBeLessThan(200) // on the street outside Rogers Centre
  })

  it('grows from a point to the full ring and fades out over its lifetime', () => {
    expect(pulse(-0.1)).toBeNull()
    expect(pulse(PULSE_S + 0.01)).toBeNull()
    expect(pulse(0)).toEqual({ radius: 1, fade: 1 })
    const end = pulse(PULSE_S)!
    expect(end.radius).toBeCloseTo(PULSE_RADIUS_M)
    expect(end.fade).toBeCloseTo(0)
    expect(pulse(PULSE_S / 2)!.radius).toBeGreaterThan(PULSE_RADIUS_M / 2) // eased: fast start
  })

  it('selects only the releases whose pulse is alive at t', () => {
    const r = releasesFrom(rx(), frame)
    expect(activeReleases(r, 6.9).map((v) => v.id)).toEqual([])
    expect(activeReleases(r, 7).map((v) => v.id)).toEqual(['p1'])
    expect(activeReleases(r, 7 + PULSE_S).map((v) => v.id)).toEqual(['p1'])
    expect(activeReleases(r, 7 + PULSE_S + 0.1).map((v) => v.id)).toEqual([])
    expect(activeReleases(r, 56).map((v) => v.id)).toEqual(['p2'])
  })
})
