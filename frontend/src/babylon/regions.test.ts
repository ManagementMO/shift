import { describe, expect, it } from 'vitest'

import { signedArea } from './geometry'
import { corridorShapes, districtSites, farthestPair, nearestCorridor, nearestSite, pointInRing, voronoiCells, type Site } from './regions'
import type { WorldRoad } from './worldData'

const bounds = [-1000, -800, 1000, 800] as const
/** Ring vertices as sorted pairs, so equal polygons compare equal whatever vertex they start from. */
const corners = (ring: number[]) => Array.from({ length: ring.length / 2 }, (_, i) => [ring[2 * i], ring[2 * i + 1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
const sites: Site[] = [
  { id: 'a', name: 'A', x: -400, z: 0 },
  { id: 'b', name: 'B', x: 400, z: 0 },
  { id: 'c', name: 'C', x: 0, z: 500 },
]

describe('district cells', () => {
  it('splits two sites along their perpendicular bisector', () => {
    const [a, b] = voronoiCells(sites.slice(0, 2), bounds)
    expect(corners(a.ring)).toEqual([[-1000, -800], [-1000, 800], [0, -800], [0, 800]])
    expect(corners(b.ring)).toEqual([[0, -800], [0, 800], [1000, -800], [1000, 800]])
  })

  it('tiles the whole bounds with convex cells that each contain their own site', () => {
    const cells = voronoiCells(sites, bounds)
    const total = cells.reduce((sum, c) => sum + Math.abs(signedArea(c.ring)), 0)
    expect(total).toBeCloseTo((bounds[2] - bounds[0]) * (bounds[3] - bounds[1]), 6)
    for (const c of cells) {
      expect(pointInRing(c.x, c.z, c.ring)).toBe(true)
      const n = c.ring.length / 2
      for (let i = 0; i < n; i++) {
        const [ax, az, bx, bz, cx, cz] = [c.ring[2 * i], c.ring[2 * i + 1], c.ring[(2 * i + 2) % (2 * n)], c.ring[(2 * i + 3) % (2 * n)], c.ring[(2 * i + 4) % (2 * n)], c.ring[(2 * i + 5) % (2 * n)]]
        expect((bx - ax) * (cz - bz) - (bz - az) * (cx - bx)).toBeGreaterThanOrEqual(-1e-6)
      }
    }
  })

  it('assigns every ground point to the cell containing it', () => {
    const cells = voronoiCells(sites, bounds)
    for (const [x, z] of [[-900, -700], [900, 700], [0, 600], [10, 100], [-10, -100], [30, 250], [-300, 700]]) {
      const hit = nearestSite(cells, x, z)!
      expect(cells.filter((c) => pointInRing(x, z, c.ring)).map((c) => c.id)).toContain(hit.id)
    }
    expect(nearestSite([], 0, 0)).toBeNull()
  })

  it('adds the venue as a district named after the landmark standing on it', () => {
    const world = {
      zones: [{ id: 'Z', name: 'Union Station', x: 800, z: -300, share: 1 }],
      venue: { x: 3, z: -798, edge: 'e' },
      landmarks: [{ id: 'rc', kind: 'rogers_centre' as const, name: 'Rogers Centre', x: 12, z: -774, h: 80, ring: [] }, { id: 'cn', kind: 'cn_tower' as const, name: 'CN Tower', x: 179, z: -662, h: 553, ring: [] }],
    }
    expect(districtSites(world).map((s) => s.name)).toEqual(['Union Station', 'Rogers Centre'])
    expect(districtSites({ ...world, landmarks: [] }).map((s) => s.name)).toEqual(['Union Station', 'Venue'])
    expect(districtSites({ ...world, zones: [{ id: 'V', name: 'Stadium', x: 3, z: -798, share: 1 }] }).map((s) => s.id)).toEqual(['V'])
  })
})

const road = (id: string, shape: number[], w = 10): WorldRoad => ({ id, shape, w, type: 'primary', kind: 'road', allow: ['car'], prio: 1, speed: 13, from: '', to: '' })
const roads = new Map([
  ['e1', road('e1', [0, 0, 100, 0])],
  ['e2', road('e2', [100, 0, 200, 5])],
  ['e3', road('e3', [200, 5, 300, 0])],
  ['n1', road('n1', [0, 200, 0, 400], 6)],
])

describe('edge runs (corridors, closures)', () => {
  it('finds the true ends of a run whatever the edge order', () => {
    expect(farthestPair([[100, 0], [300, 0], [0, 0], [200, 5]])).toEqual([[0, 0], [300, 0]])
    expect(farthestPair([[5, 5]])).toBeNull()
  })

  it('resolves named runs against compiled roads and drops unknown edges', () => {
    const shapes = corridorShapes({ front: { label: 'Front St W', edge_ids: ['e3', 'missing', 'e1', 'e2'] }, ghost: { label: 'Nothing', edge_ids: ['missing'] } }, roads)
    expect(shapes.map((s) => s.name)).toEqual(['Front St W'])
    expect(shapes[0].roads.map((r) => r.id)).toEqual(['e3', 'e1', 'e2'])
    expect(shapes[0].axis).toEqual([[0, 0], [300, 0]])
  })

  it('picks the run under the pointer within a tolerance that includes the road width', () => {
    const shapes = corridorShapes({ front: { label: 'Front', edge_ids: ['e1', 'e2', 'e3'] }, north: { label: 'North', edge_ids: ['n1'] } }, roads)
    expect(nearestCorridor(shapes, 150, 8, 10)?.id).toBe('front')
    expect(nearestCorridor(shapes, 150, 40, 10)).toBeNull()
    expect(nearestCorridor(shapes, 6, 300, 5)?.id).toBe('north')
    expect(nearestCorridor(shapes, 2, 100, 200)?.id).toBe('front')
    expect(nearestCorridor(shapes, 2, 190, 200)?.id).toBe('north')
  })
})
