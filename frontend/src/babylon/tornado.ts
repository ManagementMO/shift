/**
 * The tornado: what a declared moving hazard looks like on the Babylon city.
 *
 * Three translucent funnel shells with helical streaks (so the spin reads), a wall cloud the funnel hangs from,
 * a spiral of thin-instanced debris, a dust skirt and a ground shadow, all posed from the simulation clock and
 * the hazard's own waypoints — the same centre the backend footprint and the replay use.  Buildings along the
 * path are handed to `Damage`, which sways and fells them on the same clock.  Purely presentational: the roads
 * the simulation closes are the footprint edges drawn by the overlay.
 */

import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { CreateSphereVertexData } from '@babylonjs/core/Meshes/Builders/sphereBuilder'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import type { Scene } from '@babylonjs/core/scene'

import type { HazardTrack } from '../types'
import { Y, type CityMeshes } from './city'
import type { WorldFrame } from './coords'
import { cubeVertexData, Damage, DISPLAY_SCALE, planDamage, stormCenter, ThinSet, type Destructible, type StormCenter, type StormPath } from './destruction'
import { Batch, hash01, mix, type RGB } from './geometry'
import { SmokeSprites } from './smoke'
import { vortexSmoke } from './vortex'
import { tornadoDamage, tornadoHeight, tornadoPower, type TornadoTrack } from './tornadoPlacement'
import type { WorldData } from './worldData'

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const smooth = (x: number): number => {
  const k = clamp(x, 0, 1)
  return k * k * (3 - 2 * k)
}

/** Funnel radius at height fraction `u` (0 ground, 1 cloud base) for a footprint radius `R`. */
export function funnelRadius(R: number, u: number): number {
  return R * (0.07 + 0.25 * Math.sqrt(u) + 0.36 * u ** 3)
}

export function funnelHeight(R: number): number {
  return tornadoHeight(R)
}

/** A hazard track in world metres. */
export function hazardPath(frame: WorldFrame, h: HazardTrack): StormPath {
  return { points: h.waypoints.map(([lon, lat]) => frame.lonLatToWorld(lon, lat)), radius: h.radius_m, start: h.start_s, end: h.end_s }
}

export function hazardKey(h: TornadoTrack): string {
  return `${h.track_id}|${h.radius_m}|${tornadoPower(h.power)}|${h.start_s}|${h.end_s}|${h.waypoints.map((w) => w.join(',')).join(';')}`
}

interface ShellSpec {
  scale: number
  alpha: number
  spin: number
  streaks: number
  dark: RGB
  light: RGB
  alphaIndex: number
}

const SHELLS: ShellSpec[] = [
  { scale: 0.55, alpha: 0.62, spin: -0.38, streaks: 5, dark: [0.26, 0.25, 0.26], light: [0.5, 0.5, 0.53], alphaIndex: 1 },
  { scale: 0.85, alpha: 0.32, spin: -0.27, streaks: 7, dark: [0.34, 0.33, 0.34], light: [0.62, 0.62, 0.65], alphaIndex: 2 },
  { scale: 1.15, alpha: 0.15, spin: -0.18, streaks: 9, dark: [0.42, 0.41, 0.42], light: [0.72, 0.72, 0.75], alphaIndex: 3 },
]

/** One open funnel shell: radial noise and helical colour streaks make the rotation visible. */
export function funnelVertexData(R: number, H: number, spec: Pick<ShellSpec, 'streaks' | 'dark' | 'light'>, seed: number, rings = 28, segs = 48): VertexData {
  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  for (let j = 0; j <= rings; j++) {
    const u = j / rings
    const r0 = funnelRadius(R, u)
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2
      const noise = 1 + 0.1 * Math.sin(3 * a + u * 7 + seed * 6) + 0.06 * Math.sin(5 * a - u * 11 + seed * 2)
      const r = r0 * noise
      const streak = 0.5 + 0.5 * Math.sin(spec.streaks * a + u * 9 + seed)
      const c = mix(spec.dark, spec.light, u)
      const k = 0.85 + 0.3 * streak
      positions.push(Math.cos(a) * r, u * H, Math.sin(a) * r)
      normals.push(Math.cos(a), 0.2, Math.sin(a))
      colors.push(c[0] * k, c[1] * k, c[2] * k, 1)
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i
      const b = a + segs + 1
      indices.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  const vd = new VertexData()
  vd.positions = new Float32Array(positions)
  vd.normals = new Float32Array(normals)
  vd.colors = new Float32Array(colors)
  vd.indices = new Uint16Array(indices)
  return vd
}

/** Flat ground annulus with per-segment shade so it visibly turns. */
function annulusVertexData(rOuter: number, rInner: number, base: RGB, seed: number, segs = 40): VertexData {
  const b = new Batch()
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2
    const a1 = ((i + 1) / segs) * Math.PI * 2
    const k = 0.8 + 0.4 * hash01(`${seed}:${i}`)
    const c: RGB = [base[0] * k, base[1] * k, base[2] * k]
    const ring = [Math.cos(a0) * rOuter, Math.sin(a0) * rOuter, Math.cos(a1) * rOuter, Math.sin(a1) * rOuter, Math.cos(a1) * rInner, Math.sin(a1) * rInner, Math.cos(a0) * rInner, Math.sin(a0) * rInner]
    b.polygon(ring, undefined, 0, c)
  }
  const vd = new VertexData()
  vd.positions = new Float32Array(b.positions)
  vd.normals = new Float32Array(b.normals)
  vd.colors = new Float32Array(b.colors)
  vd.indices = new Uint16Array(b.indices)
  return vd
}

/** Vertex-coloured, unlit, translucent, no depth write: smoke-like surfaces that never occlude each other. */
function unlit(name: string, scene: Scene, alpha: number): StandardMaterial {
  const m = new StandardMaterial(name, scene)
  m.disableLighting = true
  m.emissiveColor = Color3.White()
  m.diffuseColor = Color3.Black()
  m.specularColor = Color3.Black()
  m.alpha = alpha
  m.backFaceCulling = false
  m.disableDepthWrite = true
  return m
}

function unlitMesh(name: string, scene: Scene, vd: VertexData, mat: StandardMaterial, alphaIndex: number): Mesh {
  const mesh = new Mesh(name, scene)
  vd.applyToMesh(mesh, false)
  mesh.material = mat
  mesh.isPickable = false
  mesh.receiveShadows = false
  mesh.alphaIndex = alphaIndex
  mesh.alwaysSelectAsActiveMesh = true
  return mesh
}

const DEBRIS_COUNT = 260
const SCRATCH = { s: new Vector3(), q: new Quaternion(), p: new Vector3(), m: new Matrix(), axis: new Vector3() }

/** One storm: funnel + effects + the buildings it reaches. */
export class Storm {
  readonly path: StormPath
  readonly R: number
  readonly H: number
  readonly power: number
  readonly damage: Damage
  readonly root: TransformNode
  private readonly shells: { mesh: Mesh; mat: StandardMaterial; spec: ShellSpec }[] = []
  private readonly cloud: Mesh
  private readonly cloudMat: StandardMaterial
  private readonly skirts: { mesh: Mesh; mat: StandardMaterial; alpha: number; spin: number }[] = []
  private readonly shadow: Mesh
  private readonly trail: Mesh | null
  private readonly debris: ThinSet
  private readonly smoke: SmokeSprites
  private readonly seed: number
  visible = true

  constructor(scene: Scene, city: CityMeshes, world: WorldData, path: StormPath, key: string, shadows: ShadowGenerator | null, plan = planDamage(world, path), power = 3) {
    this.path = path
    this.R = path.radius
    this.power = tornadoPower(power)
    this.H = tornadoHeight(this.R, this.power)
    this.seed = hash01(key)
    this.root = new TransformNode(`storm-${key.slice(0, 24)}`, scene)
    this.root.rotationQuaternion = Quaternion.Identity()
    for (const spec of SHELLS) {
      const mat = unlit(`funnel-mat-${spec.alphaIndex}`, scene, spec.alpha)
      const mesh = unlitMesh(`funnel-${spec.alphaIndex}`, scene, funnelVertexData(this.R * spec.scale, this.H, spec, this.seed + spec.alphaIndex), mat, spec.alphaIndex)
      mesh.parent = this.root
      mesh.setEnabled(false)
      this.shells.push({ mesh, mat, spec })
    }
    this.cloudMat = unlit('wall-cloud-mat', scene, 0.55)
    const cloudVd = CreateSphereVertexData({ diameter: 2, segments: 12 })
    const n = cloudVd.positions!.length / 3
    const cc = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) {
      const k = 0.36 + 0.1 * hash01(`cloud:${i}`)
      cc.set([k, k, k + 0.02, 1], i * 4)
    }
    cloudVd.colors = cc
    this.cloud = unlitMesh('wall-cloud', scene, cloudVd, this.cloudMat, 4)
    for (const [i, s] of [
      { r: this.R * 0.62, w: this.R * 0.34, alpha: 0.34, spin: -0.22, color: [0.55, 0.52, 0.48] as RGB },
      { r: this.R * 1.0, w: this.R * 0.4, alpha: 0.16, spin: -0.13, color: [0.62, 0.6, 0.56] as RGB },
    ].entries()) {
      const mat = unlit(`skirt-mat-${i}`, scene, s.alpha)
      const mesh = unlitMesh(`skirt-${i}`, scene, annulusVertexData(s.r, s.r - s.w, s.color, this.seed * 100 + i), mat, 0)
      this.skirts.push({ mesh, mat, alpha: s.alpha, spin: s.spin })
    }
    const shadowMat = unlit('funnel-shadow-mat', scene, 0.28)
    const shadowBatch = new Batch()
    shadowBatch.disc(0, 0, this.R * 0.5, 0, [0.12, 0.12, 0.14], 32)
    const shadowVd = new VertexData()
    shadowVd.positions = new Float32Array(shadowBatch.positions)
    shadowVd.normals = new Float32Array(shadowBatch.normals)
    shadowVd.colors = new Float32Array(shadowBatch.colors)
    shadowVd.indices = new Uint16Array(shadowBatch.indices)
    this.shadow = unlitMesh('funnel-shadow', scene, shadowVd, shadowMat, 0)
    if (path.points.length > 1) {
      const trailBatch = new Batch()
      trailBatch.ribbon(path.points.flat(), Math.max(6, this.R * 0.08), Y.junction + 0.22, [0.2, 0.2, 0.22])
      const trailVd = new VertexData()
      trailVd.positions = new Float32Array(trailBatch.positions)
      trailVd.normals = new Float32Array(trailBatch.normals)
      trailVd.colors = new Float32Array(trailBatch.colors)
      trailVd.indices = new Uint16Array(trailBatch.indices)
      this.trail = unlitMesh('storm-trail', scene, trailVd, unlit('storm-trail-mat', scene, 0.3), 0)
    } else this.trail = null
    const debrisMat = new StandardMaterial('funnel-debris-mat', scene)
    debrisMat.diffuseColor = Color3.White()
    debrisMat.ambientColor = new Color3(0.8, 0.8, 0.8)
    debrisMat.specularColor = Color3.Black()
    this.debris = new ThinSet(scene, 'funnel-debris', cubeVertexData(), debrisMat)
    this.debris.reserve(Math.ceil(DEBRIS_COUNT * 1.3))
    this.smoke = new SmokeSprites(scene, 'tornado-smoke')
    this.damage = new Damage(scene, city, path, plan, shadows)
    this.show(false)
  }

  private show(on: boolean): void {
    if (on === this.visible) return
    this.visible = on
    this.root.setEnabled(on)
    this.cloud.setEnabled(false)
    this.shadow.setEnabled(false)
    for (const s of this.skirts) s.mesh.setEnabled(false)
    if (!on) {
      this.debris.commit(0)
      this.smoke.draw([])
    }
  }

  update(t: number): void {
    const c = stormCenter(this.path, t)
    this.damage.update(t, c)
    if (!c) {
      this.show(false)
      return
    }
    this.show(true)
    this.pose(t, c)
  }

  private pose(t: number, c: StormCenter): void {
    const span = Math.max(1, this.path.end - this.path.start)
    const edge = Math.max(20, span * 0.06)
    const ramp = smooth((t - this.path.start) / edge) * smooth((this.path.end - t) / edge)
    const wobbleX = Math.sin(t * 0.23 + this.seed * 5) * this.R * 0.05
    const wobbleZ = Math.cos(t * 0.19 + this.seed * 3) * this.R * 0.05
    const lift = (1 - ramp) * this.H * 0.35
    this.root.position.set(c.x + wobbleX, Y.road + lift, c.z + wobbleZ)
    const sy = 0.4 + 0.6 * ramp
    this.root.scaling.set(0.55 + 0.45 * ramp, sy, 0.55 + 0.45 * ramp)
    const tilt = 0.1 + 0.05 * Math.sin(t * 0.07 + this.seed)
    SCRATCH.axis.set(c.dir[1], 0, -c.dir[0])
    Quaternion.RotationAxisToRef(SCRATCH.axis, tilt, this.root.rotationQuaternion!)
    for (const s of this.shells) {
      s.mesh.rotation.y = t * s.spec.spin
      s.mat.alpha = s.spec.alpha * (0.3 + 0.7 * ramp)
    }
    // the cloud base sits over the leaned top of the funnel
    const top = this.H * sy
    const leanX = c.dir[0] * Math.sin(tilt) * top
    const leanZ = c.dir[1] * Math.sin(tilt) * top
    this.cloud.position.set(c.x + wobbleX + leanX, this.root.position.y + top * 0.97, c.z + wobbleZ + leanZ)
    this.cloud.scaling.set(this.R * 1.7 * (0.6 + 0.4 * ramp), this.H * 0.06, this.R * 1.7 * (0.6 + 0.4 * ramp))
    this.cloud.rotation.y = -t * 0.05
    this.cloudMat.alpha = 0.55 * (0.4 + 0.6 * ramp)
    for (const s of this.skirts) {
      s.mesh.position.set(c.x, Y.junction + 0.3, c.z)
      s.mesh.rotation.y = t * s.spin
      const pulse = 1 + 0.08 * Math.sin(t * 0.3 + this.seed)
      s.mesh.scaling.set(pulse, 1, pulse)
      s.mat.alpha = s.alpha * ramp
    }
    this.shadow.position.set(c.x, Y.junction + 0.14, c.z)
    this.shadow.scaling.set(ramp, 1, ramp)
    // debris spirals up the outside of the funnel; faster near the ground, following the lean
    const force = 0.7 + this.power * 0.1
    const count = Math.round(DEBRIS_COUNT * ramp * force)
    for (let i = 0; i < count; i++) {
      const s1 = hash01(`debris:${i}:a`)
      const s2 = hash01(`debris:${i}:b`)
      const s3 = hash01(`debris:${i}:c`)
      const s4 = hash01(`debris:${i}:d`)
      const s5 = hash01(`debris:${i}:e`)
      const u = (t * (0.06 + 0.04 * s1) + s2) % 1
      const y = u * this.H * 0.9 * sy
      const a = -(t * (0.45 + 0.35 * s3)) / (0.35 + u) + s4 * Math.PI * 2
      const r = funnelRadius(this.R, u) * (1.05 + 0.5 * s5) * this.root.scaling.x + this.R * 0.05
      const lx = c.dir[0] * Math.sin(tilt) * y
      const lz = c.dir[1] * Math.sin(tilt) * y
      SCRATCH.p.set(this.root.position.x + Math.cos(a) * r + lx, this.root.position.y + y, this.root.position.z + Math.sin(a) * r + lz)
      SCRATCH.s.set(1 + 2.5 * s1, 0.3 + 0.5 * s2, 1 + 2.5 * s3)
      Quaternion.RotationYawPitchRollToRef(a + t * 2 * s4, t * 1.3 * s5, 0, SCRATCH.q)
      Matrix.ComposeToRef(SCRATCH.s, SCRATCH.q, SCRATCH.p, SCRATCH.m)
      this.debris.set(i, SCRATCH.m, mix([0.35, 0.33, 0.3], [0.62, 0.6, 0.57], s5))
    }
    this.debris.commit(count)
    const growth = 0.25 + 0.75 * smooth((t - this.path.start) / Math.min(30, span * 0.15))
    this.smoke.draw(vortexSmoke({
      x: c.x, z: c.z, radius: this.R * growth, height: this.H * (0.55 + growth * 0.45),
      direction: c.dir, seconds: (t - this.path.start) / DISPLAY_SCALE * force,
      strength: ramp * force, seed: this.seed,
    }))
  }

  dispose(): void {
    this.smoke.dispose()
    this.damage.dispose()
    for (const s of this.shells) {
      s.mesh.dispose()
      s.mat.dispose()
    }
    this.cloud.dispose()
    this.cloudMat.dispose()
    for (const s of this.skirts) {
      s.mesh.dispose()
      s.mat.dispose()
    }
    this.shadow.material?.dispose()
    this.shadow.dispose()
    this.trail?.material?.dispose()
    this.trail?.dispose()
    this.debris.dispose()
    this.root.dispose()
  }
}

/** Keeps one `Storm` per distinct hazard track (scenario hazards plus the unconfirmed ghost). */
export class StormSystem {
  private readonly scene: Scene
  private readonly frame: WorldFrame
  private readonly world: WorldData
  private readonly city: CityMeshes
  private readonly shadows: ShadowGenerator | null
  private readonly storms = new Map<string, Storm>()

  constructor(scene: Scene, frame: WorldFrame, world: WorldData, city: CityMeshes, shadows: ShadowGenerator | null) {
    this.scene = scene
    this.frame = frame
    this.world = world
    this.city = city
    this.shadows = shadows
  }

  get count(): number {
    return this.storms.size
  }

  storm(h: TornadoTrack): Storm | undefined {
    return this.storms.get(hazardKey(h))
  }

  setHazards(hazards: TornadoTrack[]): void {
    const valid = hazards.filter((h) => h.waypoints.length > 0 && h.radius_m > 0 && h.end_s > h.start_s
      && [h.radius_m, h.start_s, h.end_s, ...h.waypoints.flat()].every(Number.isFinite))
    const wanted = new Map(valid.map((h) => [hazardKey(h), h]))
    if (wanted.size === this.storms.size && [...wanted.keys()].every((key) => this.storms.has(key))) return
    this.dispose()
    const ordered = [...wanted].sort(([a, ha], [b, hb]) => ha.start_s - hb.start_s || a.localeCompare(b))
    const prepared = ordered.map(([key, h]) => {
      const path = hazardPath(this.frame, h)
      return { key, h, path, plan: planDamage(this.world, path, tornadoDamage(h.power)) }
    })
    const owners = new Map<string, { key: string; damage: Destructible }>()
    for (const storm of prepared) for (const damage of storm.plan) {
      const previous = owners.get(damage.key)?.damage
      if (!previous || (damage.collapse && (!previous.collapse || damage.tCollapse < previous.tCollapse))
        || (!damage.collapse && !previous.collapse && damage.tClosest < previous.tClosest)) {
        owners.set(damage.key, { key: storm.key, damage })
      }
    }
    for (const { key, h, path, plan } of prepared) {
      const own = plan.filter((d) => owners.get(d.key)?.key === key)
      this.storms.set(key, new Storm(this.scene, this.city, this.world, path, key, this.shadows, own, h.power))
    }
  }

  update(t: number): void {
    for (const s of this.storms.values()) s.update(t)
  }

  dispose(): void {
    for (const s of this.storms.values()) s.dispose()
    this.storms.clear()
  }
}
