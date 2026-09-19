import { Batch, bounds, centroid, hash01, mix, scale, signedArea, type RGB } from './geometry'
import { pointInRing, interiorBox } from './details'
import type { WorldBuilding, Flat } from './worldData'

export interface BuildingBatches { facade: Batch; roof: Batch; stone: Batch; glass: Batch; metal: Batch }

/** A setback must remain inside the source footprint, including concave lots and courtyards. */
export function setback(ring: Flat, holes: Flat[] | undefined, factor: number): Flat | null {
  if (holes?.length) return null
  const [cx, cz] = centroid(ring)
  if (!pointInRing(cx, cz, ring)) return null
  const inset = ring.map((v, i) => (i % 2 ? cz : cx) + (v - (i % 2 ? cz : cx)) * factor)
  for (let i = 0; i < inset.length; i += 2) {
    const j = (i + 2) % inset.length
    for (const t of [0, 0.25, 0.5, 0.75]) {
      if (!pointInRing(inset[i] + (inset[j] - inset[i]) * t, inset[i + 1] + (inset[j + 1] - inset[i + 1]) * t, ring)) return null
    }
  }
  return inset
}

export function addArchitecture(out: BuildingBatches, b: WorldBuilding, c: { wall: RGB; roof: RGB }, detailed: boolean): void {
  const base = 0.3, top = base + Math.max(3, b.h)
  const seed = hash01(b.id), tall = b.h > 48
  const area = Math.abs(signedArea(b.ring))
  let tower = b.ring
  const podium = tall && area > 450 ? setback(b.ring, b.holes, 0.78 + seed * 0.11) : null
  const podiumTop = Math.min(top * 0.27, 17 + seed * 9)
  if (podium) {
    out.facade.walls(b.ring, b.holes, base, podiumTop, mix(c.wall, [0.84, 0.81, 0.73], 0.35), 1)
    out.roof.polygon(b.ring, [podium], podiumTop, [0.73, 0.72, 0.66])
    tower = podium
    out.facade.walls(tower, undefined, podiumTop, top, c.wall, 1)
  } else out.facade.walls(tower, b.holes, base, top, c.wall, 1)
  out.roof.polygon(tower, b.holes, top, c.roof)
  if (b.h > 8) {
    out.stone.walls(tower, b.holes, top, top + 0.65, scale(c.wall, 1.12), 1)
    const roofBox = interiorBox({ ring: tower, holes: b.holes }, tall ? 3.8 : 1.5)
    if (roofBox) {
      out.metal.extrude(roofBox, undefined, top, top + (tall ? 4.8 : 1.4), [0.46, 0.48, 0.45], [0.67, 0.69, 0.66])
      if (detailed) {
        const [x, z] = centroid(roofBox)
        out.metal.lathe(x, z, [[tall ? 1.9 : 0.7, top + (tall ? 4.8 : 1.4)], [tall ? 1.9 : 0.7, top + (tall ? 5.2 : 1.65)]], [0.28, 0.31, 0.3], 12, 1)
      }
    }
  }
  if (!detailed) return
  const slab: RGB = b.cat === 'apartments' || b.cat === 'hotel' ? [0.81, 0.81, 0.75] : mix(c.wall, [0.89, 0.87, 0.8], 0.45)
  // At city scale a few real edges make the textured elevations feel solid.
  const floorStep = b.cat === 'apartments' || b.cat === 'hotel' ? 3.4 : 13.6
  if (b.h > 18 && b.h < 250) {
    for (let y = podium ? podiumTop + floorStep : base + floorStep; y < top - 2; y += floorStep) {
      out.stone.walls(tower, undefined, y, y + (floorStep < 4 ? 0.28 : 0.5), slab, 1)
    }
  }
  if (tall) {
    const crown = setback(tower, undefined, seed > 0.5 ? 0.73 : 0.89)
    if (crown) out.metal.extrude(crown, undefined, top + 0.1, top + 2.5 + seed * 5, scale(c.wall, 0.78), c.roof)
  }
  // Shopfront glazing and stone piers, fitted to the original footprint edges.
  if (area > 100 && b.h > 8) {
    for (let i = 0; i < b.ring.length; i += 2) {
      const j = (i + 2) % b.ring.length
      const ax = b.ring[i], az = b.ring[i + 1], dx = b.ring[j] - ax, dz = b.ring[j + 1] - az
      const len = Math.hypot(dx, dz)
      if (len < 9 || len > 130) continue
      const nx = (signedArea(b.ring) > 0 ? dz : -dz) / len * 0.07
      const nz = (signedArea(b.ring) > 0 ? -dx : dx) / len * 0.07
      const n = Math.floor(len / 6)
      for (let k = 0; k < n; k++) {
        const t0 = (k + 0.14) / n, t1 = (k + 0.86) / n
        const pane = [ax + dx * t0 + nx, az + dz * t0 + nz, ax + dx * t1 + nx, az + dz * t1 + nz]
        out.glass.walls(pane, undefined, 0.9, 4.5, [0.58, 0.66, 0.65], 1)
        if (b.h < 28 && k % 2 === 0) {
          out.stone.ribbon(pane, 1.5, 4.7, seed > 0.5 ? [0.35, 0.42, 0.36] : [0.55, 0.28, 0.22])
        }
      }
    }
  }
  const [x0, z0, x1, z1] = bounds(tower)
  if (b.h > 15 && x1 - x0 > 18 && z1 - z0 > 18) {
    const little = interiorBox({ ring: tower, holes: b.holes }, Math.min(5, (x1 - x0) * 0.1))
    if (little) {
      const [cx, cz] = centroid(little)
      // Offset rooftop units remain inside the roof; never stretch over a courtyard.
      for (const dx of [-6, 6]) {
        const box = [cx + dx - 1.3, cz - 1.8, cx + dx + 1.3, cz - 1.8, cx + dx + 1.3, cz + 1.8, cx + dx - 1.3, cz + 1.8]
        if (box.every((_, i) => i % 2 || (pointInRing(box[i], box[i + 1], tower) && !b.holes?.some(h => pointInRing(box[i], box[i + 1], h))))) out.metal.extrude(box, undefined, top, top + 1.1, [0.52, 0.55, 0.54], [0.74, 0.75, 0.72])
      }
    }
  }
}
