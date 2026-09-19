/**
 * The one coordinate service for the Babylon world.
 *
 *   lon/lat  --UTM(zone)-->  UTM metres  --+netOffset-->  SUMO net metres  --(-origin)-->  world metres
 *
 * World axes: x = east, y = up, z = north (Babylon's default left-handed frame, so a top-down view with
 * north up has east to the right with no mirroring).  Replay samples are lon/lat, world.json geometry is
 * already in world metres, SUMO edge ids are shared — this file is what keeps them on the same ground.
 *
 * Transverse Mercator uses Krüger's series (3rd order), which agrees with proj's UTM to well under a
 * millimetre across a zone.
 */

export interface WorldCrs {
  utm_zone: number
  net_offset: [number, number]
  origin_net: [number, number]
  origin_lonlat: [number, number]
  bounds_world: [number, number, number, number]
}

const A_WGS84 = 6378137
const F_WGS84 = 1 / 298.257223563
const K0 = 0.9996
const E0 = 500000
const N = F_WGS84 / (2 - F_WGS84)
const N2 = N * N
const N3 = N2 * N
const AA = (A_WGS84 / (1 + N)) * (1 + N2 / 4 + (N2 * N2) / 64)
const ALPHA = [N / 2 - (2 * N2) / 3 + (5 * N3) / 16, (13 * N2) / 48 - (3 * N3) / 5, (61 * N3) / 240]
const BETA = [N / 2 - (2 * N2) / 3 + (37 * N3) / 96, N2 / 48 + N3 / 15, (17 * N3) / 480]
const DELTA = [2 * N - (2 * N2) / 3 - 2 * N3, (7 * N2) / 3 - (8 * N3) / 5, (56 * N3) / 15]
const TWO_SQRT_N = (2 * Math.sqrt(N)) / (1 + N)
const DEG = Math.PI / 180

export function utmForward(lon: number, lat: number, zone: number): [number, number] {
  const lon0 = (zone * 6 - 183) * DEG
  const phi = lat * DEG
  const dl = lon * DEG - lon0
  const s = Math.sin(phi)
  const t = Math.sinh(Math.atanh(s) - TWO_SQRT_N * Math.atanh(TWO_SQRT_N * s))
  const xi = Math.atan2(t, Math.cos(dl))
  const eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t))
  let e = eta
  let n = xi
  for (let j = 1; j <= 3; j++) {
    e += ALPHA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta)
    n += ALPHA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta)
  }
  return [E0 + K0 * AA * e, K0 * AA * n]
}

export function utmInverse(x: number, y: number, zone: number): [number, number] {
  const lon0 = (zone * 6 - 183) * DEG
  const xi = y / (K0 * AA)
  const eta = (x - E0) / (K0 * AA)
  let xi2 = xi
  let eta2 = eta
  for (let j = 1; j <= 3; j++) {
    xi2 -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta)
    eta2 -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta)
  }
  const chi = Math.asin(Math.sin(xi2) / Math.cosh(eta2))
  let phi = chi
  for (let j = 1; j <= 3; j++) phi += DELTA[j - 1] * Math.sin(2 * j * chi)
  const lon = lon0 + Math.atan2(Math.sinh(eta2), Math.cos(xi2))
  return [lon / DEG, phi / DEG]
}

export class WorldFrame {
  readonly crs: WorldCrs

  constructor(crs: WorldCrs) {
    this.crs = crs
  }

  /** lon/lat -> [x east, z north] world metres. */
  lonLatToWorld(lon: number, lat: number): [number, number] {
    const [ux, uy] = utmForward(lon, lat, this.crs.utm_zone)
    return [ux + this.crs.net_offset[0] - this.crs.origin_net[0], uy + this.crs.net_offset[1] - this.crs.origin_net[1]]
  }

  /** lon/lat -> SUMO network coordinates (what `.net.xml` shapes are in). */
  lonLatToNet(lon: number, lat: number): [number, number] {
    const [ux, uy] = utmForward(lon, lat, this.crs.utm_zone)
    return [ux + this.crs.net_offset[0], uy + this.crs.net_offset[1]]
  }

  netToWorld(nx: number, ny: number): [number, number] {
    return [nx - this.crs.origin_net[0], ny - this.crs.origin_net[1]]
  }

  worldToLonLat(x: number, z: number): [number, number] {
    return utmInverse(x + this.crs.origin_net[0] - this.crs.net_offset[0], z + this.crs.origin_net[1] - this.crs.net_offset[1], this.crs.utm_zone)
  }

  /** SUMO heading (degrees clockwise from north) -> Babylon rotation about +y (left-handed: positive = clockwise from above). */
  static headingToYaw(angleDeg: number): number {
    return angleDeg * DEG
  }

  contains(x: number, z: number, pad = 0): boolean {
    const [x0, z0, x1, z1] = this.crs.bounds_world
    return x >= x0 - pad && x <= x1 + pad && z >= z0 - pad && z <= z1 + pad
  }
}
