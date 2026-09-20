/**
 * Illustrative weather-event visuals for the Babylon city.
 *
 *  - rain:  a white cloud with wind-slanted drops falling onto the footprint, splash rings where they land, a wet sheen
 *  - fire:  flames, embers and smoke that spread outward from the ignition point across the footprint as the
 *           replay clock advances, over a scorched ground whose burning edge glows (per-pixel in the shader)
 *  - storm: a dark bobbing cloud, heavier slanted rain and splashes, forked lightning with ground flashes
 *
 * Everything here is decoration derived from the backend's static footprint polygon and time window. The
 * animation never moves, grows or shrinks the hazard: the footprint edges, the SUMO restrictions and the measured
 * results come only from the backend, and the effect appears for exactly the same [start, end) window. The fire's
 * visible spread is drawn inside that static footprint; the roads inside it are restricted for the whole window.
 */

import { Constants } from '@babylonjs/core/Engines/constants'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Material } from '@babylonjs/core/Materials/material'
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase'
import { MaterialPluginEvent } from '@babylonjs/core/Materials/materialPluginEvent'
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import '@babylonjs/core/Meshes/thinInstanceMesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial'
import type { Scene } from '@babylonjs/core/scene'

import type { HazardDraft, HazardKind, HazardTrack } from '../types'
import { fireSpreadProgress } from '../replay'
import { distanceToStroke, MAX_FIRE_POINTS, strokeSamples } from '../hazardGeometry'
import { Y } from './city'
import type { WorldFrame } from './coords'
import { Batch, hash01, type RGB } from './geometry'
import { fireParticleMaterial, fireParticleQuad } from './fireParticles'
import { SmokeSprites, type SmokePuff, type ProjectEffect } from './smoke'

const Y_EFFECT = Y.junction + 0.12
const MAX_INSTANCES = 600
const MIN_INSTANCES = 12
/** Rain drops / flames per square metre of footprint, before clamping. */
const DENSITY: Record<HazardKind, number> = { fire: 1 / 110, rain: 1 / 150, storm: 1 / 90, flood: 0 }
/** A fire reaches the edge of its footprint after this fraction of its window has elapsed (sim time). */
const FIRE_SPREAD_FRACTION = 0.6
/** Minimum width in metres of the soft burning edge. */
const FIRE_BAND_MIN_M = 6

const FLAME: RGB = [1, 0.42, 0.06]
const FLAME_CORE: RGB = [1, 0.9, 0.45]
const EMBER: RGB = [1, 0.72, 0.25]
const SMOKE: RGB = [0.26, 0.25, 0.25]
const SCORCH: RGB = [0.11, 0.09, 0.08]
const GLOW: RGB = [1, 0.36, 0.05]
const FOAM: RGB = [0.92, 0.97, 1]
const RAIN: RGB = [0.86, 0.94, 1]
const STORM_CLOUD: RGB = [0.34, 0.37, 0.42]
const RAIN_CLOUD: RGB = [0.95, 0.97, 1]
const MAX_CLOUD_CLUSTERS = 20
const BOLT: RGB = [1, 0.98, 0.86]
const BOLT_GLOW: RGB = [0.75, 0.85, 1]

type Flat = number[]
type Point = [number, number]

export interface Sprite {
  mesh: Mesh
  matrices: Float32Array
  colors: Float32Array
  points: Point[]
  phases: Float32Array
  kind: 'rain' | 'splash' | 'flame' | 'flameCore' | 'ember' | 'smoke'
  /** Footprint-relative size multiplier (1 = a small 60 m zone). */
  scale: number
  /** Rain: altitude the drops start falling from. */
  height: number
  /** Rain: cycles per second; splashes share the drop's cycle. */
  speed: number
  /** Rain: horizontal drift over the whole fall (wind), world metres. */
  wind: Point
  base: RGB
  ignitionDistances?: Float32Array
}

/** Shared with the SpreadFront shader plugin: where the fire started and how far its burning edge has reached. */
export interface SpreadFrontState {
  source: Point
  path: Point[]
  pathUniform: Float32Array
  front: number
  band: number
  /** Colour and strength of the glowing edge. */
  crest: RGB
  crestStrength: number
}

interface Fire {
  scorch: Mesh
  glow: Mesh
  glowMat: StandardMaterial
  front: SpreadFrontState
  /** Furthest footprint point from the ignition (m): the edge the fire spreads to. */
  reach: number
  start_s: number
  end_s: number
  /** Previews keep igniting along the stroke even while the replay is paused. */
  preview: boolean
  born: number
}

/**
 * Reveals a ground surface behind an advancing circular front from `source`, with a coloured crest at the front.
 * Doing this per pixel keeps the spread smooth on any footprint shape without re-meshing each frame.
 */
class SpreadFront extends MaterialPluginBase {
  private readonly state: SpreadFrontState

  constructor(material: StandardMaterial, state: SpreadFrontState) {
    super(material, 'SpreadFront', 210, { HAZARD_SPREAD_FRONT: true })
    this.state = state
    // hardBindForSubMesh only runs for plugins registered for extra events.
    this.registerForExtraEvents = true
    this._enable(true)
  }

  getClassName(): string {
    return 'SpreadFront'
  }

  getUniforms() {
    return {
      ubo: [{ name: 'spreadFront', size: 4, type: 'vec4' }, { name: 'spreadCrest', size: 4, type: 'vec4' }, { name: 'spreadPath', size: 2, type: 'vec2', arraySize: MAX_FIRE_POINTS }, { name: 'spreadCount', size: 1, type: 'float' }],
      fragment: `
#ifndef UNIFORMBUFFERS
uniform vec4 spreadFront;
uniform vec4 spreadCrest;
uniform vec2 spreadPath[${MAX_FIRE_POINTS}];
uniform float spreadCount;
#endif
`,
    }
  }

  hardBindForSubMesh(uniforms: UniformBuffer): void {
    const s = this.state
    uniforms.updateFloat4('spreadFront', s.source[0], s.source[1], s.front, Math.max(s.band, 0.001))
    uniforms.updateFloat4('spreadCrest', s.crest[0], s.crest[1], s.crest[2], s.crestStrength)
    uniforms.updateFloatArray('spreadPath', s.pathUniform)
    uniforms.updateFloat('spreadCount', s.path.length)
  }

  getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType !== 'fragment') return null
    return {
      CUSTOM_FRAGMENT_BEFORE_FOG: `
vec2 spreadOffset = vPositionW.xz - spreadFront.xy;
float spreadD = length(spreadOffset);
for (int i = 1; i < ${MAX_FIRE_POINTS}; i++) {
  if (float(i) >= spreadCount) break;
  vec2 a = spreadPath[i - 1], delta = spreadPath[i] - a;
  float along = clamp(dot(vPositionW.xz - a, delta) / max(dot(delta, delta), 0.0001), 0.0, 1.0);
  spreadD = min(spreadD, length(vPositionW.xz - a - along * delta));
}
spreadD += sin(vPositionW.x * 0.18 + sin(vPositionW.z * 0.12)) * spreadFront.w * 0.12;
if (spreadD >= spreadFront.z) discard;
float spreadIn = 1.0 - smoothstep(spreadFront.z - spreadFront.w, spreadFront.z, spreadD);
float spreadEdge = smoothstep(spreadFront.z - spreadFront.w * 1.6, spreadFront.z - spreadFront.w * 0.6, spreadD) * (1.0 - smoothstep(spreadFront.z - spreadFront.w * 0.6, spreadFront.z, spreadD));
color.rgb = mix(color.rgb, spreadCrest.rgb, spreadEdge * spreadCrest.w);
color.a *= spreadIn;
`,
    }
  }
}

interface Storm {
  bolts: { core: Mesh; glow: Mesh; flash: Mesh; phase: number; period: number }[]
}

interface WeatherCloud {
  sprites: SmokeSprites
  shadow: SmokeSprites
  points: Point[]
  seeds: { point: Point; a: number; b: number; c: number; d: number }[]
  size: number
  height: number
  storm: boolean
  preview: boolean
  puffs: SmokePuff[]
}

interface Effect {
  key: string
  meshes: Mesh[]
  materials: (StandardMaterial | ShaderMaterial)[]
  sprites: Sprite[]
  fire: Fire | null
  storm: Storm | null
  /** Soft cloud particles and their fading ground shadow. */
  cloud: WeatherCloud | null
  seed: number
}

function pointInRing(x: number, z: number, ring: Flat): boolean {
  let inside = false
  const n = ring.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i], zi = ring[2 * i + 1], xj = ring[2 * j], zj = ring[2 * j + 1]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
  }
  return inside
}

function ringArea(ring: Flat): number {
  let a = 0
  const n = ring.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    a += ring[2 * i] * ring[2 * j + 1] - ring[2 * j] * ring[2 * i + 1]
  }
  return Math.abs(a) / 2
}

/** Deterministic points inside the exterior ring and outside its holes (world metres). */
export function sampleHazardPoints(rings: Flat[], seed: string, count: number): Point[] {
  const [outer, ...holes] = rings
  if (!outer || outer.length < 6 || !outer.every(Number.isFinite) || count <= 0) return []
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
  for (let i = 0; i < outer.length; i += 2) {
    x0 = Math.min(x0, outer[i]); x1 = Math.max(x1, outer[i])
    z0 = Math.min(z0, outer[i + 1]); z1 = Math.max(z1, outer[i + 1])
  }
  if (!(x1 > x0 && z1 > z0)) return []
  const out: Point[] = []
  for (let i = 0; i < count * 8 && out.length < count; i++) {
    const x = x0 + hash01(`${seed}:x:${i}`) * (x1 - x0)
    const z = z0 + hash01(`${seed}:z:${i}`) * (z1 - z0)
    if (pointInRing(x, z, outer) && !holes.some((h) => pointInRing(x, z, h))) out.push([x, z])
  }
  return out
}

function footprintArea(rings: Flat[]): number {
  return ringArea(rings[0]) - rings.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0)
}

function instanceCount(kind: HazardKind, rings: Flat[]): number {
  return Math.max(MIN_INSTANCES, Math.min(MAX_INSTANCES, Math.round(footprintArea(rings) * DENSITY[kind])))
}

/**
 * Spread-front states waiting for their material.  The plugin must attach while the StandardMaterial is being
 * constructed (before it builds its uniform layout), so it is hooked through the material-created event, like the
 * world atmosphere plugin, rather than added afterwards.
 */
const pendingFronts = new Map<string, SpreadFrontState>()
Material.OnEventObservable.add((material) => {
  const state = pendingFronts.get(material.name)
  if (state && material instanceof StandardMaterial) {
    pendingFronts.delete(material.name)
    new SpreadFront(material, state)
  }
}, MaterialPluginEvent.Created)

/** Unlit vertex-colour material: colours render at full strength regardless of sun or time of day. */
function effectMaterial(name: string, scene: Scene, alpha: number, preview: boolean, front?: SpreadFrontState): StandardMaterial {
  if (front) pendingFronts.set(name, front)
  const m = new StandardMaterial(name, scene)
  pendingFronts.delete(name)
  m.diffuseColor = Color3.Black()
  m.ambientColor = Color3.Black()
  m.specularColor = Color3.Black()
  m.emissiveColor = Color3.White()
  m.disableLighting = true
  m.alpha = preview ? alpha * 0.75 : alpha
  m.backFaceCulling = false
  m.disableDepthWrite = true
  m.depthFunction = Constants.ALWAYS
  return m
}

function meshOf(name: string, scene: Scene, b: Batch, material: Material, uvs = false): Mesh {
  const mesh = new Mesh(name, scene)
  const vd = new VertexData()
  vd.positions = new Float32Array(b.positions)
  vd.normals = new Float32Array(b.normals)
  vd.colors = new Float32Array(b.colors)
  if (uvs) vd.uvs = new Float32Array(b.uvs)
  vd.indices = b.vertexCount > 65535 ? new Uint32Array(b.indices) : new Uint16Array(b.indices)
  vd.applyToMesh(mesh, false)
  mesh.material = material
  mesh.isPickable = false
  mesh.doNotSyncBoundingInfo = true
  mesh.renderingGroupId = 1
  return mesh
}

function writeInstance(m: Float32Array, i: number, x: number, y: number, z: number, yaw: number, sx: number, sy: number): void {
  const o = i * 16
  const c = Math.cos(yaw) * sx, s = Math.sin(yaw) * sx
  m[o] = c; m[o + 1] = 0; m[o + 2] = -s; m[o + 3] = 0
  m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0
  m[o + 8] = s; m[o + 9] = 0; m[o + 10] = c; m[o + 11] = 0
  m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1
}

function writeColor(c: Float32Array, i: number, rgb: RGB, a: number): void {
  const o = i * 4
  c[o] = rgb[0]; c[o + 1] = rgb[1]; c[o + 2] = rgb[2]; c[o + 3] = a
}

/** Two crossed vertical quads along a jagged 3-D path, so a bolt reads from any camera angle. */
function boltGeometry(b: Batch, path: [number, number, number][], width: number, c: RGB): void {
  for (let i = 0; i < path.length - 1; i++) {
    const [x0, y0, z0] = path[i], [x1, y1, z1] = path[i + 1]
    for (const [dx, dz] of [[width, 0], [0, width]] as const) {
      const a = b.vertex(x0 - dx, y0, z0 - dz, 0, 1, 0, c)
      const bb = b.vertex(x0 + dx, y0, z0 + dz, 0, 1, 0, c)
      const cc = b.vertex(x1 + dx, y1, z1 + dz, 0, 1, 0, c)
      const d = b.vertex(x1 - dx, y1, z1 - dz, 0, 1, 0, c)
      b.indices.push(a, bb, cc, a, cc, d)
    }
  }
}

function boltPath(seed: string, x: number, z: number, top: number, spread: number): [number, number, number][] {
  const steps = 9 + Math.floor(hash01(`${seed}:n`) * 4)
  const path: [number, number, number][] = [[x, top, z]]
  let px = x, pz = z
  for (let i = 1; i <= steps; i++) {
    px += (hash01(`${seed}:x:${i}`) - 0.5) * spread
    pz += (hash01(`${seed}:z:${i}`) - 0.5) * spread
    path.push([px, top * (1 - i / steps), pz])
  }
  return path
}

function cloudCenters(rings: Flat[], seed: string, count: number): Point[] {
  const candidates = sampleHazardPoints(rings, seed, count * 5)
  if (!candidates.length) return []
  const center: Point = [candidates.reduce((sum, p) => sum + p[0], 0) / candidates.length, candidates.reduce((sum, p) => sum + p[1], 0) / candidates.length]
  let next = candidates.reduce((best, p, i) => Math.hypot(p[0] - center[0], p[1] - center[1]) < Math.hypot(candidates[best][0] - center[0], candidates[best][1] - center[1]) ? i : best, 0)
  const distances = candidates.map(() => Infinity)
  const result: Point[] = []
  while (next >= 0 && result.length < count) {
    const p = candidates[next]
    result.push(p)
    distances[next] = -1
    next = -1
    let furthest = -1
    candidates.forEach((candidate, i) => {
      if (distances[i] < 0) return
      distances[i] = Math.min(distances[i], (candidate[0] - p[0]) ** 2 + (candidate[1] - p[1]) ** 2)
      if (distances[i] > furthest) { furthest = distances[i]; next = i }
    })
  }
  return result
}

let guideMemo: { key: string; frame: WorldFrame; track: HazardTrack } | null = null

/** Local visual bounds for the draft; fire's shader clips its bounds to the stroke before roads resolve. */
export function guideTrack(draft: HazardDraft, frame: WorldFrame): HazardTrack | null {
  const c = draft.waypoints[0]
  if (!c) return null
  if (draft.shape === 'polygon' ? draft.waypoints.length < 3 : !Number.isFinite(draft.radius_m) || draft.radius_m <= 0) return null
  const key = JSON.stringify(draft)
  if (guideMemo?.key === key && guideMemo.frame === frame) return guideMemo.track
  let ring: Point[]
  if (draft.shape === 'polygon') {
    ring = [...draft.waypoints.map((p) => [...p] as Point), [...c]]
  } else if (draft.kind === 'fire' && draft.waypoints.length > 1) {
    const points = draft.waypoints.map(([lon, lat]) => frame.lonLatToWorld(lon, lat))
    const r = draft.radius_m
    const x0 = Math.min(...points.map((p) => p[0])) - r, x1 = Math.max(...points.map((p) => p[0])) + r
    const z0 = Math.min(...points.map((p) => p[1])) - r, z1 = Math.max(...points.map((p) => p[1])) + r
    ring = [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]].map(([x, z]) => frame.worldToLonLat(x, z))
  } else {
    const [cx, cz] = frame.lonLatToWorld(c[0], c[1])
    ring = Array.from({ length: 49 }, (_, i) => {
      const a = (i / 48) * Math.PI * 2
      return frame.worldToLonLat(cx + Math.cos(a) * draft.radius_m, cz + Math.sin(a) * draft.radius_m)
    })
  }
  const track: HazardTrack = { ...draft, track_id: 'weather-guide', footprint: [ring] }
  guideMemo = { key, frame, track }
  return track
}

const keyCache = new WeakMap<HazardTrack, string>()
function keyFor(h: HazardTrack, preview: boolean): string {
  let base = keyCache.get(h)
  if (!base) keyCache.set(h, (base = JSON.stringify([h.kind ?? 'storm', h.radius_m, h.footprint, h.waypoints, h.start_s, h.end_s])))
  return `${base}|${preview ? 'preview' : 'active'}`
}

export class HazardEffects {
  private readonly scene: Scene
  private readonly frame: WorldFrame
  private effects = new Map<string, Effect>()
  private time = 0
  private previewFireSince: number | null = null
  /** Replay clock (sim seconds) from the last `set`; drives the fire spread. */
  private simT = 0

  constructor(scene: Scene, frame: WorldFrame) {
    this.scene = scene
    this.frame = frame
  }

  /** Draw effects for hazards active at sim time `t`; `previewId` marks an unconfirmed hazard drawn muted. */
  set(hazards: HazardTrack[], t: number, previewId: string | null = null): void {
    this.simT = t
    this.previewFireSince = hazards.some((h) => h.track_id === previewId && h.kind === 'fire') ? this.previewFireSince ?? this.time : null
    const wanted = new Map<string, HazardTrack>()
    for (const h of hazards) {
      if (h.track_id === previewId || (t >= h.start_s && t < h.end_s)) wanted.set(h.track_id, h)
    }
    for (const [id, effect] of this.effects) {
      const h = wanted.get(id)
      if (h && keyFor(h, id === previewId) === effect.key) {
        this.animateEffect(effect)
        wanted.delete(id)
      } else {
        this.destroy(effect)
        this.effects.delete(id)
      }
    }
    for (const [id, h] of wanted) {
      const effect = this.build(h, id === previewId)
      if (!effect) continue
      this.effects.set(id, effect)
      this.animateEffect(effect)
    }
  }

  /** Advance the decorative animation by `dt` seconds of wall time. Positions stay inside the footprint. */
  animate(dt: number): void {
    this.time += dt
    for (const effect of this.effects.values()) this.animateEffect(effect)
  }

  /** Test/diagnostic access to a fire's spread state by hazard id. */
  fireFor(trackId: string): { front: SpreadFrontState; reach: number } | null {
    const f = this.effects.get(trackId)?.fire
    return f ? { front: f.front, reach: f.reach } : null
  }

  /** Test/diagnostic access to an animated sprite set by mesh name. */
  spriteFor(name: string): Sprite | null {
    for (const effect of this.effects.values()) {
      const sprite = effect.sprites.find((s) => s.mesh.name === name)
      if (sprite) return sprite
    }
    return null
  }

  cloudFor(trackId: string): readonly SmokePuff[] | null {
    return this.effects.get(trackId)?.cloud?.puffs ?? null
  }

  anchorFor(trackId: string, project: ProjectEffect): { x: number; y: number } | null {
    const effect = this.effects.get(trackId)
    const bounds = effect?.cloud?.sprites.bounds(project)
    if (bounds) return { x: (bounds.left + bounds.right) / 2, y: bounds.top }
    const flames = effect?.sprites.find((s) => s.kind === 'flame')
    if (!flames) return null
    const visible = flames.points.flatMap((p, i) => flames.colors[i * 4 + 3] > 0.02 ? [project(p[0], Y_EFFECT + flames.matrices[i * 16 + 5], p[1])] : [])
    if (!visible.length) return null
    return { x: (Math.min(...visible.map((p) => p.x)) + Math.max(...visible.map((p) => p.x))) / 2, y: Math.min(...visible.map((p) => p.y)) }
  }

  pickCloud(x: number, y: number, project: ProjectEffect): string | null {
    for (const [id, effect] of [...this.effects].reverse()) if (effect.cloud?.sprites.hit(x, y, project)) return id
    return null
  }

  dispose(): void {
    for (const effect of this.effects.values()) this.destroy(effect)
    this.effects.clear()
  }

  private destroy(effect: Effect): void {
    effect.cloud?.sprites.dispose()
    effect.cloud?.shadow.dispose()
    for (const mesh of effect.meshes) mesh.dispose(false, false)
    for (const material of effect.materials) material.dispose()
  }

  private build(h: HazardTrack, preview: boolean): Effect | null {
    const rings = (h.footprint ?? []).map((ring) => ring.flatMap(([lon, lat]) => this.frame.lonLatToWorld(lon, lat)))
    if (!rings.length || rings[0].length < 6 || !rings.every((ring) => ring.every(Number.isFinite))) return null
    const id = h.track_id
    const kind: HazardKind = h.kind ?? 'storm'
    const radius = Number.isFinite(h.radius_m) ? h.radius_m : 60
    // Bigger zones get taller rain, wider ripples and a higher cloud so the effect reads at strategic zoom.
    const scale = Math.min(5, Math.max(1, radius / 60))
    const effect: Effect = { key: keyFor(h, preview), meshes: [], materials: [], sprites: [], fire: null, storm: null, cloud: null, seed: hash01(id) * Math.PI * 2 }
    const solid = (name: string, alpha: number, build: (b: Batch) => void, uvs = false, front?: SpreadFrontState): Mesh => {
      const mat = effectMaterial(`${name}-mat`, this.scene, alpha, preview, front)
      const b = new Batch()
      build(b)
      const mesh = meshOf(name, this.scene, b, mat, uvs)
      if (preview) mesh.visibility = 0.85
      effect.meshes.push(mesh)
      effect.materials.push(mat)
      return mesh
    }

    if (kind === 'flood') {
      solid(`hazard-flood-water-${id}`, 0.65, (b) => b.polygon(rings[0], rings.slice(1), Y_EFFECT, [0.14, 0.42, 0.78]))
      return effect
    }

    if (kind === 'fire') {
      // The fire starts at the placed centre and spreads to the footprint edge as the replay clock advances.
      const path = (h.shape === 'polygon' ? h.waypoints.slice(0, 1) : h.waypoints).slice(0, MAX_FIRE_POINTS).map(([lon, lat]) => this.frame.lonLatToWorld(lon, lat))
      if (!path.length) path.push([rings[0][0], rings[0][1]])
      const source = path[0]
      let reach = 1
      for (const ring of rings) for (let i = 0; i < ring.length; i += 2) reach = Math.max(reach, distanceToStroke([ring[i], ring[i + 1]], path))
      if (id === 'weather-guide' && h.shape !== 'polygon') reach = h.radius_m
      const pathUniform = new Float32Array(MAX_FIRE_POINTS * 2)
      pathUniform.set(path.flat())
      const front: SpreadFrontState = { source, path, pathUniform, front: 0, band: Math.max(FIRE_BAND_MIN_M, reach * 0.12), crest: GLOW, crestStrength: 0.7 }
      const scorch = solid(`hazard-fire-scorch-${id}`, 0.68, (b) => b.polygon(rings[0], rings.slice(1), Y_EFFECT, SCORCH), false, front)
      const glow = solid(`hazard-fire-glow-${id}`, 0.22, (b) => b.polygon(rings[0], rings.slice(1), Y_EFFECT + 0.06, GLOW), false, front)
      effect.fire = { scorch, glow, glowMat: glow.material as StandardMaterial, front, reach, start_s: h.start_s, end_s: h.end_s, preview, born: this.previewFireSince ?? this.time }
      const inside = ([x, z]: Point) => pointInRing(x, z, rings[0]) && !rings.slice(1).some((r) => pointInRing(x, z, r))
      const ignition = strokeSamples(path, Math.max(3, reach * 0.08)).filter(inside)
      const sampled = sampleHazardPoints(rings, `${id}:flame`, instanceCount(kind, rings)).filter((p) => distanceToStroke(p, path) <= reach)
      const flamePts = [...ignition, ...sampled].slice(0, MAX_INSTANCES)
      const wind: Point = [0.35, 0.12]
      effect.sprites.push(
        this.sprite(`hazard-fire-flame-${id}`, effect, flamePts, 'flame', scale, 18, 1.7, wind, FLAME, preview, fireParticleQuad),
        this.sprite(`hazard-fire-core-${id}`, effect, flamePts, 'flameCore', scale, 11, 2.3, wind, FLAME_CORE, preview, fireParticleQuad),
        this.sprite(`hazard-fire-ember-${id}`, effect, sampleHazardPoints(rings, `${id}:ember`, Math.max(12, Math.min(300, Math.round(footprintArea(rings) / 260)))), 'ember', scale, 32, 0.4, [wind[0] * 40, wind[1] * 40], EMBER, preview, (b) => b.walls([-0.3, -0.3, 0.3, -0.3, 0.3, 0.3, -0.3, 0.3], undefined, 0, 0.6, EMBER, 1)),
        this.sprite(`hazard-fire-smoke-${id}`, effect, sampleHazardPoints(rings, `${id}:smoke`, Math.max(6, Math.min(80, Math.round(footprintArea(rings) / 1500)))), 'smoke', scale, 72, 0.11, [wind[0] * 90, wind[1] * 90], SMOKE, preview, fireParticleQuad),
      )
      return effect
    }

    const storm = kind === 'storm'
    const top = Math.min(220, Math.max(80, 60 + radius * 0.5))
    const wind: Point = [0, 0]
    const points = sampleHazardPoints(rings, id, instanceCount(kind, rings))
    const drop = storm ? 0.34 : 0.26
    const length = (storm ? 22 : 14) * (0.6 + 0.4 * scale)
    const speed = storm ? 1.2 : 0.75
    effect.sprites.push(
      this.sprite(`hazard-${kind}-rain-${id}`, effect, points, 'rain', scale, top, speed, wind, RAIN, preview, (b) => {
        b.walls([-drop, -drop, drop, -drop, drop, drop, -drop, drop], undefined, 0, length, RAIN, 1)
      }),
      this.sprite(`hazard-${kind}-splash-${id}`, effect, points, 'splash', scale, top, speed, wind, FOAM, preview, (b) => ring(b, 1, 0.16)),
    )
    effect.sprites[1].phases.set(effect.sprites[0].phases)

    // Both rain and storms sit under soft particles: white for rain, dark and lightning-lit for storms.
    const area = Math.max(1, footprintArea(rings))
    const size = Math.max(14, radius * 0.48, Math.sqrt(area / Math.PI) * 0.48)
    const count = Math.max(8, Math.min(MAX_CLOUD_CLUSTERS, Math.round(area / (size * size * 1.9))))
    const centers = cloudCenters(rings, `${id}:cloud`, count)
    const seeds = Array.from({ length: centers.length * (storm ? 18 : 14) }, (_, i) => ({
      point: centers[i % centers.length], a: hash01(`${id}:a:${i}`), b: hash01(`${id}:b:${i}`), c: hash01(`${id}:c:${i}`), d: hash01(`${id}:d:${i}`),
    }))
    effect.cloud = {
      sprites: new SmokeSprites(this.scene, `hazard-${kind}-cloud-${id}`),
      shadow: new SmokeSprites(this.scene, `hazard-${kind}-shadow-${id}`, true),
      points: centers, seeds, size, height: top, storm, preview, puffs: [],
    }
    const depth = this.scene.getEngine().useReverseDepthBuffer ? Constants.GEQUAL : Constants.LEQUAL
    for (const sprite of effect.sprites) {
      sprite.mesh.renderingGroupId = 0
      sprite.mesh.alphaIndex = 2
      sprite.mesh.material!.depthFunction = depth
    }
    if (storm) {
      const strikes = sampleHazardPoints(rings, `${id}:bolt`, Math.max(2, Math.min(6, Math.round(footprintArea(rings) / 8000))))
      const bolts = strikes.map(([x, z], i) => {
        const seed = `${id}:bolt:${i}`
        const path = boltPath(seed, x, z, top, top * 0.12)
        const width = 1.1 + 0.5 * scale
        const core = solid(`hazard-storm-bolt-${id}-${i}`, 1, (b) => {
          boltGeometry(b, path, width, BOLT)
          // one fork off the middle of the bolt
          const k = Math.floor(path.length / 2)
          boltGeometry(b, boltPath(`${seed}:fork`, path[k][0], path[k][2], path[k][1], top * 0.09).slice(0, 5), width * 0.6, BOLT)
        })
        const glow = solid(`hazard-storm-glow-${id}-${i}`, 0.45, (b) => boltGeometry(b, path, width * 3.5, BOLT_GLOW))
        const flash = solid(`hazard-storm-flash-${id}-${i}`, 0.55, (b) => b.disc(path[path.length - 1][0], path[path.length - 1][2], 6 + 6 * scale, Y_EFFECT + 0.08, BOLT, 24))
        for (const m of [core, glow, flash]) {
          m.renderingGroupId = 0
          m.alphaIndex = 2
          m.material!.depthFunction = depth
          m.setEnabled(false)
        }
        return { core, glow, flash, phase: hash01(`${seed}:phase`) * 10, period: 3.5 + hash01(`${seed}:period`) * 4 }
      })
      effect.storm = { bolts }
    }
    return effect
  }

  private sprite(name: string, effect: Effect, points: Point[], kind: Sprite['kind'], scale: number, height: number, speed: number, wind: Point, base: RGB, preview: boolean, build: (b: Batch) => void): Sprite {
    const procedural = kind === 'flame' || kind === 'flameCore' || kind === 'smoke'
    const mat = procedural ? fireParticleMaterial(`${name}-mat`, this.scene, kind, preview) : effectMaterial(`${name}-mat`, this.scene, 1, preview)
    mat.transparencyMode = Material.MATERIAL_ALPHABLEND
    const b = new Batch()
    build(b)
    const mesh = meshOf(name, this.scene, b, mat, procedural)
    mesh.alwaysSelectAsActiveMesh = true
    mesh.thinInstanceEnablePicking = false
    mesh.hasVertexAlpha = true
    const n = Math.max(1, points.length)
    const matrices = new Float32Array(n * 16)
    const colors = new Float32Array(n * 4)
    const phases = new Float32Array(points.length)
    for (let i = 0; i < points.length; i++) phases[i] = hash01(`${name}:${i}`)
    mesh.thinInstanceSetBuffer('matrix', matrices, 16, false)
    mesh.thinInstanceSetBuffer('color', colors, 4, false)
    mesh.thinInstanceCount = points.length
    if (preview) mesh.visibility = 0.85
    effect.meshes.push(mesh)
    effect.materials.push(mat)
    const ignitionDistances = effect.fire ? new Float32Array(points.map((p) => distanceToStroke(p, effect.fire!.front.path))) : undefined
    return { mesh, matrices, colors, points, phases, kind, scale, height, speed, wind, base, ignitionDistances }
  }

  private animateEffect(effect: Effect): void {
    const t = this.time
    const fire = effect.fire
    if (fire) {
      // Spread is driven by the replay clock: the burning edge races out early and eases towards the footprint
      // edge, reaching it at FIRE_SPREAD_FRACTION of the window; scrubbing back shrinks it again. Previews ignite
      // along the stroke. Flicker and the pulsing glow run on wall time so a paused replay still burns.
      const previewTime = Math.min(fire.end_s - 0.001, Math.max(this.simT, fire.start_s + t - fire.born))
      const progress = fireSpreadProgress(fire, fire.preview ? previewTime : this.simT, false, FIRE_SPREAD_FRACTION)
      fire.front.front = fire.front.band + progress * fire.reach
      fire.glowMat.alpha = (0.16 + 0.1 * (0.5 + 0.5 * Math.sin(t * 7 + effect.seed)) + 0.06 * Math.sin(t * 23 + effect.seed * 3)) * (fire.preview ? 0.65 : 1)
    }
    for (const sprite of effect.sprites) this.animateSprite(sprite, effect)
    const storm = effect.storm
    let lit = 0
    if (storm) {
      for (const bolt of storm.bolts) {
        const phase = (t + bolt.phase) % bolt.period
        const on = phase < 0.4 && Math.sin(t * 60 + bolt.phase) > -0.55
        for (const m of [bolt.core, bolt.glow, bolt.flash]) m.setEnabled(on)
        if (on) lit = Math.max(lit, 1 - phase / 0.4)
      }
    }
    const cloud = effect.cloud
    if (cloud) {
      const color = cloud.storm ? STORM_CLOUD : RAIN_CLOUD
      cloud.puffs = cloud.seeds.map((seed, i) => {
        const phase = seed.a * Math.PI * 2 + effect.seed
        const width = cloud.size * (1.65 + seed.b * 0.75) * (1 + 0.04 * Math.sin(t * 0.2 + phase))
        return {
          x: seed.point[0] + Math.cos(phase + t * 0.035) * cloud.size * 0.22,
          z: seed.point[1] + Math.sin(phase + t * 0.027) * cloud.size * 0.18,
          y: cloud.height + (seed.c - 0.2) * cloud.size * 0.48 + Math.sin(t * 0.16 + phase) * cloud.size * 0.07,
          width, height: width * (0.5 + seed.d * 0.23), angle: phase + t * (0.018 + seed.d * 0.014),
          color: color.map((c) => Math.min(1.2, c * (0.94 + 0.06 * seed.c) + lit * 0.38)) as RGB,
          alpha: (i % 5 === 0 ? 0.11 : 0.36) * (cloud.storm ? 1.2 : 1) * (cloud.preview ? 0.8 : 1),
        }
      })
      cloud.sprites.draw(cloud.puffs)
      cloud.shadow.draw(cloud.points.slice(0, 4).map(([x, z], i) => ({
        x, y: Y_EFFECT, z, width: cloud.size * 4.5, height: cloud.size * 3.8, angle: i * 1.7,
        color: [0.07, 0.08, 0.1], alpha: (cloud.storm ? 0.13 : 0.08) * (cloud.preview ? 0.7 : 1),
      })))
    }
  }

  private animateSprite(s: Sprite, effect: Effect): void {
    const t = this.time
    if (s.mesh.material instanceof ShaderMaterial) s.mesh.material.setFloat('time', t)
    const k = s.scale
    for (let i = 0; i < s.points.length; i++) {
      const [x, z] = s.points[i]
      const p = s.phases[i]
      const cycle = (t * s.speed + p) % 1
      if (s.kind === 'rain') {
        // Drops fall along the wind, fading in near the top and out just before the splash.
        const fall = cycle
        const alpha = Math.min(1, fall / 0.15) * Math.min(1, (1 - fall) / 0.08) * 0.9
        writeInstance(s.matrices, i, x + s.wind[0] * (fall - 1), Y_EFFECT + s.height * (1 - fall), z + s.wind[1] * (fall - 1), Math.atan2(s.wind[0], s.wind[1]), 1 + (k - 1) * 0.5, 1)
        writeColor(s.colors, i, s.base, alpha)
      } else if (s.kind === 'splash') {
        // A ring expands and fades where the drop just landed, during the first part of the next cycle.
        const q = cycle / 0.22
        const live = q < 1
        writeInstance(s.matrices, i, x, Y_EFFECT + 0.1, z, 0, live ? k * (0.4 + 2.4 * q) : 0, 1)
        writeColor(s.colors, i, s.base, live ? (1 - q) * 0.85 : 0)
      } else {
        // Fire sprites only live where the burning edge has passed; everything flickers on wall time.
        const fire = effect.fire
        const reached = fire ? Math.min(1, Math.max(0, (fire.front.front - s.ignitionDistances![i]) / fire.front.band)) : 1
        const wobble = Math.sin(t * 11 + p * 60) * 0.5 + Math.sin(t * 17 + p * 23) * 0.5
        if (s.kind === 'flame' || s.kind === 'flameCore') {
          const flick = 0.55 + 0.45 * (0.5 + 0.5 * wobble)
          const size = (s.kind === 'flame' ? 1 : 0.8) * (0.7 + 0.3 * k)
          writeInstance(s.matrices, i, x, Y_EFFECT, z, 0, size * (s.kind === 'flame' ? 7 : 4) * (0.75 + 0.25 * flick), s.height * size * flick)
          writeColor(s.colors, i, s.base, reached * (s.kind === 'flame' ? 0.82 : 0.95) * (0.75 + 0.25 * flick))
        } else if (s.kind === 'ember') {
          // Sparks rise on the heat, drift with the wind and wink out.
          const rise = cycle
          const drift = Math.sin(t * 3 + p * 50) * 2.5
          writeInstance(s.matrices, i, x + s.wind[0] * rise + drift, Y_EFFECT + 1 + s.height * k * rise, z + s.wind[1] * rise + drift * 0.6, 0, 0.8 + 0.4 * k, 1)
          writeColor(s.colors, i, s.base, reached * (1 - rise) * (0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 25 + p * 90))))
        } else {
          // Smoke puffs rise, swell and thin out downwind.
          const rise = cycle
          const grow = k * (2.5 + 14 * rise)
          writeInstance(s.matrices, i, x + s.wind[0] * rise, Y_EFFECT + 6 + s.height * k * rise, z + s.wind[1] * rise, p * Math.PI * 2, grow, grow * 0.9)
          writeColor(s.colors, i, s.base, reached * 0.55 * (1 - rise) * Math.min(1, rise / 0.08))
        }
      }
    }
    s.mesh.thinInstanceBufferUpdated('matrix')
    s.mesh.thinInstanceBufferUpdated('color')
  }
}

/** Flat annulus on the ground, outer radius `r`, band width `w`. */
function ring(b: Batch, r: number, w: number): void {
  const outer: number[] = []
  const inner: number[] = []
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2
    outer.push(Math.cos(a) * r, Math.sin(a) * r)
    inner.push(Math.cos(a) * (r - w), Math.sin(a) * (r - w))
  }
  b.polygon(outer, [inner], 0, [1, 1, 1])
}
