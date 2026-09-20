// Replay-driven traffic: buses, cars and people as thin instances.  One prototype mesh per body part, one
// matrix buffer per kind, refilled every frame from the recorded SUMO tracks.  Nothing here moves on its
// own — a vehicle is exactly where TraCI measured it (linearly blended between two 1 s samples), it points
// where SUMO said it pointed, and it vanishes when the record stops.

import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import '@babylonjs/core/Meshes/thinInstanceMesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import type { Scene } from '@babylonjs/core/scene'

import { MAX_GAP_S, personStateAt, STATE_COLORS, type PersonState, type ReplayIndex, type TrackIndex } from '../replay'
import { NEUTRAL_BRAIN_COLOR, populationColorAt, populationTrackVisible, stationaryPresenceAt } from '../population'
import type { EntityTrack } from '../types'
import { awareLevel, FLAG_FRESH } from '../live/flags'
import { PALETTE, Y } from './city'
import type { WorldFrame } from './coords'
import { activeReleases, lodFor, pulse, releasesFrom, type Release } from './crowd'
import { alertTint, buildCar, buildCarTrim, buildFigure, buildHead, buildMarker, farBoost, FIGURE_POSES, poseFor, vehicleScale, type Pose } from './figures'
import { Batch, hash01, type RGB } from './geometry'
import { interpAt, type Interp } from './interp'

export type Kind = EntityTrack['kind']
export interface LiveTrafficSource {
  entity(index: number): { id: string; kind: Kind } | undefined
  releasedAt(t: number): number
  forEachAt(t: number, visit: (index: number, x: number, z: number, heading: number, speed: number, kind: number, state: number, flags: number) => void): boolean
}
/** Prototype sets: entity kinds plus the far-LOD pedestrian marker and the venue release ring. */
/** Prototype sets: vehicles, one pedestrian figure per pose, the far-LOD pin, release pulses, alert rings and the selection / hover halos. */
type FigureSet = `person-${Pose}`
type SetKind = Exclude<Kind, 'person'> | FigureSet | 'marker' | 'pulse' | 'halo' | 'hover' | 'alert' | 'presence'
const FIGURE_SETS = FIGURE_POSES.map((pose): FigureSet => `person-${pose}`)
const ALERT_RING_COLOR: RGB = [1.0, 0.42, 0.14]

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
/** Orange, the colour the navigation overlay uses for hovered and clicked districts, corridors and stops. */
const HALO_COLOR: RGB = [0.96, 0.54, 0.12]
/** The hover ring is the same orange but thinner, so it reads as "can be opened" next to the selected halo. */
const HOVER_COLOR: RGB = HALO_COLOR
const HALO_RADIUS: Record<Kind, number> = { bus: 8.5, car: 3.6, person: 1.6, bicycle: 2.2, delivery: 4.2, truck: 6 }
/** CPU picking follows the centre of the actual drawn body, including presentation scale and LOD. */
const BODY_PICK_HEIGHT: Record<Kind, number> = { bus: 1.8, car: 0.7, person: 0.9, bicycle: 0.9, delivery: 1.2, truck: 1.6 }
/** Hover ring radius as a fraction of the orbit radius, so it stays a few pixels wide from the city camera. */
const HOVER_MIN_RADIUS = 0.006

export function trafficColorAt(rx: ReplayIndex, id: string, t: number, legacy: RGB): RGB {
  if (rx.bundle.run.run_kind !== 'population') return legacy
  const c = rx.population ? populationColorAt(rx.population, id, t) : NEUTRAL_BRAIN_COLOR
  return [c[0] / 255, c[1] / 255, c[2] / 255]
}
/** Screen-space pick tolerance (CSS px). */
export const PICK_PX = 22

const GLASS: RGB = [0.16, 0.2, 0.26]
const TYRE: RGB = [0.08, 0.08, 0.09]
const SKIN: RGB = [0.87, 0.72, 0.6]

function mix(a: RGB, b: RGB, k: number): RGB {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

/** Flat annulus on the ground, outer radius `r`, band width `w`. */
function ring(b: Batch, r: number, w: number, y: number, c: RGB, segments = 24): void {
  b.annulus(0, 0, r, w, y, c, segments)
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
    shadows: ShadowGenerator | null,
  ) {
    this.scene = scene
    this.parts.push({ mesh: this.make(`${name}-body`, build, true, shadows), perInstanceColor: true })
    if (trim) this.parts.push({ mesh: this.make(`${name}-trim`, trim, false, null), perInstanceColor: false })
  }

  private make(name: string, build: (b: Batch) => void, perInstanceColor: boolean, shadows: ShadowGenerator | null): Mesh {
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
    mesh.metadata = { cityTraffic: true }
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

type PresencePose = { id: string; kind: Kind; px: number; py: number; pz: number; yaw: number; pickHeight: number; seen: boolean }

function cargoSet(scene: Scene, name: string, width: number, height: number, length: number, shadows: ShadowGenerator | null): InstanceSet {
  return new InstanceSet(scene, name, (b) => {
    box(b, 0, 0.5, -length * 0.1, width, height, length * 0.75, CAR_PALETTE[0])
    box(b, 0, 0.4, length * 0.38, width * 0.9, height * 0.7, length * 0.25, CAR_PALETTE[0])
  }, (b) => {
    box(b, 0, height * 0.5, length * 0.505, width * 0.8, height * 0.3, 0.08, GLASS)
    for (const z of [-length * 0.3, length * 0.3]) for (const x of [-width * 0.45, width * 0.45]) box(b, x, 0, z, 0.3, 0.8, 0.8, TYRE)
  }, shadows)
}

interface Entity {
  id: string
  ix: TrackIndex
  kind: Kind
  color: RGB
  headings: number[] | null
  yaw: number
  /** Last drawn world position, used for picking and following. */
  px: number
  py: number
  pz: number
  pickHeight: number
  seen: boolean
}

type LiveEntity = Omit<Entity, 'ix' | 'headings'> & { speed: number; state: number; flags: number }
const LIVE_STATES: PersonState[] = ['not_departed', 'walking', 'waiting', 'riding', 'driving', 'arrived', 'unroutable']

/** SUMO persons often report angle zero. Use recorded travel, independent of playback/seek direction. */
function pedestrianHeadings(ix: TrackIndex, frame: WorldFrame): number[] {
  let yaw = 0
  return ix.track.samples.map((sample, i, samples) => {
    if (i === 0 || ix.breakSet.has(i) || sample[0] - samples[i - 1][0] > MAX_GAP_S) yaw = sample[3] * Math.PI / 180
    const next = samples[i + 1]
    if (next && !ix.breakSet.has(i + 1) && next[0] > sample[0] && next[0] - sample[0] <= MAX_GAP_S) {
      const [x, z] = frame.lonLatToWorld(sample[1], sample[2])
      const [nx, nz] = frame.lonLatToWorld(next[1], next[2])
      if ((nx - x) ** 2 + (nz - z) ** 2 > 0.01) yaw = Math.atan2(nx - x, nz - z)
    }
    return yaw
  })
}

export interface Picked {
  kind: Kind
  id: string
}

export interface TrafficStats {
  buses: number
  cars: number
  people: number
  /** travellers whose recorded depart time has passed */
  released: number
  /** agents drawn while aware of an active incident, and those who learned within the last two seconds */
  alerted: number
  fresh: number
}

export const EMPTY_STATS: TrafficStats = { buses: 0, cars: 0, people: 0, released: 0, alerted: 0, fresh: 0 }

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
  private abstractPoses: PresencePose[] = []
  private releases: Release[] = []
  private rx: ReplayIndex | null = null
  private live: LiveTrafficSource | null = null
  private liveEntities = new Map<string, LiveEntity>()
  private hiddenIds = new Set<string>()
  private scratch: Interp = { lon: 0, lat: 0, angle: 0, speed: 0, i: -1, k: 0 }
  private agentScale = 1
  stats: TrafficStats = { ...EMPTY_STATS }
  /** Selected entity id: drawn at full detail with a ground halo; with `dimOthers`, everyone else fades. */
  selectedId: string | null = null
  /** Entity under the pointer: outlined with a thin ring so it reads as something you can open. */
  hoverId: string | null = null
  dimOthers = false

  private readonly pathY: number

  constructor(scene: Scene, frame: WorldFrame, shadows: ShadowGenerator | null, pathY = Y.path) {
    this.pathY = pathY
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
      car: new InstanceSet(scene, 'car', (b) => buildCar(b, CAR_PALETTE[0]), buildCarTrim, shadows),
      ...(Object.fromEntries(FIGURE_POSES.map((pose) => [`person-${pose}`, new InstanceSet(scene, `person-${pose}`, (b) => buildFigure(b, pose), (b) => buildHead(b, pose), null)])) as Record<FigureSet, InstanceSet>),
      bicycle: new InstanceSet(scene, 'bicycle', (b) => {
        box(b, 0, 0.5, 0, 0.18, 0.35, 1.7, CAR_PALETTE[0])
        box(b, 0, 0.85, -0.2, 0.4, 0.65, 0.3, CAR_PALETTE[0])
        box(b, 0, 0.95, 0.6, 0.7, 0.12, 0.12, CAR_PALETTE[0])
      }, (b) => {
        for (const z of [-0.65, 0.65]) box(b, 0, 0, z, 0.12, 0.65, 0.65, TYRE)
        box(b, 0, 1.5, -0.2, 0.24, 0.26, 0.24, SKIN)
      }, null),
      delivery: cargoSet(scene, 'delivery', 2, 1.8, 5.8, shadows),
      truck: cargoSet(scene, 'truck', 2.5, 2.6, 8.5, shadows),
      presence: new InstanceSet(scene, 'abstract-presence', (b) => buildFigure(b, 'stand'), (b) => buildHead(b, 'stand'), null),
      marker: new InstanceSet(scene, 'crowd-marker', buildMarker, null, null),
      pulse: new InstanceSet(scene, 'release-pulse', (b) => ring(b, 1, 0.12, 0.05, SKIN), null, null),
      halo: new InstanceSet(scene, 'selection-halo', (b) => ring(b, 1, 0.22, 0.05, SKIN), null, null),
      hover: new InstanceSet(scene, 'hover-halo', (b) => ring(b, 1, 0.12, 0.05, SKIN), null, null),
      alert: new InstanceSet(scene, 'alert-ring', (b) => ring(b, 1, 0.3, 0.05, ALERT_RING_COLOR), null, null),
    }
    this.sets.halo.reserve(1)
    this.sets.hover.reserve(1)
  }

  /** Draw travellers and vehicles this many times life-size. Positions never change, only the model size. */
  setAgentScale(scale: number): void {
    this.agentScale = Math.max(0.5, Math.min(4, scale))
  }

  idsInCircle(x: number, z: number, radius: number): string[] {
    return [...(this.live ? this.liveEntities.values() : this.entities)]
      .filter(e => e.seen && !this.hiddenIds.has(e.id) && (e.px - x) ** 2 + (e.pz - z) ** 2 <= radius ** 2)
      .map(e => e.id)
  }

  hideEntities(ids: Iterable<string>): void {
    this.hiddenIds = new Set(ids)
    if (this.selectedId && this.hiddenIds.has(this.selectedId)) this.selectedId = null
    if (this.hoverId && this.hiddenIds.has(this.hoverId)) this.hoverId = null
  }

  private figureSet(id: string, speed: number, state: number, t: number): FigureSet {
    return `person-${poseFor(speed, t, hash01(id) * 2, state)}`
  }

  /** Model sizes for this frame: the chosen swarm scale, gentler for vehicles, boosted for far-LOD pins from the city camera. */
  private scalesFor(view: Viewpoint): Record<Kind | 'marker', number> {
    const enlarged = this.agentScale > 1
    const vehicle = vehicleScale(this.agentScale) * (enlarged ? farBoost(view.radius, 'vehicle') : 1)
    return { person: this.agentScale, bicycle: this.agentScale, car: vehicle, bus: vehicle, delivery: vehicle, truck: vehicle, marker: this.agentScale * (enlarged ? farBoost(view.radius, 'marker') : 1) }
  }

  private counters(): Record<SetKind, number> {
    const n = { bus: 0, car: 0, bicycle: 0, delivery: 0, truck: 0, presence: 0, marker: 0, pulse: 0, halo: 0, hover: 0, alert: 0 } as Record<SetKind, number>
    for (const set of FIGURE_SETS) n[set] = 0
    return n
  }

  setLiveSource(source: LiveTrafficSource | null): void {
    this.setReplay(null)
    this.live = source
    this.stats = { ...EMPTY_STATS }
  }

  private updateLive(t: number, view: Viewpoint): void {
    const source = this.live
    if (!source) return
    const n = this.counters()
    for (const e of this.liveEntities.values()) e.seen = false
    let people = 0, alerted = 0, fresh = 0
    const scales = this.scalesFor(view)
    const available = source.forEachAt(t, (index, x, z, heading, speed, kindCode, state, flags) => {
      const meta = source.entity(index)
      if (!meta || this.hiddenIds.has(meta.id) || (kindCode === 1 && (state === 0 || state === 3 || state === 5))) return
      const kind: Kind = kindCode === 3 ? 'bus' : kindCode === 2 ? 'car' : 'person'
      let e = this.liveEntities.get(meta.id)
      if (!e) {
        const color = kind === 'bus' ? BUS_RED : kind === 'car' ? CAR_PALETTE[Math.floor(hash01(meta.id) * CAR_PALETTE.length)] : STATE_RGB.walking
        e = { id: meta.id, kind, color, yaw: 0, px: 0, py: 0, pz: 0, pickHeight: 0, seen: false, speed, state, flags }
        this.liveEntities.set(meta.id, e)
      }
      e.px = x; e.pz = z; e.py = kind === 'person' ? this.pathY : Y.road
      e.yaw = heading * Math.PI / 180; e.seen = true; e.speed = speed; e.state = state; e.flags = flags
      const selected = e.id === this.selectedId
      const hovered = e.id === this.hoverId
      let set: SetKind = kind === 'person' ? this.figureSet(e.id, speed, state, t) : kind
      let color = kind === 'person' ? stateColor(LIVE_STATES[state] ?? 'walking') : e.color
      if (kind === 'person') {
        people++
        if (!selected && !hovered && (view.radius >= 900 || lodFor(Math.hypot(x - view.x, view.y, z - view.z), view.radius) === 'marker')) set = 'marker'
      }
      const scale = set === 'marker' ? scales.marker : scales[kind]
      e.pickHeight = (set === 'marker' ? 1.6 : BODY_PICK_HEIGHT[kind]) * scale
      if (awareLevel(flags)) {
        alerted++
        color = alertTint(flags, color)
        if (flags & FLAG_FRESH) {
          fresh++
          this.sets.alert.reserve(n.alert + 1)
          this.sets.alert.set(n.alert++, x, Y.junction + 0.1, z, 0, ALERT_RING_COLOR, HALO_RADIUS[kind] * scale * 1.4)
        }
      }
      if (selected) this.sets.halo.set(n.halo++, x, Y.junction + 0.12, z, 0, HALO_COLOR, HALO_RADIUS[kind] * scale)
      else if (hovered) this.sets.hover.set(n.hover++, x, Y.junction + 0.12, z, 0, HOVER_COLOR, Math.max(HALO_RADIUS[kind] * scale * 1.25, view.radius * HOVER_MIN_RADIUS))
      else if (this.dimOthers && this.selectedId) color = mix(color, PALETTE.pavement, 0.72)
      this.sets[set].reserve(n[set] + 1)
      this.sets[set].set(n[set]++, x, e.py, z, e.yaw, color, scale)
    })
    for (const k of Object.keys(n) as SetKind[]) this.sets[k].commit(n[k])
    this.stats = { buses: n.bus, cars: n.car, people, released: available ? source.releasedAt(t) : 0, alerted, fresh }
  }

  setReplay(rx: ReplayIndex | null): void {
    this.live = null
    this.liveEntities.clear()
    this.rx = rx
    this.entities = []
    this.abstractPoses = []
    if (!rx) {
      for (const s of Object.values(this.sets)) s.commit(0)
      return
    }
    const counts: Record<Kind, number> = { bus: 0, car: 0, person: 0, bicycle: 0, delivery: 0, truck: 0 }
    for (const [id, ix] of Object.entries(rx.tracks)) {
      const kind = ix.track.kind
      counts[kind]++
      const color: RGB =
        kind === 'bus' ? BUS_RED : kind === 'car' ? CAR_PALETTE[Math.floor(hash01(id) * CAR_PALETTE.length)] : STATE_COLORS.walking.map((v) => v / 255) as RGB
      this.entities.push({ id, ix, kind, color, headings: kind === 'person' ? pedestrianHeadings(ix, this.frame) : null, yaw: 0, px: 0, py: 0, pz: 0, pickHeight: 0, seen: false })
    }
    this.sets.bus.reserve(counts.bus)
    this.sets.car.reserve(counts.car)
    this.sets.bicycle.reserve(counts.bicycle)
    this.sets.delivery.reserve(counts.delivery)
    this.sets.truck.reserve(counts.truck)
    for (const set of FIGURE_SETS) this.sets[set].reserve(counts.person)
    this.sets.marker.reserve(counts.person)
    this.sets.presence.reserve(rx.population?.definition.profiles.length ?? 0)
    this.releases = rx.bundle.run.run_kind === 'population' ? [] : releasesFrom(rx, this.frame)
    this.sets.pulse.reserve(64)
  }

  /** Sim time by which fraction `q` (0..1) of recorded departs have happened, or null with no replay. */
  releaseQuantile(q: number): number | null {
    const n = this.releases.length
    if (!n) return null
    const i = Math.min(n - 1, Math.max(0, Math.floor(q * (n - 1))))
    return this.releases[i].t
  }

  /** Place every entity for sim time `t`, choosing pedestrian detail from the viewpoint. */
  update(t: number, view: Viewpoint): void {
    if (this.live) { this.updateLive(t, view); return }
    const rx = this.rx
    if (!rx) return
    const n = this.counters()
    const modes = rx.bundle.compile?.mode_assignment ?? {}
    const s = this.scratch
    const sel = this.selectedId
    const hov = this.hoverId
    const dim = this.dimOthers && sel !== null
    const scales = this.scalesFor(view)
    let people = 0
    for (const e of this.entities) {
      const r = interpAt(e.ix, t, s)
      if (!r || this.hiddenIds.has(e.id) || (rx.population && !populationTrackVisible(rx.population, e.ix.track, t))) {
        e.seen = false
        continue
      }
      let color = trafficColorAt(rx, e.id, t, e.color)
      const y = e.kind === 'person' ? this.pathY : Y.road
      if (e.kind === 'person' && rx.bundle.run.run_kind !== 'population') {
        const state: PersonState = personStateAt(rx.personEvents[e.id], t, modes[e.id])
        if (state === 'riding' || state === 'arrived' || state === 'not_departed') {
          e.seen = false
          continue
        }
        color = stateColor(state)
      }
      const [x, z] = this.frame.lonLatToWorld(r.lon, r.lat)
      e.yaw = e.headings?.[r.i] ?? (r.angle * Math.PI) / 180
      e.px = x
      e.py = y
      e.pz = z
      e.seen = true
      const isSel = e.id === sel
      const isHov = e.id === hov && !isSel
      let set: SetKind = e.kind === 'person' ? this.figureSet(e.id, r.speed, personStateAt(rx.personEvents[e.id], t, modes[e.id]) === 'waiting' ? 2 : 1, t) : e.kind
      if (e.kind === 'person') {
        people++
        const d = Math.hypot(x - view.x, view.y, z - view.z)
        if (!rx.population && !isSel && !isHov && lodFor(d, view.radius) === 'marker') set = 'marker'
      }
      // Native residents keep their humanoid silhouette at district zoom; enlarge the body, never its position.
      const scale = rx.population && e.kind === 'person' ? scales.person * farBoost(view.radius, 'marker') : set === 'marker' ? scales.marker : scales[e.kind]
      e.pickHeight = (set === 'marker' ? 1.6 : BODY_PICK_HEIGHT[e.kind]) * scale
      if (isSel) this.sets.halo.set(n.halo++, x, Y.junction + 0.12, z, 0, HALO_COLOR, HALO_RADIUS[e.kind] * scale)
      else if (isHov) this.sets.hover.set(n.hover++, x, Y.junction + 0.12, z, 0, HOVER_COLOR, Math.max(HALO_RADIUS[e.kind] * scale * 1.25, view.radius * HOVER_MIN_RADIUS))
      else if (dim && rx.bundle.run.run_kind !== 'population') color = mix(color, PALETTE.pavement, 0.72)
      this.sets[set].set(n[set]++, x, y, z, e.yaw, color, scale)
    }
    this.abstractPoses = []
    if (rx.population) for (const presence of stationaryPresenceAt(rx.population, t)) {
      const [x, z] = this.frame.lonLatToWorld(presence.lon, presence.lat)
      const isSel = presence.id === sel
      const isHov = presence.id === hov && !isSel
      const color = trafficColorAt(rx, presence.id, t, [0.5, 0.5, 0.5])
      const scale = scales.person * farBoost(view.radius, 'marker')
      const haloY = Math.max(this.pathY, Y.junction) + 0.12
      if (isSel) this.sets.halo.set(n.halo++, x, haloY, z, 0, HALO_COLOR, HALO_RADIUS.person * scale)
      else if (isHov) this.sets.hover.set(n.hover++, x, haloY, z, 0, HOVER_COLOR, Math.max(HALO_RADIUS.person * scale * 1.25, view.radius * HOVER_MIN_RADIUS))
      this.sets.presence.set(n.presence++, x, this.pathY, z, 0, color, scale)
      this.abstractPoses.push({ id: presence.id, kind: 'person', px: x, py: this.pathY, pz: z, yaw: 0, pickHeight: BODY_PICK_HEIGHT.person * scale, seen: true })
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
    this.stats = { buses: n.bus, cars: n.car, people, released, alerted: 0, fresh: 0 }
  }

  /** Last drawn world pose of an entity (for follow cameras / inspection); null if unknown or not visible. */
  poseOf(id: string): { x: number; z: number; yaw: number; kind: Kind; speed?: number; state?: number; flags?: number } | null {
    if (this.hiddenIds.has(id)) return null
    const live = this.liveEntities.get(id)
    if (live) return live.seen ? { x: live.px, z: live.pz, yaw: live.yaw, kind: live.kind, speed: live.speed, state: live.state, flags: live.flags } : null
    const e = this.entities.find((v) => v.id === id) ?? this.abstractPoses.find((v) => v.id === id)
    return e && e.seen ? { x: e.px, z: e.pz, yaw: e.yaw, kind: e.kind } : null
  }

  /**
   * Nearest visible entity to a screen point, using the caller's world→screen projection.  Screen-space
   * picking keeps pedestrians selectable at any LOD and never depends on thin-instance GPU picking.
   */
  pick(sx: number, sy: number, project: (x: number, y: number, z: number) => { x: number; y: number }, tol = PICK_PX): Picked | null {
    let best: Picked | null = null
    let bestD = tol * tol
    for (const e of this.live ? this.liveEntities.values() : [...this.entities, ...this.abstractPoses]) {
      if (!e.seen || this.hiddenIds.has(e.id)) continue
      const p = project(e.px, e.py + e.pickHeight, e.pz)
      const d = (p.x - sx) * (p.x - sx) + (p.y - sy) * (p.y - sy)
      if (d < bestD) {
        bestD = d
        best = { kind: e.kind, id: e.id }
      }
    }
    return best
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
