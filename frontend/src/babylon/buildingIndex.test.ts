import { describe, expect, it } from 'vitest'

import { BuildingIndex, hitPrism, type Prism } from './buildingIndex'
import type { WorldData } from './worldData'

const square = (x: number, z: number, s: number) => [x - s, z - s, x + s, z - s, x + s, z + s, x - s, z + s]
const world = {
  buildings: [
    { id: 'low', ring: square(0, 0, 10), h: 10, cat: 'retail' as const, name: 'Corner shop' },
    { id: 'tower-a', source_id: 'tower', ring: square(100, 0, 15), h: 40, cat: 'office' as const },
    { id: 'tower-b', source_id: 'tower', ring: square(100, 0, 8), base: 40, h: 60, cat: 'office' as const, roofs: [{ ring: square(100, 0, 8) }] },
    { id: 'sliver', ring: [0, 0, 1, 0, 1, 1], h: 5, cat: 'generic' as const },
    { id: 'gone', ring: square(300, 0, 10), h: 30, cat: 'generic' as const },
  ],
  landmarks: [{ id: 'cn', kind: 'cn_tower' as const, name: 'CN Tower', x: 500, z: 0, h: 553, ring: square(500, 0, 30) }],
  massing: { version: 1, network_fingerprint: '', source: '', source_url: '', license: '', excluded_osm_ids: ['gone'], buildings: [{ id: 'm1', cat: 'tower' as const, h: 80, x: 300, z: 0, tiers: [{ y0: 0, y1: 50, ring: square(300, 0, 12), holes: [] }, { y0: 50, y1: 80, ring: square(300, 0, 6), holes: [] }] }] },
} as unknown as WorldData

/** A ray from a camera at `from` towards `to`. */
const ray = (from: [number, number, number], to: [number, number, number]) => {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]]
  const l = Math.hypot(...d)
  return { origin: { x: from[0], y: from[1], z: from[2] }, dir: { x: d[0] / l, y: d[1] / l, z: d[2] / l } }
}

describe('building index', () => {
  const index = new BuildingIndex(world)

  it('groups reconciled sections and massing tiers into one building each and drops replaced or degenerate footprints', () => {
    expect(index.size).toBe(4)
    const tower = index.building('tower')!
    expect(tower.sections).toBe(2)
    expect(tower.height).toBe(100)
    expect(tower.area).toBe(900)
    expect([tower.x, tower.z]).toEqual([100, 0])
    expect(index.building('m1')?.height).toBe(80)
    expect(index.building('gone')).toBeUndefined()
    expect(index.building('sliver')).toBeUndefined()
    expect(index.building('low')?.name).toBe('Corner shop')
    expect(index.building('cn')).toMatchObject({ kind: 'landmark', name: 'CN Tower', height: 553 })
  })

  it('picks the building whose roof the ray looks down onto', () => {
    expect(index.pick(ray([0, 500, -300], [0, 0, 0]))?.info.id).toBe('low')
    expect(index.pick(ray([100, 500, -300], [100, 0, 0]))?.info.id).toBe('tower')
    expect(index.pick(ray([50, 500, -300], [50, 0, 0]))).toBeNull()
  })

  it('picks a tall building through its facade before the ground behind it', () => {
    // aim at the ground just north of the tower: the line of sight passes through the tower's upper section
    const hit = index.pick(ray([100, 60, -400], [100, 0, 30]))
    expect(hit?.info.id).toBe('tower')
    // the same aim from directly above misses
    expect(index.pick(ray([100, 600, 30], [100, 0, 30]))).toBeNull()
  })

  it('returns the nearest of several buildings on the line of sight, and looks over the low ones', () => {
    const low = index.pick(ray([-200, 5, 0], [600, 5, 0]))
    expect(low?.info.id).toBe('low')
    expect(low?.t).toBeCloseTo(190, 6)
    expect(index.pick(ray([-200, 30, 0], [600, 30, 0]))?.info.id).toBe('tower')
  })

  it('handles a ray that starts inside the height band and a horizontal ray', () => {
    const p: Prism = { building: 'p', ring: square(0, 0, 10), roofs: [], y0: 0, y1: 20 }
    expect(hitPrism(p, { x: -50, y: 10, z: 0 }, { x: 1, y: 0, z: 0 }, 1000)).toBeCloseTo(40, 6)
    expect(hitPrism(p, { x: 0, y: 10, z: 0 }, { x: 1, y: 0, z: 0 }, 1000)).toBe(0)
    expect(hitPrism(p, { x: -50, y: 30, z: 0 }, { x: 1, y: 0, z: 0 }, 1000)).toBeNull()
    // t is in units of the direction vector: the ray drops into the 20 m band after 50 units, over the roof
    expect(hitPrism(p, { x: -50, y: 30, z: 0 }, { x: 1, y: -0.2, z: 0 }, 1000)).toBeCloseTo(50, 6)
  })
})
