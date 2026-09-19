import { describe, expect, it } from 'vitest'

import { Batch, signedArea } from './geometry'

/**
 * Babylon (left-handed, x east / y up / z north, default CCW front faces) draws a triangle when
 * (v1 - v0) x (v2 - v0) points *against* the surface normal.  Calibrated against CreateGround's index order.
 */
function frontFacing(b: Batch, tri: number): boolean {
  const [i0, i1, i2] = [b.indices[3 * tri], b.indices[3 * tri + 1], b.indices[3 * tri + 2]]
  const p = (i: number): [number, number, number] => [b.positions[3 * i], b.positions[3 * i + 1], b.positions[3 * i + 2]]
  const n = (i: number): [number, number, number] => [b.normals[3 * i], b.normals[3 * i + 1], b.normals[3 * i + 2]]
  const [a, c, d] = [p(i0), p(i1), p(i2)]
  const e1 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]]
  const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
  const nn = n(i0)
  return cross[0] * nn[0] + cross[1] * nn[1] + cross[2] * nn[2] < 0
}

const allFront = (b: Batch): boolean => {
  for (let t = 0; t < b.indices.length / 3; t++) if (!frontFacing(b, t)) return false
  return b.indices.length > 0
}

const CCW = [0, 0, 20, 0, 20, 10, 0, 10]
const CW = [0, 0, 0, 10, 20, 10, 20, 0]

describe('Batch winding', () => {
  it('polygons face up regardless of ring orientation', () => {
    expect(signedArea(CCW)).toBeGreaterThan(0)
    expect(signedArea(CW)).toBeLessThan(0)
    for (const ring of [CCW, CW]) {
      const b = new Batch()
      b.polygon(ring, undefined, 1, [1, 1, 1])
      expect(allFront(b)).toBe(true)
    }
  })

  it('walls face outward for both ring orientations and for holes', () => {
    for (const ring of [CCW, CW]) {
      const b = new Batch()
      b.walls(ring, [[5, 2, 5, 6, 12, 6, 12, 2]], 0, 30, [1, 1, 1])
      expect(allFront(b)).toBe(true)
      // outward: every wall normal points away from the outer ring centroid (10, 5) for the outer ring
      const outer = ring.length / 2 * 4 // 4 verts per edge
      for (let i = 0; i < outer; i++) {
        const dx = b.positions[3 * i] - 10
        const dz = b.positions[3 * i + 2] - 5
        expect(b.normals[3 * i] * dx + b.normals[3 * i + 2] * dz).toBeGreaterThan(0)
      }
    }
  })

  it('ribbons, discs and lathes are front-facing', () => {
    const r = new Batch()
    r.ribbon([0, 0, 100, 0, 150, 40, 300, 40], 6, 0.5, [1, 1, 1])
    expect(allFront(r)).toBe(true)
    const d = new Batch()
    d.disc(3, 4, 5, 0.7, [1, 1, 1], 12)
    expect(allFront(d)).toBe(true)
    const l = new Batch()
    l.lathe(0, 0, [[10, 0], [8, 50], [12, 60], [3, 100]], [1, 1, 1], 16)
    expect(allFront(l)).toBe(true)
  })
})
