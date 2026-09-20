import { describe, expect, it } from 'vitest'
import { distanceToStroke, strokeSamples, type HazardPoint } from './hazardGeometry'

describe('stored hazard path geometry', () => {
  it('spreads from the entire painted path, including bends and repeated points', () => {
    const path: HazardPoint[] = [[0, 0], [100, 0], [100, 100], [100, 100]]
    expect(distanceToStroke([50, 4], path)).toBe(4)
    expect(distanceToStroke([95, 90], path)).toBe(5)
    expect(distanceToStroke([50, 50], path)).toBe(50)
    expect(distanceToStroke([3, 4], [[0, 0]])).toBe(5)
    expect(distanceToStroke([0, 0], [])).toBe(Infinity)
  })

  it('samples a continuous ignition line with bounded work and both endpoints', () => {
    const path: HazardPoint[] = [[0, 0], [100, 0], [100, 100]]
    const points = strokeSamples(path, 5, 20)
    expect(points.length).toBeLessThanOrEqual(20)
    expect(points[0]).toEqual(path[0])
    expect(points.at(-1)).toEqual(path.at(-1))
    expect(points.every((p) => distanceToStroke(p, path) < 0.0001)).toBe(true)
  })

})
