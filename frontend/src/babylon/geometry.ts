/**
 * CPU geometry builders for the static city: everything here appends into a `Batch` (positions/normals/colors/
 * indices) that becomes one Babylon mesh, so 10k buildings or 30k road segments are a handful of draw calls.
 * World frame: x east, y up, z north.  Rings are flat [x0, z0, x1, z1, ...].
 */

import earcut from 'earcut'

import type { Flat } from './worldData'

export type RGB = [number, number, number]
export type SegmentFilter = (ax: number, az: number, bx: number, bz: number) => boolean

/** True when both ends of a segment lie on the same side of an axis-aligned box, within `tolerance` metres. */
export function onBoxEdge(box: readonly number[], tolerance = 0.6): SegmentFilter {
  const [x0, z0, x1, z1] = box
  return (ax, az, bx, bz) =>
    (Math.abs(ax - x0) < tolerance && Math.abs(bx - x0) < tolerance) || (Math.abs(ax - x1) < tolerance && Math.abs(bx - x1) < tolerance)
    || (Math.abs(az - z0) < tolerance && Math.abs(bz - z0) < tolerance) || (Math.abs(az - z1) < tolerance && Math.abs(bz - z1) < tolerance)
}

export class Batch {
  positions: number[] = []
  normals: number[] = []
  colors: number[] = []
  uvs: number[] = []
  indices: number[] = []
  readonly textureMetres: readonly [number, number]

  constructor(textureMetres: readonly [number, number] = [8, 8]) {
    this.textureMetres = textureMetres
  }

  get vertexCount(): number {
    return this.positions.length / 3
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: RGB, u = x / this.textureMetres[0], v = z / this.textureMetres[1]): number {
    const i = this.positions.length / 3
    this.positions.push(x, y, z)
    this.normals.push(nx, ny, nz)
    this.colors.push(c[0], c[1], c[2], 1)
    this.uvs.push(u, v)
    return i
  }

  /** Flat horizontal polygon (with holes) facing up at height y. */
  polygon(ring: Flat, holes: Flat[] | undefined, y: number, c: RGB): void {
    const { verts, holeIdx } = flatten(ring, holes)
    if (verts.length < 6) return
    const tris = earcut(verts, holeIdx.length ? holeIdx : null, 2)
    if (!tris.length) return
    const base = this.vertexCount
    for (let i = 0; i < verts.length; i += 2) this.vertex(verts[i], y, verts[i + 1], 0, 1, 0, c)
    // earcut always emits positive-shoelace (x,z) triangles, which is Babylon's up-facing front side
    for (let i = 0; i < tris.length; i += 3) this.indices.push(base + tris[i], base + tris[i + 1], base + tris[i + 2])
  }

  /** Vertical walls around a ring (and its holes) from y0 to y1, flat-shaded, outward normals. `skip` drops individual edges. */
  walls(ring: Flat, holes: Flat[] | undefined, y0: number, y1: number, c: RGB, shade = 0.85, inward = false, skip?: SegmentFilter): void {
    const side = inward ? -1 : 1
    const outward = (signedArea(ring) > 0 ? 1 : -1) * side
    this.wallRing(ring, y0, y1, c, shade, outward, skip)
    if (holes) for (const h of holes) this.wallRing(h, y0, y1, c, shade, -(signedArea(h) > 0 ? 1 : -1) * side, skip)
  }

  private wallRing(ring: Flat, y0: number, y1: number, c: RGB, shade: number, outward: number, skip?: SegmentFilter): void {
    const n = ring.length / 2
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const ax = ring[2 * i]
      const az = ring[2 * i + 1]
      const bx = ring[2 * j]
      const bz = ring[2 * j + 1]
      const dx = bx - ax
      const dz = bz - az
      const len = Math.hypot(dx, dz)
      if (len < 1e-6 || skip?.(ax, az, bx, bz)) continue
      // positive-shoelace ring in (x east, z north): outward normal of edge a->b is (dz, -dx)
      const nx = (dz / len) * outward
      const nz = (-dx / len) * outward
      // Directional lighting comes from the scene; vertex color only modulates the material.
      const k = shade
      const cc: RGB = [c[0] * k, c[1] * k, c[2] * k]
      const u = len / this.textureMetres[0]
      const low = y0 / this.textureMetres[1], high = y1 / this.textureMetres[1]
      const v0 = this.vertex(ax, y0, az, nx, 0, nz, cc, 0, low)
      const v1 = this.vertex(bx, y0, bz, nx, 0, nz, cc, u, low)
      const v2 = this.vertex(bx, y1, bz, nx, 0, nz, cc, u, high)
      const v3 = this.vertex(ax, y1, az, nx, 0, nz, cc, 0, high)
      // Babylon front face: (v1-v0)x(v2-v0) points *against* the outward normal
      if (outward > 0) this.indices.push(v0, v1, v2, v0, v2, v3)
      else this.indices.push(v0, v2, v1, v0, v3, v2)
    }
  }

  /** Extruded footprint: walls + roof. */
  extrude(ring: Flat, holes: Flat[] | undefined, y0: number, y1: number, wall: RGB, roof: RGB): void {
    this.walls(ring, holes, y0, y1, wall)
    this.polygon(ring, holes, y1, roof)
  }

  /** Constant-width ribbon along a polyline at height y (roads, rail, trails). */
  ribbon(shape: Flat, width: number, y: number, c: RGB): void {
    const n = shape.length / 2
    if (n < 2) return
    const hw = width / 2
    const base = this.vertexCount
    let emitted = 0
    for (let i = 0; i < n; i++) {
      const px = shape[2 * i]
      const pz = shape[2 * i + 1]
      // direction: average of incoming and outgoing segment directions (mitred)
      let dx = 0
      let dz = 0
      if (i > 0) {
        const l = Math.hypot(px - shape[2 * i - 2], pz - shape[2 * i - 1]) || 1
        dx += (px - shape[2 * i - 2]) / l
        dz += (pz - shape[2 * i - 1]) / l
      }
      if (i < n - 1) {
        const l = Math.hypot(shape[2 * i + 2] - px, shape[2 * i + 3] - pz) || 1
        dx += (shape[2 * i + 2] - px) / l
        dz += (shape[2 * i + 3] - pz) / l
      }
      const l = Math.hypot(dx, dz)
      if (l < 1e-6) continue
      dx /= l
      dz /= l
      // mitre length correction, clamped so hairpins do not explode
      let m = 1
      if (i > 0 && i < n - 1) {
        const l0 = Math.hypot(px - shape[2 * i - 2], pz - shape[2 * i - 1]) || 1
        const ux = (px - shape[2 * i - 2]) / l0
        const uz = (pz - shape[2 * i - 1]) / l0
        const cos = ux * dx + uz * dz
        m = Math.min(2, 1 / Math.max(0.5, cos))
      }
      const ox = -dz * hw * m
      const oz = dx * hw * m
      this.vertex(px + ox, y, pz + oz, 0, 1, 0, c)
      this.vertex(px - ox, y, pz - oz, 0, 1, 0, c)
      emitted++
    }
    for (let i = 0; i < emitted - 1; i++) {
      const a = base + 2 * i
      this.indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }

  /** Flat disc (n-gon) facing up, e.g. junction caps and stop pads. */
  disc(x: number, z: number, r: number, y: number, c: RGB, segments = 10): void {
    const centre = this.vertex(x, y, z, 0, 1, 0, c)
    const first = this.vertexCount
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2
      this.vertex(x + Math.cos(a) * r, y, z + Math.sin(a) * r, 0, 1, 0, c)
    }
    for (let i = 0; i < segments; i++) {
      this.indices.push(centre, first + i, first + ((i + 1) % segments))
    }
  }

  /** Solid of revolution around a vertical axis: profile = [[radius, y], ...] bottom to top. */
  lathe(x: number, z: number, profile: [number, number][], c: RGB, segments = 24, shade = 0.9): void {
    if (profile.length < 2) return
    for (let j = 0; j < profile.length - 1; j++) {
      const [r0, y0] = profile[j], [r1, y1] = profile[j + 1]
      const length = Math.hypot(y1 - y0, r0 - r1)
      if (length < 1e-6) continue
      const radial = (y1 - y0) / length, ny = (r0 - r1) / length
      const base = this.vertexCount
      for (let i = 0; i <= segments; i++) {
        const a = (i / segments) * Math.PI * 2
        const nx = Math.cos(a), nz = Math.sin(a)
        for (const [r, y] of [[r0, y0], [r1, y1]]) {
          this.vertex(x + nx * r, y, z + nz * r, nx * radial, ny, nz * radial, scale(c, shade), (a * r) / this.textureMetres[0], y / this.textureMetres[1])
        }
      }
      for (let i = 0; i < segments; i++) {
        const a = base + i * 2
        this.indices.push(a, a + 2, a + 1, a + 2, a + 3, a + 1)
      }
    }
    // cap the top
    const top = profile[profile.length - 1]
    if (top[0] > 0.01) this.disc(x, z, top[0], top[1], c, segments)
  }

  isEmpty(): boolean {
    return this.indices.length === 0
  }
}

export function flatten(ring: Flat, holes?: Flat[]): { verts: number[]; holeIdx: number[] } {
  const verts = dedupeClosing(ring)
  const holeIdx: number[] = []
  if (holes) {
    for (const h of holes) {
      const hv = dedupeClosing(h)
      if (hv.length < 6) continue
      holeIdx.push(verts.length / 2)
      for (const v of hv) verts.push(v)
    }
  }
  return { verts, holeIdx }
}

function dedupeClosing(ring: Flat): number[] {
  const n = ring.length
  if (n >= 4 && ring[0] === ring[n - 2] && ring[1] === ring[n - 1]) return ring.slice(0, n - 2)
  return ring.slice()
}

export function signedArea(ring: Flat): number {
  let a = 0
  const n = ring.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    a += ring[2 * i] * ring[2 * j + 1] - ring[2 * j] * ring[2 * i + 1]
  }
  return a / 2
}

export function centroid(ring: Flat): [number, number] {
  let x = 0
  let z = 0
  const n = ring.length / 2
  for (let i = 0; i < n; i++) {
    x += ring[2 * i]
    z += ring[2 * i + 1]
  }
  return [x / n, z / n]
}

export function bounds(ring: Flat): [number, number, number, number] {
  let x0 = Infinity
  let z0 = Infinity
  let x1 = -Infinity
  let z1 = -Infinity
  for (let i = 0; i < ring.length; i += 2) {
    x0 = Math.min(x0, ring[i])
    x1 = Math.max(x1, ring[i])
    z0 = Math.min(z0, ring[i + 1])
    z1 = Math.max(z1, ring[i + 1])
  }
  return [x0, z0, x1, z1]
}

/** Deterministic per-id jitter in [0, 1) so buildings get stable colour variation. */
export function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 10000) / 10000
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

export function scale(c: RGB, k: number): RGB {
  return [c[0] * k, c[1] * k, c[2] * k]
}
