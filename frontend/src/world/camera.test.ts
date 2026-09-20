import { describe, expect, it } from 'vitest'

import { zoomToRadius } from '../babylon/mapAdapter'
import { buildingPose, corridorPose, developmentPose, districtPose, framePose, TORONTO_CITY } from './camera'

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

// Toronto destination districts (lon, lat) and the venue, as the pack declares them.
const DISTRICTS: [number, number][] = [
  [-79.37902, 43.64559], // Union Station
  [-79.38057, 43.64925], // Financial District
  [-79.37726, 43.64169], // Harbourfront
  [-79.37062, 43.64832], // St. Lawrence Market
  [-79.41687, 43.63864], // Liberty Village
  [-79.3893, 43.6414], // Rogers Centre
]

describe('framing every pickable region', () => {
  it('centres on the extent of the districts and zooms out far enough to show them all', () => {
    const pose = framePose(DISTRICTS, TORONTO_CITY)
    expect(pose.center[0]).toBeCloseTo((-79.41687 + -79.37062) / 2, 5)
    expect(pose.center[1]).toBeCloseTo((43.63864 + 43.64925) / 2, 5)
    expect(pose.zoom).toBeLessThan(TORONTO_CITY.zoom)
    expect(pose.zoom).toBeGreaterThan(13.5)
    expect(pose.bearing).toBe(TORONTO_CITY.bearing)
    expect(pose.pitch).toBeLessThan(TORONTO_CITY.pitch)
  })

  it('flies into one district closer than the all-districts frame', () => {
    const one = districtPose(DISTRICTS[0], TORONTO_CITY)
    expect(one.center).toEqual(DISTRICTS[0])
    expect(one.zoom).toBeGreaterThan(framePose(DISTRICTS, TORONTO_CITY).zoom)
    expect(framePose(DISTRICTS.slice(0, 3), TORONTO_CITY).zoom).toBeGreaterThan(framePose(DISTRICTS, TORONTO_CITY).zoom)
  })
})

describe('framing what was clicked', () => {
  it('backs the camera off taller buildings and stays at street scale for low ones', () => {
    const shop = buildingPose([-79.38, 43.64], 8, TORONTO_CITY)
    const tower = buildingPose([-79.38, 43.64], 250, TORONTO_CITY)
    expect(shop.center).toEqual([-79.38, 43.64])
    expect(shop.zoom).toBe(17.6)
    expect(tower.zoom).toBeLessThan(shop.zoom)
    expect(tower.zoom).toBeGreaterThanOrEqual(16)
    expect(tower.bearing).toBe(TORONTO_CITY.bearing)
  })

  it('frames a corridor across its axis from either end order', () => {
    const a = corridorPose([[-79.395, 43.6425], [-79.381, 43.6432]], TORONTO_CITY)
    const b = corridorPose([[-79.381, 43.6432], [-79.395, 43.6425]], TORONTO_CITY)
    expect(a.center[0]).toBeCloseTo(b.center[0], 9)
    expect(a.zoom).toBeCloseTo(b.zoom, 9)
    // same axis: bearings agree up to a half turn
    expect(Math.sin(((a.bearing - b.bearing) * Math.PI) / 180)).toBeCloseTo(0, 6)
  })
})
