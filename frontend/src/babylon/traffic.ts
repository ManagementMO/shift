// Replay-driven traffic: buses, cars and people as thin instances.  One prototype mesh per body part, one
// matrix buffer per kind, refilled every frame from the recorded SUMO tracks.  Nothing here moves on its
// own — a vehicle is exactly where TraCI measured it (linearly blended between two 1 s samples), it points
// where SUMO said it pointed, and it vanishes when the record stops.

import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import '@babylonjs/core/Meshes/thinInstanceMesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import type { CascadedShadowGenerator } from '@babylonjs/core/Lights/Shadows/cascadedShadowGenerator'
import type { Scene } from '@babylonjs/core/scene'

import { personStateAt, STATE_COLORS, type PersonState, type ReplayIndex, type TrackIndex } from '../replay'
import { PALETTE, Y } from './city'
import type { WorldFrame } from './coords'
import { activeReleases, lodFor, pulse, releasesFrom, type Release } from './crowd'
import { Batch, hash01, type RGB } from './geometry'
import { interpAt, type Interp } from './interp'

export type Kind = 'bus' | 'car' | 'person'
/** Prototype sets: entity kinds plus the far-LOD pedestrian marker and the venue release ring. */
type SetKind = Kind | 'marker' | 'pulse'

const CAR_PALETTE: RGB[] = [
  [0.86, 0.87, 0.89], // white
  [0.72, 0.74, 0.78], // silver
  [0.2, 0.22, 0.26], // graphite
  [0.12, 0.13, 0.16], // black
  [0.55, 0.13, 0.16], // maroon
  [0.2, 0.32, 0.58], // blue
  [0.6, 0.62, 0.64], // grey
  [0.82, 0.78, 0.66], // champagne
  [0.16, 0.36, 0.3], // green
]
const BUS_RED: RGB = [0.8, 0.09, 0.16]
const PULSE_COLOR: RGB = [1.0, 0.62, 0.2]

const GLASS: RGB = [0.16, 0.2, 0.26]
const TYRE: RGB = [0.08, 0.08, 0.09]
const SKIN: RGB = [0.87, 0.72, 0.6]

function mix(a: RGB, b: RGB, k: number): RGB {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

/** Flat annulus on the ground, outer radius `r`, band width `w`. */
function ring(b: Batch, r: number, w: number, y: number, c: RGB, segments = 24): void {
  const outer: number[] = []
  const inner: number[] = []
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2
    outer.push(Math.cos(a) * r, Math.sin(a) * r)
    inner.push(Math.cos(a) * (r - w), Math.sin(a) * (r - w))
  }
  b.polygon(outer, [inner], y, c)
}

/** Local space: +z forward, +y up, origin on the ground at the body centre. */
function box(b: Batch, cx: number, y0: number, cz: number, sx: number, sy: number, sz: number, c: RGB): void {
  const x0 = cx - sx / 2
  const x1 = cx + sx / 2
  const z0 = cz - sz / 2
  const z1 = cz + sz / 2
  const y1 = y0 + sy
  const quad = [x0, z0, x1, z0, x1, z1, x0, z1]
  b.polygon(quad, undefined, y1, c)
  b.walls(quad, undefined, y0, y1, c, 1)
}

interface Part {
  mesh: Mesh
  perInstanceColor: boolean
}

class InstanceSet {
  readonly parts: Part[] = []
  readonly scene: Scene
  matrices = new Float32Array(0)
  colors = new Float32Array(0)
  capacity = 0
  count = 0

  constructor(
    scene: Scene,
    name: string,
    build: (b: Batch) => void,
    trim: ((b: Batch) => void) | null,
    shadows: CascadedShadowGenerator | null,
  ) {
    this.scene = scene
    this.parts.push({ mesh: this.make(`${name}-body`, build, true, shadows), perInstanceColor: true })
    if (trim) this.parts.push({ mesh: this.make(`${name}-trim`, trim, false, null), perInstanceColor: false })
  }

  private make(name: string, build: (b: Batch) => void, perInstanceColor: boolean, shadows: CascadedShadowGenerator | null): Mesh {
    const b = new Batch()
    build(b)
    const mesh = new Mesh(name, this.scene)
    const vd = new VertexData()
    vd.positions = new Float32Array(b.positions)
    vd.normals = new Float32Array(b.normals)
    if (!perInstanceColor) vd.colors = new Float32Array(b.colors)
    vd.indices = new Uint16Array(b.indices)
    vd.applyToMesh(mesh, false)
    const m = new StandardMaterial(`${name}-mat`, this.scene)
    m.diffuseColor = Color3.White()
    m.ambientColor = new Color3(0.9, 0.9, 0.9)
    m.specularColor = new Color3(0.25, 0.25, 0.25)
    m.specularPower = 48
    mesh.material = m
    mesh.isPickable = false
    mesh.alwaysSelectAsActiveMesh = true // instances span the city; skip per-mesh frustum culling
    mesh.doNotSyncBoundingInfo = true
    mesh.thinInstanceEnablePicking = false
    mesh.setEnabled(false)
    if (shadows) shadows.addShadowCaster(mesh)
    return mesh
  }

  reserve(n: number): void {
    if (n <= this.capacity) return
    this.capacity = Math.max(n, Math.ceil(this.capacity * 1.5), 16)
    this.matrices = new Float32Array(this.capacity * 16)
    this.colors = new Float32Array(this.capacity * 4)
    for (const p of this.parts) {
      p.mesh.thinInstanceSetBuffer('matrix', this.matrices, 16, false)
      if (p.perInstanceColor) p.mesh.thinInstanceSetBuffer('color', this.colors, 4, false)
    }
  }

  /** Write instance `i`: yaw in radians (clockwise from +z when seen from above), position (x, y, z), uniform scale. */
  set(i: number, x: number, y: number, z: number, yaw: number, c: RGB, scale = 1): void {
    const m = this.matrices
    const o = i * 16
    const cs = Math.cos(yaw) * scale
    const sn = Math.sin(yaw) * scale
    m[o] = cs
    m[o + 1] = 0
    m[o + 2] = -sn
    m[o + 3] = 0
    m[o + 4] = 0
    m[o + 5] = scale
    m[o + 6] = 0
    m[o + 7] = 0
    m[o + 8] = sn
    m[o + 9] = 0
    m[o + 10] = cs
    m[o + 11] = 0
    m[o + 12] = x
    m[o + 13] = y
    m[o + 14] = z
    m[o + 15] = 1
    const k = i * 4
    this.colors[k] = c[0]
    this.colors[k + 1] = c[1]
    this.colors[k + 2] = c[2]
    this.colors[k + 3] = 1
  }

  commit(count: number): void {
    this.count = count
    for (const p of this.parts) {
      p.mesh.setEnabled(count > 0)
      if (count === 0) continue
      p.mesh.thinInstanceCount = count
      p.mesh.thinInstanceBufferUpdated('matrix')
      if (p.perInstanceColor) p.mesh.thinInstanceBufferUpdated('color')
    }
  }

  dispose(): void {
    for (const p of this.parts) {
      p.mesh.material?.dispose()
      p.mesh.dispose()
    }
  }
}

interface Entity {
  id: string
  ix: TrackIndex
  kind: Kind
  color: RGB
  yaw: number
  /** last world position, used for pedestrian heading (SUMO reports angle 0 for persons) */
  px: number
  pz: number
  seen: boolean
}

export interface TrafficStats {
  buses: number
  cars: number
  people: number
  /** travellers whose recorded depart time has passed */
  released: number
}

/** Where the crowd is being looked at from: drives pedestrian LOD only, never positions. */
export interface Viewpoint {
  x: number
  y: number
  z: number
  radius: number
}

export class Traffic {
  readonly scene: Scene
  readonly frame: WorldFrame
  private sets: Record<SetKind, InstanceSet>
  private entities: Entity[] = []
  private releases: Release[] = []
  private rx: ReplayIndex | null = null
  private scratch: Interp = { lon: 0, lat: 0, angle: 0, speed: 0, i: -1, k: 0 }
  stats: TrafficStats = { buses: 0, cars: 0, people: 0, released: 0 }

  constructor(scene: Scene, frame: WorldFrame, shadows: CascadedShadowGenerator | null) {
    this.scene = scene
    this.frame = frame
    this.sets = {
      bus: new InstanceSet(
        scene,
        'bus',
        (b) => {
          box(b, 0, 0.55, 0, 2.55, 2.75, 12.0, BUS_RED)
          box(b, 0, 3.3, 0, 2.3, 0.18, 11.4, BUS_RED) // roof pods
        },
        (b) => {
          box(b, 0, 1.7, 0, 2.6, 1.05, 12.05, GLASS) // window band
          box(b, 0, 1.4, 6.02, 2.3, 1.6, 0.06, GLASS) // windscreen
          for (const z of [-3.6, 3.6]) for (const x of [-1.1, 1.1]) box(b, x, 0, z, 0.35, 1.0, 1.0, TYRE)
        },
        shadows,
      ),
      car: new InstanceSet(
        scene,
        'car',
        (b) => {
          box(b, 0, 0.32, 0, 1.8, 0.62, 4.4, CAR_PALETTE[0])
          box(b, 0, 0.94, -0.3, 1.6, 0.5, 2.3, CAR_PALETTE[0]) // cabin
        },
        (b) => {
          box(b, 0, 0.98, -0.3, 1.64, 0.36, 2.34, GLASS) // glasshouse
          for (const z of [-1.4, 1.4]) for (const x of [-0.8, 0.8]) box(b, x, 0, z, 0.24, 0.64, 0.64, TYRE)
        },
        shadows,
      ),
      person: new InstanceSet(
        scene,
        'person',
        (b) => {
          box(b, 0, 0, 0, 0.42, 1.45, 0.28, SKIN) // body
        },
        (b) => {
          box(b, 0, 1.45, 0, 0.26, 0.28, 0.26, SKIN) // head
        },
        null,
      ),
      marker: new InstanceSet(scene, 'crowd-marker', (b) => b.disc(0, 0, 1.5, 0.06, SKIN, 8), null, null),
      pulse: new InstanceSet(scene, 'release-pulse', (b) => ring(b, 1, 0.12, 0.05, SKIN), null, null),
    }
  }

  setReplay(rx: ReplayIndex | null): void {
    this.rx = rx
    this.entities = []
    if (!rx) {
      for (const s of Object.values(this.sets)) s.commit(0)
      return
    }
    const counts: Record<Kind, number> = { bus: 0, car: 0, person: 0 }
    for (const [id, ix] of Object.entries(rx.tracks)) {
      const kind = ix.track.kind
      counts[kind]++
      const color: RGB =
        kind === 'bus' ? BUS_RED : kind === 'car' ? CAR_PALETTE[Math.floor(hash01(id) * CAR_PALETTE.length)] : STATE_COLORS.walking.map((v) => v / 255) as RGB
      this.entities.push({ id, ix, kind, color, yaw: 0, px: 0, pz: 0, seen: false })
    }
    for (const k of Object.keys(counts) as Kind[]) this.sets[k].reserve(counts[k])
    this.sets.marker.reserve(counts.person)
    this.releases = releasesFrom(rx, this.frame)
    this.sets.pulse.reserve(64)
  }

  /** Sim time by which fraction `q` (0..1) of recorded departs have happened, or null with no replay. */
  releaseQuantile(q: number): number | null {
    const n = this.releases.length
    if (!n) return null
    const i = Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))))
    return this.releases[i].t
  }

  /** Mean position of the recorded release points (where SUMO put travellers as they left). */
  releaseCentroid(): [number, number] | null {
    if (!this.releases.length) return null
    let x = 0
    let z = 0
    for (const r of this.releases) {
      x += r.x
      z += r.z
    }
    return [x / this.releases.length, z / this.releases.length]
  }

  /** Place every entity for sim time `t`, choosing pedestrian detail from the viewpoint. */
  update(t: number, view: Viewpoint): void {
    const rx = this.rx
    if (!rx) return
    const n: Record<SetKind, number> = { bus: 0, car: 0, person: 0, marker: 0, pulse: 0 }
    const modes = rx.bundle.compile?.mode_assignment ?? {}
    const s = this.scratch
    let people = 0
    for (const e of this.entities) {
      const r = interpAt(e.ix, t, s)
      if (!r) {
        e.seen = false
        continue
      }
      let color = e.color
      let y = Y.road
      if (e.kind === 'person') {
        const state: PersonState = personStateAt(rx.personEvents[e.id], t, modes[e.id])
        if (state === 'riding' || state === 'arrived' || state === 'not_departed') {
          e.seen = false
          continue
        }
        color = stateColor(state)
        y = Y.path
      }
      const [x, z] = this.frame.lonLatToWorld(r.lon, r.lat)
      if (e.kind === 'person') {
        // SUMO reports angle 0 for pedestrians: face the direction of measured travel, keep facing when still.
        if (e.seen) {
          const dx = x - e.px
          const dz = z - e.pz
          if (dx * dx + dz * dz > 0.01) e.yaw = Math.atan2(dx, dz)
        }
      } else {
        e.yaw = (r.angle * Math.PI) / 180
      }
      e.px = x
      e.pz = z
      e.seen = true
      let set: SetKind = e.kind
      if (e.kind === 'person') {
        people++
        const d = Math.hypot(x - view.x, view.y, z - view.z)
        if (lodFor(d, view.radius) === 'marker') set = 'marker'
      }
      this.sets[set].set(n[set]++, x, y, z, e.yaw, color)
    }
    const live = activeReleases(this.releases, t)
    this.sets.pulse.reserve(live.length)
    for (const r of live) {
      const p = pulse(t - r.t)
      if (!p) continue
      this.sets.pulse.set(n.pulse++, r.x, Y.junction + 0.1, r.z, 0, mix(PULSE_COLOR, PALETTE.pavement, 1 - p.fade), p.radius)
    }
    for (const k of Object.keys(n) as SetKind[]) this.sets[k].commit(n[k])
    let released = 0
    for (const r of this.releases) {
      if (r.t > t) break
      released++
    }
    this.stats = { buses: n.bus, cars: n.car, people, released }
  }

  /** Last drawn world pose of an entity (for follow cameras / inspection); null if unknown or not visible. */
  poseOf(id: string): { x: number; z: number; yaw: number; kind: Kind } | null {
    const e = this.entities.find((v) => v.id === id)
    return e && e.seen ? { x: e.px, z: e.pz, yaw: e.yaw, kind: e.kind } : null
  }

  dispose(): void {
    for (const s of Object.values(this.sets)) s.dispose()
  }
}

const STATE_RGB: Record<PersonState, RGB> = Object.fromEntries(
  Object.entries(STATE_COLORS).map(([k, v]) => [k, v.map((c) => c / 255) as RGB]),
) as Record<PersonState, RGB>

function stateColor(s: PersonState): RGB {
  return STATE_RGB[s]
}
