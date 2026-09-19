import { describe, expect, it } from 'vitest'

import type { TrackIndex } from '../replay'
import { interpAt, lerpAngle, type Interp } from './interp'

function ix(samples: number[][], breaks: number[] = []): TrackIndex {
  return {
    track: { entity_id: 'v', kind: 'car', samples, breaks },
    times: samples.map((s) => s[0]),
    breakSet: new Set(breaks),
  }
}

const blank = (): Interp => ({ lon: 0, lat: 0, angle: 0, speed: 0, i: -1, k: 0 })

describe('replay interpolation', () => {
  it('blends position, heading and speed between adjacent 1 s samples', () => {
    const t = ix([
      [10, -79.0, 43.0, 350, 10],
      [11, -79.0, 43.001, 10, 12],
    ])
    const r = interpAt(t, 10.5, blank())!
    expect(r.lon).toBeCloseTo(-79.0, 9)
    expect(r.lat).toBeCloseTo(43.0005, 9)
    expect(r.angle).toBeCloseTo(0, 6) // shortest path through north, not through 180
    expect(r.speed).toBeCloseTo(11, 9)
    expect(r.k).toBeCloseTo(0.5)
  })

  it('never blends across a recorded break; holds the last real sample instead', () => {
    const t = ix(
      [
        [10, -79.0, 43.0, 90, 10],
        [15, -79.1, 43.1, 90, 10], // teleport landed here; break index 1
      ],
      [1],
    )
    const r = interpAt(t, 11, blank())!
    expect(r.lon).toBe(-79.0)
    expect(r.lat).toBe(43.0)
    expect(r.k).toBe(0)
  })

  it('returns null once the hold exceeds MAX_GAP_S, and before the first sample', () => {
    const t = ix([
      [10, -79.0, 43.0, 90, 10],
      [20, -79.0, 43.0, 90, 10],
    ])
    expect(interpAt(t, 9.9, blank())).toBeNull()
    expect(interpAt(t, 12.5, blank())).not.toBeNull()
    expect(interpAt(t, 13.5, blank())).toBeNull()
    expect(interpAt(t, 20, blank())).not.toBeNull()
  })

  it('does not blend across a gap wider than MAX_GAP_S even when both samples exist', () => {
    const t = ix([
      [10, -79.0, 43.0, 90, 10],
      [14, -79.5, 43.5, 90, 10],
    ])
    const r = interpAt(t, 11, blank())!
    expect(r.lon).toBe(-79.0)
    expect(r.k).toBe(0)
  })

  it('lerps headings the short way round', () => {
    expect(lerpAngle(350, 10, 0.5)).toBeCloseTo(0)
    expect(lerpAngle(10, 350, 0.5)).toBeCloseTo(0)
    expect(lerpAngle(90, 180, 0.5)).toBeCloseTo(135)
    expect(lerpAngle(0, 90, 1)).toBeCloseTo(90)
  })
})
