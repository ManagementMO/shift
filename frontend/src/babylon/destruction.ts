/**
 * Destructible buildings for the storm.
 *
 * A damage plan is a pure function of the hazard path and the world: which buildings stand in the path, which
 * of them fail and when.  The renderer folds each planned building out of its static batch and stands a live
 * copy in its place (same footprint, same textures), then poses that copy — lean, shudder, slab-by-slab
 * collapse, rubble, dust — from the simulation clock alone, so scrubbing backwards puts the building back.
 *
 * Nothing here feeds back into the measured run: the road closures come from the backend hazard footprint;
 * this is what that footprint *looks like* on the ground.
 */

import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import type { Material } from '@babylonjs/core/Materials/material'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import '@babylonjs/core/Meshes/thinInstanceMesh'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import type { Scene } from '@babylonjs/core/scene'

import { facadeFor, TEXTURE_RECIPES, type TextureKind } from './appearance'
import { addArchitecture, type BuildingBatches } from './architecture'
import { buildingColor, buildingKey, massingKey, meshFromBatch, Y, type CityMeshes } from './city'
import { Batch, centroid, hash01, mix, signedArea, type RGB } from './geometry'
import { appendMassing, type MassingBuilding } from './massing'
import { SmokeSprites, type SmokePuff } from './smoke'
import type { Flat, WorldBuilding, WorldData } from './worldData'

/** Sim seconds per "display second": the choreography is authored to read well at the 10x playback the tornado is cued at. */
export const DISPLAY_SCALE = 10

export interface StormPath {
  /** world metres [x, z] */
  points: [number, number][]
  radius: number
  start: number
  end: number
}

export interface StormCenter {
  x: number
  z: number
  /** unit travel direction in the ground plane */
  dir: [number, number]
  /** 0 at touchdown, 1 at lift-off */
  progress: number
}

export interface Tier {
  ring: Flat
  holes?: Flat[]
  y0: number
  y1: number
}

export interface Destructible {
  key: string
  x: number
  z: number
  /** absolute y of the lowest tier */
  base: number
  /** top minus base */
  h: number
  /** equivalent footprint radius, metres */
  radius: number
  tiers: Tier[]
  wall: RGB
  roof: RGB
  facade: TextureKind
  dMin: number
  tClosest: number
  dir: [number, number]
  collapse: boolean
  tCollapse: number
  seed: number
  source: { kind: 'osm'; sections: WorldBuilding[] } | { kind: 'massing'; building: MassingBuilding }
}

export interface DamageOptions {
  /** buildings within radius × swayReach of the path move */
  swayReach: number
  /** collapse candidates lie within radius × collapseReach */
  collapseReach: number
  maxSway: number
  maxCollapse: number
  maxCollapseHeight: number
  collapseChance: number
}

export const DAMAGE_DEFAULTS: DamageOptions = { swayReach: 1.7, collapseReach: 0.75, maxSway: 56, maxCollapse: 10, maxCollapseHeight: 150, collapseChance: 0.8 }

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const smooth = (x: number): number => {
  const k = clamp(x, 0, 1)
  return k * k * (3 - 2 * k)
}

/** Funnel centre at sim time `t`: equal time per path segment, exactly like the backend / replay footprint. */
export function stormCenter(path: StormPath, t: number): StormCenter | null {
  const n = path.points.length
  if (!n || t < path.start || t > path.end) return null
  const span = Math.max(1, path.end - path.start)
  const progress = (t - path.start) / span
  if (n === 1) return { x: path.points[0][0], z: path.points[0][1], dir: [0, 1], progress }
  const f = progress * (n - 1)
  const i = Math.min(n - 2, Math.floor(f))
  const k = f - i
  const [ax, az] = path.points[i]
  const [bx, bz] = path.points[i + 1]
  const len = Math.hypot(bx - ax, bz - az)
  return { x: ax + (bx - ax) * k, z: az + (bz - az) * k, dir: len > 0 ? [(bx - ax) / len, (bz - az) / len] : [0, 1], progress }
}

/** Closest approach of the path to a point: distance, the sim time the centre is there, travel direction then. */
export function nearestOnPath(path: StormPath, x: number, z: number): { d: number; t: number; dir: [number, number] } {
  const n = path.points.length
  const span = Math.max(1, path.end - path.start)
  if (n === 1) return { d: Math.hypot(x - path.points[0][0], z - path.points[0][1]), t: path.start, dir: [0, 1] }
  let best = { d: Infinity, t: path.start, dir: [0, 1] as [number, number] }
  for (let i = 0; i < n - 1; i++) {
    const [ax, az] = path.points[i]
    const [bx, bz] = path.points[i + 1]
    const vx = bx - ax
    const vz = bz - az
    const len2 = vx * vx + vz * vz
    const k = len2 > 0 ? clamp(((x - ax) * vx + (z - az) * vz) / len2, 0, 1) : 0
    const d = Math.hypot(x - (ax + vx * k), z - (az + vz * k))
    if (d < best.d) {
      const len = Math.sqrt(len2)
      best = { d, t: path.start + ((i + k) / (n - 1)) * span, dir: len > 0 ? [vx / len, vz / len] : [0, 1] }
    }
  }
  return best
}

function tierOf(s: WorldBuilding): Tier {
  // mirrors addArchitecture: reconciled sections keep exact heights, legacy footprints get the 3 m minimum
  const reconciled = s.roofs !== undefined || Boolean(s.source_id)
  const y0 = Y.building + Math.max(0, s.base ?? 0)
  return { ring: s.ring, holes: s.holes, y0, y1: y0 + (reconciled ? s.h : Math.max(3, s.h)) }
}

function largest(tiers: Tier[]): Tier {
  return tiers.reduce((a, b) => (Math.abs(signedArea(b.ring)) > Math.abs(signedArea(a.ring)) ? b : a))
}

/** Which buildings the storm reaches, sorted nearest-first, with the failure schedule baked in. */
export function planDamage(world: WorldData, path: StormPath, opts: Partial<DamageOptions> = {}): Destructible[] {
  const o = { ...DAMAGE_DEFAULTS, ...opts }
  const replaced = new Set(world.massing?.excluded_osm_ids ?? [])
  const groups = new Map<string, WorldBuilding[]>()
  for (const b of world.buildings) {
    if (replaced.has(b.source_id ?? b.id) || b.cat === 'landmark') continue
    if (b.ring.length < 6 || Math.abs(signedArea(b.ring)) < (b.source_id ? 0.01 : 4)) continue
    const key = b.source_id ?? b.id
    const list = groups.get(key)
    if (list) list.push(b)
    else groups.set(key, [b])
  }
  const candidates: Destructible[] = []
  const consider = (key: string, tiers: Tier[], x: number, z: number, color: { wall: RGB; roof: RGB }, facade: TextureKind, source: Destructible['source']): void => {
    if (!tiers.length) return
    const base = Math.min(...tiers.map((t) => t.y0))
    const h = Math.max(...tiers.map((t) => t.y1)) - base
    if (h < 4) return
    const near = nearestOnPath(path, x, z)
    if (near.d > path.radius * o.swayReach) return
    const area = Math.abs(signedArea(largest(tiers).ring))
    candidates.push({
      key, x, z, base, h, radius: Math.sqrt(area / Math.PI), tiers, wall: color.wall, roof: color.roof, facade,
      dMin: near.d, tClosest: near.t, dir: near.dir, collapse: false, tCollapse: Infinity, seed: hash01(key), source,
    })
  }
  for (const [id, sections] of groups) {
    const tiers = sections.map(tierOf).sort((a, b) => a.y0 - b.y0)
    const [x, z] = centroid(largest(tiers).ring)
    const first = sections[0]
    consider(buildingKey(first), tiers, x, z, buildingColor(first), facadeFor({ id, cat: first.cat, h: first.source_height ?? first.h }), { kind: 'osm', sections })
  }
  for (const b of world.massing?.buildings ?? []) {
    const tiers = b.tiers.map((t) => ({ ring: t.ring, holes: t.holes, y0: t.y0 + Y.building, y1: t.y1 + Y.building })).sort((a, c) => a.y0 - c.y0)
    consider(massingKey(b.id), tiers, b.x, b.z, buildingColor({ ...b, ring: [] } as WorldBuilding), facadeFor(b), { kind: 'massing', building: b })
  }
  candidates.sort((a, b) => a.dMin - b.dMin || a.key.localeCompare(b.key))
  let collapses = 0
  for (const d of candidates) {
    if (collapses >= o.maxCollapse || d.dMin > path.radius * o.collapseReach || d.h > o.maxCollapseHeight) continue
    if (hash01(`${d.key}:fate`) >= o.collapseChance) continue
    d.collapse = true
    // the slab fails as the funnel arrives; a little scatter so a block does not drop in unison
    const stationary = path.points.every((p) => p[0] === path.points[0][0] && p[1] === path.points[0][1])
    d.tCollapse = stationary
      ? Math.min(path.end, path.start + (2.5 + hash01(`${d.key}:when`) * 5) * DISPLAY_SCALE)
      : clamp(d.tClosest + (hash01(`${d.key}:when`) - 0.45) * 0.8 * DISPLAY_SCALE, path.start + 1, path.end)
    collapses++
  }
  return candidates.slice(0, o.maxSway)
}

/** Sway of an intact building: lean toward the funnel and rock with it. Angles in radians, both zero when out of reach. */
export function swayAngles(d: Pick<Destructible, 'x' | 'z' | 'h' | 'seed'>, c: StormCenter | null, radius: number, t: number): { lean: number; cross: number; ux: number; uz: number } {
  if (!c) return { lean: 0, cross: 0, ux: 0, uz: 1 }
  const dx = c.x - d.x
  const dz = c.z - d.z
  const dist = Math.hypot(dx, dz) || 1
  const w = clamp(1 - dist / (radius * 1.8), 0, 1)
  if (w <= 0) return { lean: 0, cross: 0, ux: dx / dist, uz: dz / dist }
  const amp = w * w * (0.012 + 0.045 * clamp(d.h / 60, 0.15, 1))
  const f = 0.09 + 0.05 * d.seed // Hz in sim seconds: about one rock per second at 10x
  const lean = amp * (0.55 + 0.45 * Math.sin(2 * Math.PI * f * t + d.seed * 6.28))
  const cross = amp * 0.4 * Math.sin(2 * Math.PI * f * 1.37 * t + d.seed * 3.1)
  const shudder = w > 0.75 ? 0.0025 * ((w - 0.75) / 0.25) * Math.sin(t * 3.1 + d.seed * 9) : 0
  return { lean: lean + shudder, cross, ux: dx / dist, uz: dz / dist }
}

export interface SlicePose {
  /** local offset from the building pivot */
  x: number
  y: number
  z: number
  tilt: number
  tiltDir: [number, number]
  yaw: number
  scaleY: number
  /** 1 once the slab has come to rest */
  settled: number
}

export function sliceCount(h: number): number {
  return clamp(Math.round(h / 14), 2, 5)
}

/** What is left of each slab's height once the pile settles: a low-rise squats to a third, a tower pancakes to ~14 m in total. */
export function crushFactor(h: number): number {
  return clamp(14 / Math.max(1, h), 0.1, 0.32)
}

/** Slab `k` (0 = ground) of a `K`-slab building, `td` display seconds after failure: upper slabs go first, everything stacks into a crushed pile. */
export function slicePose(d: Pick<Destructible, 'key' | 'h' | 'dir'>, k: number, K: number, td: number): SlicePose {
  const hs = d.h / K
  const delay = (K - 1 - k) * 0.35
  const u = Math.max(0, td - delay)
  const fall = Math.min(1, (u / 1.5) ** 2)
  const settle = smooth(u / 2.6)
  const share = (k + 1) / K
  const crush = 1 - (1 - crushFactor(d.h)) * fall
  const tilt = (0.15 + 0.55 * hash01(`${d.key}:tilt:${k}`)) * share * settle
  const angle = Math.atan2(d.dir[1], d.dir[0]) + (hash01(`${d.key}:dir:${k}`) - 0.5) * 1.6
  const tiltDir: [number, number] = [Math.cos(angle), Math.sin(angle)]
  const drift = (6 + d.h * 0.12) * share * settle
  return {
    x: tiltDir[0] * drift,
    y: k * hs * crush,
    z: tiltDir[1] * drift,
    tilt,
    tiltDir,
    yaw: (hash01(`${d.key}:yaw:${k}`) - 0.5) * 0.9 * settle,
    scaleY: crush,
    settled: u >= 2.6 ? 1 : 0,
  }
}

export interface FragmentPose {
  x: number
  y: number
  z: number
  spin: number
  axis: [number, number, number]
  size: [number, number, number]
  color: RGB
  landed: boolean
}

export function fragmentCount(radius: number, h: number): number {
  return clamp(Math.round(radius * 1.2 + h * 0.12), 14, 60)
}

const G = 9.8

/** Rubble fragment `j` thrown as the slabs let go; ballistic in display seconds, then at rest where it landed. Null before launch. */
export function fragmentPose(d: Pick<Destructible, 'key' | 'x' | 'z' | 'base' | 'h' | 'radius' | 'wall' | 'dir'>, j: number, K: number, td: number): FragmentPose | null {
  const s = (tag: string) => hash01(`${d.key}:frag:${j}:${tag}`)
  const launch = 0.25 + (K - 1) * 0.35 * s('launch')
  const u = td - launch
  if (u < 0) return null
  const size: [number, number, number] = [1.2 + 3 * s('sx'), 0.8 + 2 * s('sy'), 1.2 + 3 * s('sz')]
  const bias = Math.atan2(d.dir[1], d.dir[0])
  const theta = s('theta') < 0.4 ? bias + (s('spread') - 0.5) * 1.2 : s('theta2') * Math.PI * 2
  const speed = 5 + 11 * s('speed')
  const vy = 3 + 8 * s('vy')
  const r0 = d.radius * 0.5 * s('r0')
  const x0 = d.x + Math.cos(theta) * r0
  const z0 = d.z + Math.sin(theta) * r0
  const y0 = d.base + d.h * (0.25 + 0.7 * s('y0'))
  const ground = Y.road + size[1] / 2
  const tLand = (vy + Math.sqrt(vy * vy + 2 * G * Math.max(0, y0 - ground))) / G
  const uu = Math.min(u, tLand)
  const ax = s('ax') - 0.5
  const ay = s('ay') - 0.5
  const az = s('az') - 0.5
  const al = Math.hypot(ax, ay, az) || 1
  return {
    x: x0 + Math.cos(theta) * speed * uu,
    y: Math.max(ground, y0 + vy * uu - 0.5 * G * uu * uu),
    z: z0 + Math.sin(theta) * speed * uu,
    spin: (2 + 5 * s('spin')) * uu,
    axis: [ax / al, ay / al, az / al],
    size,
    color: mix(d.wall, [0.5, 0.48, 0.45], 0.45 + 0.3 * s('tint')),
    landed: u >= tLand,
  }
}

export interface DustPose {
  x: number
  y: number
  z: number
  scale: number
  alpha: number
  color: RGB
}

export function dustCount(radius: number, h: number): number {
  return clamp(Math.round(radius * 0.8 + h * 0.08), 12, 40)
}

/** Dust puff `j` of a collapse: rolls outward, rises a little, grows and thins. Null outside its life. */
export function dustPose(d: Pick<Destructible, 'key' | 'x' | 'z' | 'base' | 'h' | 'radius' | 'wall'>, j: number, td: number): DustPose | null {
  const s = (tag: string) => hash01(`${d.key}:dust:${j}:${tag}`)
  const born = 0.1 + 1.6 * s('born')
  const life = 3 + 2 * s('life')
  const p = (td - born) / life
  if (p < 0 || p > 1) return null
  const theta = s('theta') * Math.PI * 2
  const big = 1 + Math.min(1.2, d.h / 120)
  const r = 3 + (d.radius * 0.7 + 20 * big) * (1 - (1 - p) ** 2)
  return {
    x: d.x + Math.cos(theta) * r,
    y: d.base + 1.5 + (8 * p * (1 - p) * (1 + s('lift')) + 4 * p) * big,
    z: d.z + Math.sin(theta) * r,
    scale: (3 + 15 * p) * (0.6 + 0.4 * s('size')) * big,
    alpha: 0.5 * (1 - p) ** 1.3 * Math.min(1, p * 6),
    color: mix(d.wall, [0.6, 0.57, 0.53], 0.6),
  }
}

// ---------------------------------------------------------------------------------------------- rendering

/** A prototype mesh drawn many times with per-instance matrix and colour (thin instances), like the traffic. */
export class ThinSet {
  readonly mesh: Mesh
  private matrices = new Float32Array(0)
  private colors = new Float32Array(0)
  private capacity = 0
  private readonly shadows: ShadowGenerator | null

  constructor(scene: Scene, name: string, proto: VertexData, material: Material, opts: { shadows?: ShadowGenerator | null; vertexAlpha?: boolean } = {}) {
    this.mesh = new Mesh(name, scene)
    proto.applyToMesh(this.mesh, false)
    this.mesh.material = material
    this.mesh.isPickable = false
    this.mesh.alwaysSelectAsActiveMesh = true
    this.mesh.doNotSyncBoundingInfo = true
    this.mesh.thinInstanceEnablePicking = false
    this.mesh.hasVertexAlpha = Boolean(opts.vertexAlpha)
    this.mesh.setEnabled(false)
    this.shadows = opts.shadows ?? null
    this.shadows?.addShadowCaster(this.mesh)
  }

  reserve(n: number): void {
    if (n <= this.capacity) return
    this.capacity = Math.max(n, Math.ceil(this.capacity * 1.5), 16)
    this.matrices = new Float32Array(this.capacity * 16)
    this.colors = new Float32Array(this.capacity * 4)
    this.mesh.thinInstanceSetBuffer('matrix', this.matrices, 16, false)
    this.mesh.thinInstanceSetBuffer('color', this.colors, 4, false)
  }

  set(i: number, m: Matrix, c: RGB, alpha = 1): void {
    m.copyToArray(this.matrices, i * 16)
    const k = i * 4
    this.colors[k] = c[0]
    this.colors[k + 1] = c[1]
    this.colors[k + 2] = c[2]
    this.colors[k + 3] = alpha
  }

  commit(count: number): void {
    this.mesh.setEnabled(count > 0)
    if (count === 0) return
    this.mesh.thinInstanceCount = count
    this.mesh.thinInstanceBufferUpdated('matrix')
    this.mesh.thinInstanceBufferUpdated('color')
  }

  dispose(): void {
    this.shadows?.removeShadowCaster(this.mesh)
    this.mesh.material?.dispose()
    this.mesh.dispose()
  }
}

/** Unit cube centred on the origin, flat shaded, all six faces. */
export function cubeVertexData(): VertexData {
  const b = new Batch()
  const quad = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]
  b.walls(quad, undefined, -0.5, 0.5, [1, 1, 1], 1)
  b.polygon(quad, undefined, 0.5, [1, 1, 1])
  capDown(b, quad, undefined, -0.5, [1, 1, 1])
  const vd = new VertexData()
  vd.positions = new Float32Array(b.positions)
  vd.normals = new Float32Array(b.normals)
  vd.indices = new Uint16Array(b.indices)
  return vd
}

/** A horizontal polygon whose front face points down (the underside of a slab when it tips). */
function capDown(b: Batch, ring: Flat, holes: Flat[] | undefined, y: number, c: RGB): void {
  const v0 = b.vertexCount
  const i0 = b.indices.length
  b.polygon(ring, holes, y, c)
  for (let v = v0; v < b.vertexCount; v++) b.normals[v * 3 + 1] = -1
  for (let i = i0; i < b.indices.length; i += 3) {
    const tmp = b.indices[i + 1]
    b.indices[i + 1] = b.indices[i + 2]
    b.indices[i + 2] = tmp
  }
}

const SCRATCH = { s: new Vector3(), q: new Quaternion(), q2: new Quaternion(), axis: new Vector3(), p: new Vector3(), m: new Matrix() }

function meshesFrom(scene: Scene, name: string, batches: Map<TextureKind, Batch>, city: CityMeshes, origin: [number, number, number], parent: TransformNode, shadows: ShadowGenerator | null): Mesh[] {
  const out: Mesh[] = []
  for (const [kind, batch] of batches) {
    if (batch.isEmpty()) continue
    for (let i = 0; i < batch.positions.length; i += 3) {
      batch.positions[i] -= origin[0]
      batch.positions[i + 1] -= origin[1]
      batch.positions[i + 2] -= origin[2]
    }
    const mesh = meshFromBatch(`${name}-${kind}`, batch, scene, city.materials.get(kind))
    mesh.unfreezeWorldMatrix()
    mesh.doNotSyncBoundingInfo = false
    mesh.receiveShadows = true
    mesh.parent = parent
    shadows?.addShadowCaster(mesh)
    out.push(mesh)
  }
  return out
}

interface Slice {
  node: TransformNode
  meshes: Mesh[]
}

/** One planned building standing in for its batched twin: textured intact copy plus collapse slabs. */
export class LiveBuilding {
  readonly d: Destructible
  readonly root: TransformNode
  readonly intact: Mesh[]
  readonly slices: Slice[] = []
  readonly K: number
  private readonly shadows: ShadowGenerator | null
  private collapsed = false

  constructor(scene: Scene, city: CityMeshes, d: Destructible, shadows: ShadowGenerator | null) {
    this.d = d
    this.shadows = shadows
    this.K = sliceCount(d.h)
    this.root = new TransformNode(`live-${d.key}`, scene)
    this.root.position.set(d.x, d.base, d.z)
    this.root.rotationQuaternion = Quaternion.Identity()
    const batches = new Map<TextureKind, Batch>()
    const batchFor = (kind: TextureKind): Batch => {
      let b = batches.get(kind)
      if (!b) {
        b = new Batch(TEXTURE_RECIPES[kind].metres)
        batches.set(kind, b)
      }
      return b
    }
    if (d.source.kind === 'osm') {
      const out: BuildingBatches = { facade: batchFor(d.facade), roof: batchFor('roof'), stone: batchFor('concrete'), glass: batchFor('glass'), metal: batchFor('industrial') }
      for (const s of d.source.sections) addArchitecture(out, s, { wall: d.wall, roof: d.roof }, true)
    } else {
      appendMassing(d.source.building, batchFor(d.facade), batchFor('roof'), d.wall)
    }
    this.intact = meshesFrom(scene, `live-${d.key}`, batches, city, [d.x, d.base, d.z], this.root, shadows)
    if (d.collapse) {
      // Slabs are only ever seen after failure: bare, dust-grey concrete rather than the pristine facade.
      const ruin = mix(d.wall, [0.55, 0.53, 0.5], 0.55)
      const hs = d.h / this.K
      for (let k = 0; k < this.K; k++) {
        const y0 = d.base + k * hs
        const y1 = y0 + hs
        const sliceBatches = new Map<TextureKind, Batch>()
        const cut = new Batch(TEXTURE_RECIPES.concrete.metres)
        const roof = new Batch(TEXTURE_RECIPES.roof.metres)
        sliceBatches.set('concrete', cut)
        sliceBatches.set('roof', roof)
        for (const tier of d.tiers) {
          const lo = Math.max(tier.y0, y0)
          const hi = Math.min(tier.y1, y1)
          if (hi - lo < 0.05) continue
          cut.walls(tier.ring, tier.holes, lo, hi, ruin, 1)
          if (hi === tier.y1) roof.polygon(tier.ring, tier.holes, hi, mix(d.roof, [0.5, 0.49, 0.47], 0.4))
          else cut.polygon(tier.ring, tier.holes, hi, [0.6, 0.58, 0.54])
          capDown(cut, tier.ring, tier.holes, lo, [0.48, 0.46, 0.43])
        }
        const node = new TransformNode(`live-${d.key}-slab${k}`, scene)
        node.parent = this.root
        node.position.set(0, k * hs, 0)
        node.rotationQuaternion = Quaternion.Identity()
        const meshes = meshesFrom(scene, `live-${d.key}-slab${k}`, sliceBatches, city, [d.x, y0, d.z], node, shadows)
        for (const m of meshes) m.setEnabled(false)
        this.slices.push({ node, meshes })
      }
    }
  }

  pose(t: number, c: StormCenter | null, radius: number): void {
    const collapsing = this.d.collapse && t >= this.d.tCollapse
    if (collapsing !== this.collapsed) {
      this.collapsed = collapsing
      for (const m of this.intact) m.setEnabled(!collapsing)
      for (const s of this.slices) for (const m of s.meshes) m.setEnabled(collapsing)
    }
    const q = this.root.rotationQuaternion!
    if (!collapsing) {
      const sway = swayAngles(this.d, c, radius, t)
      if (sway.lean === 0 && sway.cross === 0) {
        q.set(0, 0, 0, 1)
        return
      }
      // lean toward (ux, uz) is a rotation about the ground axis perpendicular to it; cross rocks sideways
      SCRATCH.axis.set(sway.uz, 0, -sway.ux)
      Quaternion.RotationAxisToRef(SCRATCH.axis, sway.lean, q)
      SCRATCH.axis.set(sway.ux, 0, sway.uz)
      Quaternion.RotationAxisToRef(SCRATCH.axis, sway.cross, SCRATCH.q)
      q.multiplyInPlace(SCRATCH.q)
      return
    }
    q.set(0, 0, 0, 1)
    const td = (t - this.d.tCollapse) / DISPLAY_SCALE
    this.slices.forEach((s, k) => {
      const p = slicePose(this.d, k, this.K, td)
      s.node.position.set(p.x, p.y, p.z)
      s.node.scaling.set(1, p.scaleY, 1)
      SCRATCH.axis.set(p.tiltDir[1], 0, -p.tiltDir[0])
      Quaternion.RotationAxisToRef(SCRATCH.axis, p.tilt, s.node.rotationQuaternion!)
      Quaternion.RotationYawPitchRollToRef(p.yaw, 0, 0, SCRATCH.q)
      s.node.rotationQuaternion!.multiplyInPlace(SCRATCH.q)
    })
  }

  dispose(): void {
    for (const m of this.intact) {
      this.shadows?.removeShadowCaster(m)
      m.dispose()
    }
    for (const s of this.slices) {
      for (const m of s.meshes) {
        this.shadows?.removeShadowCaster(m)
        m.dispose()
      }
      s.node.dispose()
    }
    this.root.dispose()
  }
}

/** Everything the storm does to buildings: fold the planned ones out of the batches, stand live copies up, pose them by sim time. */
export class Damage {
  readonly plan: Destructible[]
  private readonly city: CityMeshes
  private readonly live: LiveBuilding[]
  private readonly fragments: ThinSet
  private readonly dust: SmokeSprites
  private readonly path: StormPath

  constructor(scene: Scene, city: CityMeshes, path: StormPath, plan: Destructible[], shadows: ShadowGenerator | null) {
    this.city = city
    this.path = path
    this.plan = plan
    city.setBuildingsHidden(plan.map((d) => d.key), true)
    this.live = plan.map((d) => new LiveBuilding(scene, city, d, shadows))
    const rubbleMat = new StandardMaterial('rubble-mat', scene)
    rubbleMat.diffuseColor = Color3.White()
    rubbleMat.ambientColor = new Color3(0.9, 0.9, 0.9)
    rubbleMat.specularColor = new Color3(0.08, 0.08, 0.08)
    this.fragments = new ThinSet(scene, 'rubble', cubeVertexData(), rubbleMat, { shadows })
    this.dust = new SmokeSprites(scene, 'collapse-dust')
    this.dust.mesh.alphaIndex = 4
    const collapsing = plan.filter((d) => d.collapse)
    this.fragments.reserve(collapsing.reduce((n, d) => n + fragmentCount(d.radius, d.h), 0))
  }

  update(t: number, c: StormCenter | null): void {
    for (const b of this.live) {
      b.root.setEnabled(!this.city.isHidden(b.d.key.slice(b.d.key.indexOf(':') + 1)))
      if (b.root.isEnabled()) b.pose(t, c, this.path.radius)
    }
    let nf = 0
    const dust: SmokePuff[] = []
    for (const b of this.live) {
      const d = b.d
      if (!b.root.isEnabled() || !d.collapse || t < d.tCollapse) continue
      const td = (t - d.tCollapse) / DISPLAY_SCALE
      const nFrag = fragmentCount(d.radius, d.h)
      for (let j = 0; j < nFrag; j++) {
        const f = fragmentPose(d, j, b.K, td)
        if (!f) continue
        SCRATCH.axis.set(f.axis[0], f.axis[1], f.axis[2])
        Quaternion.RotationAxisToRef(SCRATCH.axis, f.spin, SCRATCH.q)
        SCRATCH.s.set(f.size[0], f.size[1], f.size[2])
        SCRATCH.p.set(f.x, f.y, f.z)
        Matrix.ComposeToRef(SCRATCH.s, SCRATCH.q, SCRATCH.p, SCRATCH.m)
        this.fragments.set(nf++, SCRATCH.m, f.color)
      }
      const nDust = dustCount(d.radius, d.h)
      for (let j = 0; j < nDust; j++) {
        const p = dustPose(d, j, td)
        if (!p) continue
        dust.push({
          x: p.x, y: p.y, z: p.z,
          width: p.scale * 2.6, height: p.scale * 1.9,
          angle: hash01(`${d.key}:dust:${j}`) * Math.PI * 2 + td * 0.12,
          color: p.color, alpha: Math.min(0.8, p.alpha * 1.3),
        })
      }
    }
    this.fragments.commit(nf)
    this.dust.draw(dust)
  }

  dispose(): void {
    for (const b of this.live) b.dispose()
    this.fragments.dispose()
    this.dust.dispose()
    this.city.setBuildingsHidden(this.plan.map((d) => d.key), false)
  }
}
