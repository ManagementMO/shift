import { describe, expect, it } from 'vitest'
import { zoomToRadius } from '../babylon/mapAdapter'
import { TORONTO_CITY, developmentPose } from './camera'

describe('development camera pose', () => {
  it('frames a mid-rise close enough to read as a building, keeping the whole lot in view', () => {
    const pose = developmentPose([-79.387, 43.6416], [36, 26], 30, TORONTO_CITY)
    const radius = zoomToRadius(pose.zoom, pose.center[1])
    expect(pose.center).toEqual([-79.387, 43.6416])
    expect(radius).toBeGreaterThan(120)
    expect(radius).toBeLessThan(260)
    expect(pose.bearing).toBe(TORONTO_CITY.bearing)
  })

  it('pulls back for large footprints and tall towers without exceeding city-scale zoom limits', () => {
    const small = developmentPose([-79.387, 43.6416], [20, 20], 10, TORONTO_CITY)
    const wide = developmentPose([-79.387, 43.6416], [250, 250], 10, TORONTO_CITY)
    const tall = developmentPose([-79.387, 43.6416], [36, 26], 300, TORONTO_CITY)
    expect(wide.zoom).toBeLessThan(small.zoom)
    expect(tall.zoom).toBeLessThan(small.zoom)
    expect(wide.zoom).toBeGreaterThanOrEqual(15.5)
    expect(small.zoom).toBeLessThanOrEqual(17.9)
  })
})
