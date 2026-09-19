import { describe, expect, it } from 'vitest'

import { WorldFrame, utmForward, utmInverse } from './coords'

// crs block of var/citypacks/toronto/world.json (netconvert --proj.utm over the Toronto tiles).
const TORONTO = {
  utm_zone: 17,
  net_offset: [-626705.41, -4831652.88] as [number, number],
  origin_net: [3203.875, 2450.355] as [number, number],
  origin_lonlat: [-79.3891482, 43.6485798] as [number, number],
  bounds_world: [-3203.9, -2450.4, 3203.9, 2450.4] as [number, number, number, number],
}

// name, lon, lat, SUMO net x/y (sumolib.convertLonLat2XY), world x/z (world.json anchors)
const ANCHORS: [string, number, number, number, number, number, number][] = [
  ['CN Tower', -79.3870878, 43.6425892, 3382.9725, 1788.2515, 179.1, -662.1],
  ['Union Station', -79.380511, 43.6447364, 3908.7735, 2037.0557, 704.9, -413.3],
  ['Rogers Centre', -79.389182, 43.6416112, 3216.1721, 1676.3516, 12.3, -774.0],
  ['Scotiabank Arena', -79.3791677, 43.6434622, 4019.8778, 1897.6541, 816.0, -552.7],
  ['Toronto City Hall', -79.3839551, 43.6535306, 3611.978, 3008.3522, 408.1, 558.0],
  ['Front & Bay junction', -79.3769617, 43.6469271, 4190.2753, 2285.9536, 986.4, -164.4],
]

describe('UTM zone 17 (WGS84)', () => {
  it('matches proj for the CN Tower', () => {
    const [e, n] = utmForward(-79.3870878, 43.6425892, 17)
    expect(e).toBeCloseTo(630088.3824764596, 3)
    expect(n).toBeCloseTo(4833441.131523085, 3)
  })
  it('round-trips forward/inverse to within half a millimetre', () => {
    for (const [, lon, lat] of ANCHORS) {
      const [e, n] = utmForward(lon, lat, 17)
      const [lon2, lat2] = utmInverse(e, n, 17)
      expect(lon2).toBeCloseTo(lon, 8)
      expect(lat2).toBeCloseTo(lat, 8)
    }
  })
})

describe('WorldFrame (Toronto)', () => {
  const frame = new WorldFrame(TORONTO)
  it('reproduces SUMO net coordinates for every landmark anchor (<1 cm)', () => {
    for (const [, lon, lat, nx, ny] of ANCHORS) {
      const [x, y] = frame.lonLatToNet(lon, lat)
      expect(Math.abs(x - nx)).toBeLessThan(0.01)
      expect(Math.abs(y - ny)).toBeLessThan(0.01)
    }
  })
  it('places landmark anchors where world.json compiled them (<6 cm, anchors are rounded to 0.1 m)', () => {
    for (const [, lon, lat, , , wx, wz] of ANCHORS) {
      const [x, z] = frame.lonLatToWorld(lon, lat)
      expect(Math.abs(x - wx)).toBeLessThan(0.06)
      expect(Math.abs(z - wz)).toBeLessThan(0.06)
    }
  })
  it('puts the network origin at (0, 0) and keeps east/north orientation', () => {
    const [x, z] = frame.lonLatToWorld(...TORONTO.origin_lonlat)
    expect(Math.abs(x)).toBeLessThan(0.05)
    expect(Math.abs(z)).toBeLessThan(0.05)
    const [ex] = frame.lonLatToWorld(TORONTO.origin_lonlat[0] + 0.01, TORONTO.origin_lonlat[1])
    const [, nz] = frame.lonLatToWorld(TORONTO.origin_lonlat[0], TORONTO.origin_lonlat[1] + 0.01)
    expect(ex).toBeGreaterThan(700)
    expect(nz).toBeGreaterThan(1000)
  })
  it('inverts world -> lon/lat', () => {
    for (const [, lon, lat, , , wx, wz] of ANCHORS) {
      const [lon2, lat2] = frame.worldToLonLat(wx, wz)
      expect(lon2).toBeCloseTo(lon, 5)
      expect(lat2).toBeCloseTo(lat, 5)
    }
  })
  it('maps SUMO headings onto Babylon yaw (0 = north, 90 = east, clockwise)', () => {
    expect(WorldFrame.headingToYaw(0)).toBe(0)
    expect(WorldFrame.headingToYaw(90)).toBeCloseTo(Math.PI / 2)
  })
})
