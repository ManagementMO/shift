// WorldRoad <-> SUMO edge mapping.  Every visible road ribbon *is* a SUMO edge (world.json is compiled from
// the .net.xml), so the mapping is the edge id itself; this index adds the two lookups the world needs:
// edge id -> WorldRoad (closures, rerouters, selection highlight) and world (x,z) -> nearest edge (what a
// replayed vehicle or a click is on).  Positions are matched against the centre-line, never snapped:
// a vehicle is drawn where SUMO measured it, and the index only names the edge under it.

import type { WorldData, WorldRoad } from './worldData'

export interface RoadHit {
  road: WorldRoad
  /** Perpendicular distance from the query point to the centre-line, metres. */
  dist: number
  /** Distance along the centre-line from the edge start, metres (≈ SUMO lanePosition). */
  s: number
  /** Heading of the centre-line at the hit, degrees clockwise from north. */
  heading: number
}

const CELL = 40

export class RoadIndex {
  readonly byId = new Map<string, WorldRoad>()
  private cells = new Map<number, number[]>() // cell key -> segment ids
  private segs: Float64Array // x0 z0 x1 z1 per segment
  private segRoad: Int32Array
  private segS0: Float64Array
  private roads: WorldRoad[]

  constructor(world: Pick<WorldData, 'roads'>, filter: (r: WorldRoad) => boolean = () => true) {
    this.roads = world.roads.filter(filter)
    let n = 0
    for (const r of this.roads) n += Math.max(0, r.shape.length / 2 - 1)
    this.segs = new Float64Array(n * 4)
    this.segRoad = new Int32Array(n)
    this.segS0 = new Float64Array(n)
    let k = 0
    this.roads.forEach((r, ri) => {
      this.byId.set(r.id, r)
      let s = 0
      for (let i = 0; i + 3 < r.shape.length; i += 2) {
        const x0 = r.shape[i]
        const z0 = r.shape[i + 1]
        const x1 = r.shape[i + 2]
        const z1 = r.shape[i + 3]
        this.segs[4 * k] = x0
        this.segs[4 * k + 1] = z0
        this.segs[4 * k + 2] = x1
        this.segs[4 * k + 3] = z1
        this.segRoad[k] = ri
        this.segS0[k] = s
        s += Math.hypot(x1 - x0, z1 - z0)
        this.bin(k, x0, z0, x1, z1)
        k++
      }
    })
  }

  private bin(seg: number, x0: number, z0: number, x1: number, z1: number): void {
    const cx0 = Math.floor(Math.min(x0, x1) / CELL)
    const cx1 = Math.floor(Math.max(x0, x1) / CELL)
    const cz0 = Math.floor(Math.min(z0, z1) / CELL)
    const cz1 = Math.floor(Math.max(z0, z1) / CELL)
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const key = cellKey(cx, cz)
        let list = this.cells.get(key)
        if (!list) this.cells.set(key, (list = []))
        list.push(seg)
      }
    }
  }

  /** Nearest edge within `radius` metres of (x, z), or null. */
  nearest(x: number, z: number, radius = 12): RoadHit | null {
    const r = Math.ceil(radius / CELL)
    const cx = Math.floor(x / CELL)
    const cz = Math.floor(z / CELL)
    let best: RoadHit | null = null
    let bestD = radius
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const list = this.cells.get(cellKey(cx + dx, cz + dz))
        if (!list) continue
        for (const k of list) {
          const x0 = this.segs[4 * k]
          const z0 = this.segs[4 * k + 1]
          const x1 = this.segs[4 * k + 2]
          const z1 = this.segs[4 * k + 3]
          const vx = x1 - x0
          const vz = z1 - z0
          const len2 = vx * vx + vz * vz
          const u = len2 > 0 ? Math.max(0, Math.min(1, ((x - x0) * vx + (z - z0) * vz) / len2)) : 0
          const px = x0 + vx * u
          const pz = z0 + vz * u
          const d = Math.hypot(x - px, z - pz)
          if (d < bestD) {
            bestD = d
            best = {
              road: this.roads[this.segRoad[k]],
              dist: d,
              s: this.segS0[k] + Math.sqrt(len2) * u,
              heading: ((Math.atan2(vx, vz) * 180) / Math.PI + 360) % 360,
            }
          }
        }
      }
    }
    return best
  }

  get size(): number {
    return this.roads.length
  }
}

function cellKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768)
}
