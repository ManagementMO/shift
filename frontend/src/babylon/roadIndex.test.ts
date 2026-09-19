import { describe, expect, it } from 'vitest'

import { RoadIndex } from './roadIndex'
import type { WorldRoad } from './worldData'

function road(id: string, shape: number[], extra: Partial<WorldRoad> = {}): WorldRoad {
  return {
    id,
    shape,
    w: 7,
    type: 'highway.residential',
    kind: 'road',
    allow: ['car', 'bus'],
    prio: 4,
    speed: 13.9,
    from: `${id}_a`,
    to: `${id}_b`,
    ...extra,
  }
}

const roads = [
  road('east', [0, 0, 100, 0]), // west -> east along z = 0
  road('north', [200, -50, 200, 50]), // south -> north along x = 200
  road('walk', [0, 30, 100, 30], { kind: 'path', allow: ['ped'] }),
]

describe('RoadIndex (WorldRoad <-> SUMO edge)', () => {
  it('maps edge ids to roads', () => {
    const ix = new RoadIndex({ roads })
    expect(ix.byId.get('east')?.from).toBe('east_a')
    expect(ix.size).toBe(3)
  })

  it('finds the nearest edge, its lane position and heading', () => {
    const ix = new RoadIndex({ roads })
    const h = ix.nearest(40, 2)!
    expect(h.road.id).toBe('east')
    expect(h.dist).toBeCloseTo(2)
    expect(h.s).toBeCloseTo(40)
    expect(h.heading).toBeCloseTo(90) // eastbound = 90° clockwise from north (SUMO convention)

    const n = ix.nearest(203, 10)!
    expect(n.road.id).toBe('north')
    expect(n.s).toBeCloseTo(60)
    expect(n.heading).toBeCloseTo(0)
  })

  it('respects the search radius and honours filters (vehicle roads only)', () => {
    const ix = new RoadIndex({ roads })
    expect(ix.nearest(50, 15, 5)).toBeNull()
    expect(ix.nearest(50, 26)!.road.id).toBe('walk')
    const vehicular = new RoadIndex({ roads }, (r) => r.kind === 'road')
    expect(vehicular.nearest(50, 26, 40)!.road.id).toBe('east')
  })

  it('handles segments spanning many grid cells', () => {
    const ix = new RoadIndex({ roads: [road('long', [-1000, -1000, 1000, 1000])] })
    const h = ix.nearest(500, 501)!
    expect(h.road.id).toBe('long')
    expect(h.dist).toBeCloseTo(Math.SQRT1_2, 5)
  })
})
