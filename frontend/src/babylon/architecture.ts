import { Batch, bounds, centroid, hash01, mix, scale, signedArea, type RGB } from './geometry'
import { pointInRing, interiorBox } from './details'
import type { WorldBuilding, Flat } from './worldData'

export interface BuildingBatches { facade: Batch; roof: Batch; stone: Batch; glass: Batch; metal: Batch }

/** A setback must remain inside the source footprint, including concave lots and courtyards. */
export function setback(ring: Flat, holes: Flat[] | undefined, factor: number): Flat | null {
  if (holes?.length || ring.length < 6 || factor <= 0 || factor >= 1) return null
  let turn = 0
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length, k = (i + 4) % ring.length
    const cross = (ring[j] - ring[i]) * (ring[k + 1] - ring[j + 1]) - (ring[j + 1] - ring[i + 1]) * (ring[k] - ring[j])
    if (Math.abs(cross) < 1e-6) continue
    if (turn && Math.sign(cross) !== turn) return null
    turn = Math.sign(cross)
  }
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
  const reconciled = b.roofs !== undefined || Boolean(b.source_id)
  const height = reconciled ? b.h : Math.max(3, b.h)
  const base = 0.3 + Math.max(0, b.base ?? 0), top = base + height
  const seed = hash01(b.source_id ?? b.id), tall = (b.source_height ?? b.h) > 48
  const area = Math.abs(signedArea(b.ring))
  const embellish = detailed && !reconciled && !(b.base && b.base > 0)
  let tower = b.ring
  const podium = !reconciled && !b.base && tall && area > 450 ? setback(b.ring, b.holes, 0.78 + seed * 0.11) : null
  const podiumTop = base + Math.min(height * 0.27, 17 + seed * 9)
  if (podium) {
    out.facade.walls(b.ring, b.holes, base, podiumTop, mix(c.wall, [0.84, 0.81, 0.73], 0.35), 1)
    out.roof.polygon(b.ring, [podium], podiumTop, [0.73, 0.72, 0.66])
    tower = podium
  }
  const slab: RGB = b.cat === 'apartments' || b.cat === 'hotel' ? [0.81, 0.81, 0.75] : mix(c.wall, [0.89, 0.87, 0.8], 0.45)
  // At city scale a few real edges make the textured elevations feel solid.
  const floorStep = b.cat === 'apartments' || b.cat === 'hotel' ? 3.4 : 13.6
  let wallStart = podium ? podiumTop : base
  if (embellish && height > 18 && height < 250) {
    for (let y = wallStart + floorStep; y < top - 2; y += floorStep) {
      out.facade.walls(tower, b.holes, wallStart, y, c.wall, 1)
      wallStart = y + (floorStep < 4 ? 0.28 : 0.5)
      out.stone.walls(tower, b.holes, y, wallStart, slab, 1)
    }
  }
  out.facade.walls(tower, b.holes, wallStart, top, c.wall, 1)
  const roofAreas = b.roofs ?? [{ ring: tower, holes: b.holes }]
  for (const roof of roofAreas) out.roof.polygon(roof.ring, roof.holes, top, c.roof)
  const crown = embellish && tall ? setback(tower, b.holes, seed > 0.5 ? 0.73 : 0.89) : null
  const crownHeight = crown ? 2.5 + seed * 5 : 0
  if (crown) out.metal.extrude(crown, undefined, top, top + crownHeight, scale(c.wall, 0.78), c.roof)
  const equipmentAreas = crown ? [{ ring: crown, holes: undefined }] : roofAreas
  const equipmentTop = top + crownHeight
  if ((b.source_height ?? b.h) > 8 && roofAreas.length) {
    if (!reconciled) out.stone.walls(tower, b.holes, top, top + 0.65, scale(c.wall, 1.12), 1)
    // a slim rooftop plant box reads as "tower" at miniature scale
    const roofBox = equipmentAreas.map(roof => interiorBox(roof, tall ? 3.8 : 1.5)).find(Boolean)
    if (roofBox) {
      out.metal.extrude(roofBox, undefined, equipmentTop, equipmentTop + (tall ? 4.8 : 1.4), [0.46, 0.48, 0.45], [0.67, 0.69, 0.66])
      if (detailed) {
        const [x, z] = centroid(roofBox)
        out.metal.lathe(x, z, [[tall ? 1.9 : 0.7, equipmentTop + (tall ? 4.8 : 1.4)], [tall ? 1.9 : 0.7, equipmentTop + (tall ? 5.2 : 1.65)]], [0.28, 0.31, 0.3], 12, 1)
      }
    }
  }
  if (!embellish) return
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
        out.glass.walls(pane, undefined, base + 0.6, base + 4.2, [0.58, 0.66, 0.65], 1)
        if (b.h < 28 && k % 2 === 0) out.stone.ribbon(pane, 1.5, base + 4.4, seed > 0.5 ? [0.35, 0.42, 0.36] : [0.55, 0.28, 0.22])
      }
    }
  }
  const equipmentRing = crown ?? tower
  const [x0, z0, x1, z1] = bounds(equipmentRing)
  if (b.h > 15 && x1 - x0 > 18 && z1 - z0 > 18 && !b.holes?.length) {
    const little = interiorBox({ ring: equipmentRing }, Math.min(5, (x1 - x0) * 0.1))
    if (little) {
      const [cx, cz] = centroid(little)
      // Offset rooftop units remain inside the roof; never stretch over a courtyard.
      for (const dx of [-6, 6]) {
        const box = [cx + dx - 1.3, cz - 1.8, cx + dx + 1.3, cz - 1.8, cx + dx + 1.3, cz + 1.8, cx + dx - 1.3, cz + 1.8]
        if (box.every((_, i) => i % 2 || pointInRing(box[i], box[i + 1], equipmentRing))) out.metal.extrude(box, undefined, equipmentTop, equipmentTop + 1.1, [0.52, 0.55, 0.54], [0.74, 0.75, 0.72])
      }
    }
  }
}
