import { Constants } from '@babylonjs/core/Engines/constants'
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer'
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder'
import { CreateDisc } from '@babylonjs/core/Meshes/Builders/discBuilder'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { Scene } from '@babylonjs/core/scene'
import { developmentRing } from '../development'
import type { Development } from '../types'
import { inside, type BuildingIndex } from './buildingIndex'
import { Y, type CityMeshes } from './city'
import { CityErasure } from './cityErasure'
import type { WorldFrame } from './coords'
import { boundaryDistance } from './geometry'
import type { Traffic } from './traffic'
import { LASER_DURATION, LASER_IMPACT_TIME, LASER_TIME_SCALE, laserEnvelope, type LaserCircle, type OrbitalImpact, type OrbitalStrike } from './orbitalLaserModel'
import type { Flat } from './worldData'

export { LASER_DURATION, LASER_IMPACT_TIME, laserEnvelope, laserRadius } from './orbitalLaserModel'
export type { OrbitalStrike, OrbitalImpact } from './orbitalLaserModel'

const BEAM_HEIGHT = 9000
const vertexSource = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
uniform mat4 world;
uniform mat4 worldViewProjection;
varying vec3 laserPosition;
varying vec3 laserNormal;
varying vec2 laserUV;
void main() {
  laserPosition = (world * vec4(position, 1.0)).xyz;
  laserNormal = normalize(mat3(world) * normal);
  laserUV = uv;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}
`
const beamFragment = `
precision highp float;
varying vec3 laserPosition;
varying vec3 laserNormal;
varying vec2 laserUV;
uniform vec3 eye;
uniform float age;
uniform float strength;
uniform float core;
void main() {
  vec3 view = normalize(eye - laserPosition);
  float rim = pow(1.0 - abs(dot(normalize(laserNormal), view)), 1.6);
  float strands = pow(0.5 + 0.5 * sin(laserUV.x * 150.8 + sin(laserPosition.y * 0.008 + age * 4.0)), 8.0);
  float flow = 0.88 + 0.12 * sin(laserPosition.y * 0.035 + age * 28.0);
  vec3 green = mix(vec3(0.025, 1.0, 0.12), vec3(0.62, 1.0, 0.72), core);
  gl_FragColor = vec4(green * (1.25 + strands * 0.8) * flow, strength * (0.26 + 0.4 * rim + 0.18 * strands));
}
`
const flareFragment = `
precision highp float;
varying vec2 laserUV;
uniform float strength;
uniform float age;
void main() {
  float r = length(laserUV * 2.0 - 1.0);
  float glow = pow(max(0.0, 1.0 - r), 1.4);
  float ring = exp(-pow((r - min(0.95, age * 2.5)) * 35.0, 2.0));
  gl_FragColor = vec4(0.1, 1.6, 0.28, strength * (glow * 0.8 + ring * 0.32));
}
`
const scarFragment = `
precision highp float;
varying vec3 laserPosition;
varying vec2 laserUV;
void main() {
  float r = length(laserUV * 2.0 - 1.0);
  float grain = fract(sin(dot(floor(laserPosition.xz * 2.0), vec2(12.9898, 78.233))) * 43758.5453);
  vec3 soil = mix(vec3(0.13, 0.15, 0.12), vec3(0.25, 0.26, 0.2), smoothstep(0.05, 1.0, r));
  gl_FragColor = vec4(soil + (grain - 0.5) * 0.028, 1.0);
}
`

function effectMaterial(scene: Scene, name: string, fragmentSource: string, transparent: boolean): ShaderMaterial {
  const material = new ShaderMaterial(name, scene, { vertexSource, fragmentSource }, {
    attributes: ['position', 'normal', 'uv'], uniforms: ['world', 'worldViewProjection', 'eye', 'age', 'strength', 'core'], needAlphaBlending: transparent,
  })
  material.backFaceCulling = false
  material.disableDepthWrite = transparent
  if (transparent) material.alphaMode = Constants.ALPHA_ADD
  return material
}

class LaserBeam {
  readonly shells: { mesh: Mesh; material: ShaderMaterial; radius: number; strength: number }[] = []
  readonly flare: Mesh
  readonly flareMaterial: ShaderMaterial

  constructor(scene: Scene, strike: OrbitalStrike, glow: GlowLayer) {
    for (const [i, radius, strength, core] of [[0, 1.06, 0.5, 0], [1, 0.96, 1, 0], [2, 0.55, 0.8, 1]]) {
      const mesh = CreateCylinder(`orbital-beam-${strike.id}-${i}`, { height: 1, diameter: 2, tessellation: 80, cap: Mesh.NO_CAP }, scene)
      const material = effectMaterial(scene, `orbital-light-${strike.id}-${i}`, beamFragment, true)
      material.setFloat('core', core)
      mesh.material = material
      mesh.position.set(strike.x, BEAM_HEIGHT / 2, strike.z)
      mesh.isPickable = false
      mesh.metadata = { orbitalGlow: 0 }
      mesh.setEnabled(false)
      glow.addIncludedOnlyMesh(mesh)
      this.shells.push({ mesh, material, radius: radius * strike.radius, strength })
    }
    this.flare = CreateDisc(`orbital-flare-${strike.id}`, { radius: strike.radius * 1.4, tessellation: 96 }, scene)
    this.flare.rotation.x = Math.PI / 2
    this.flare.position.set(strike.x, Y.stop + 0.15, strike.z)
    this.flare.isPickable = false
    this.flareMaterial = effectMaterial(scene, `orbital-flare-light-${strike.id}`, flareFragment, true)
    this.flare.material = this.flareMaterial
    this.flare.setEnabled(false)
  }

  update(age: number, eye: Vector3, pose: ReturnType<typeof laserEnvelope>): void {
    const bottom = BEAM_HEIGHT * pose.bottom
    for (const shell of this.shells) {
      shell.mesh.setEnabled(pose.intensity > 0)
      shell.mesh.scaling.set(shell.radius * pose.width, Math.max(0.01, BEAM_HEIGHT - bottom), shell.radius * pose.width)
      shell.mesh.position.y = (BEAM_HEIGHT + bottom) / 2 + Y.road
      shell.mesh.metadata.orbitalGlow = pose.intensity * shell.strength
      shell.material.setVector3('eye', eye)
      shell.material.setFloat('age', age / LASER_TIME_SCALE)
      shell.material.setFloat('strength', pose.intensity * shell.strength)
    }
    this.flare.setEnabled(pose.bottom === 0 && pose.intensity > 0)
    this.flare.scaling.setAll(pose.width)
    this.flareMaterial.setFloat('age', Math.max(0, age - LASER_IMPACT_TIME) / LASER_TIME_SCALE)
    this.flareMaterial.setFloat('strength', pose.intensity)
  }

  async prepare(): Promise<void> {
    await Promise.all([...this.shells.map(({ material, mesh }) => material.forceCompilationAsync(mesh)), this.flareMaterial.forceCompilationAsync(this.flare)])
  }

  dispose(glow: GlowLayer): void {
    for (const { mesh, material } of this.shells) { glow.removeIncludedOnlyMesh(mesh); mesh.dispose(); material.dispose() }
    this.flare.dispose()
    this.flareMaterial.dispose()
  }
}

interface AffectedObject {
  id: string
  distance: number
}

interface StrikeEffect {
  strike: OrbitalStrike
  circle: LaserCircle
  beam: LaserBeam | null
  scar: Mesh
  buildings: AffectedObject[]
  entities: AffectedObject[]
  developments: AffectedObject[]
  impacted: boolean
  completed: boolean
}

function footprintDistance(at: LaserCircle, ring: Flat, holes: Flat[] = []): number {
  return inside(at.x, at.z, ring, holes) ? 0 : Math.min(...[ring, ...holes].map(r => boundaryDistance(at.x, at.z, r)))
}

export class OrbitalLaserSystem {
  onImpact: (() => void) | null = null
  onComplete: ((id: string, impact: OrbitalImpact) => void) | null = null
  private readonly scene: Scene
  private readonly frame: WorldFrame
  private readonly city: CityMeshes
  private readonly buildings: BuildingIndex
  private readonly traffic: Traffic
  private readonly invalidateShadows: () => void
  private readonly erasure: CityErasure
  private readonly glow: GlowLayer
  private readonly scarMaterial: ShaderMaterial
  private readonly effects = new Map<string, StrikeEffect>()
  private erasedDevelopments = new Set<string>()
  private preparation: Promise<void> | null = null

  constructor(scene: Scene, frame: WorldFrame, city: CityMeshes, buildings: BuildingIndex, traffic: Traffic, invalidateShadows: () => void) {
    this.scene = scene
    this.frame = frame
    this.city = city
    this.buildings = buildings
    this.traffic = traffic
    this.invalidateShadows = invalidateShadows
    this.erasure = new CityErasure(scene)
    this.scarMaterial = effectMaterial(scene, 'orbital-scorched-ground', scarFragment, false)
    this.glow = new GlowLayer('orbital-glow', scene, { mainTextureRatio: 0.4, blurKernelSize: 32 })
    this.glow.intensity = 0.65
    this.glow.isEnabled = false
    this.glow.customEmissiveColorSelector = (mesh, _subMesh, _material, color) => {
      const value = mesh.metadata?.orbitalGlow ?? 0
      color.set(0.09 * value, value, 0.22 * value, 1)
    }
  }

  prepare(): Promise<void> {
    if (!this.preparation) {
      const beam = new LaserBeam(this.scene, { id: 'warmup', x: 0, z: 0, radius: 150, firedAt: 0 }, this.glow)
      this.preparation = beam.prepare().finally(() => beam.dispose(this.glow))
    }
    return this.preparation
  }

  setStrikes(strikes: readonly OrbitalStrike[], developments: readonly Development[] = []): void {
    const ids = new Set(strikes.map(strike => strike.id))
    let removed = false
    for (const [id, effect] of this.effects) {
      if (ids.has(id)) continue
      effect.beam?.dispose(this.glow)
      effect.scar.dispose()
      this.effects.delete(id)
      removed = true
    }
    if (removed) this.applyErasure()
    for (const strike of strikes) {
      if (this.effects.has(strike.id)) continue
      const scar = CreateDisc(`orbital-scar-${strike.id}`, { radius: strike.radius, tessellation: 128 }, this.scene)
      scar.rotation.x = Math.PI / 2
      scar.position.set(strike.x, Y.road + 0.06, strike.z)
      scar.material = this.scarMaterial
      scar.isPickable = false
      scar.setEnabled(false)
      this.effects.set(strike.id, {
        strike, circle: { x: strike.x, z: strike.z, radius: 0 }, scar,
        beam: new LaserBeam(this.scene, strike, this.glow), impacted: false, completed: false,
        buildings: this.buildings.inCircle(strike.x, strike.z, strike.radius).map(id => ({
          id, distance: Math.min(...this.buildings.building(id)!.prisms.map(p => footprintDistance(strike, p.ring, p.holes))),
        })),
        entities: this.traffic.idsInCircle(strike.x, strike.z, strike.radius).map(id => {
          const pose = this.traffic.poseOf(id)!
          return { id, distance: Math.hypot(pose.x - strike.x, pose.z - strike.z) }
        }),
        developments: developments.flatMap(({ development_id, spec }) => {
          const distance = footprintDistance(strike, developmentRing(spec, this.frame))
          return distance <= strike.radius ? [{ id: development_id, distance }] : []
        }),
      })
    }
    this.glow.isEnabled = [...this.effects.values()].some(effect => !effect.completed)
  }

  update(now: number): void {
    let glowing = false, erasureChanged = false
    const completed: StrikeEffect[] = []
    for (const effect of this.effects.values()) {
      if (effect.completed) continue
      const age = now - effect.strike.firedAt
      const pose = laserEnvelope(age, effect.strike.radius)
      const radius = Math.max(effect.circle.radius, effect.strike.radius * pose.width)
      if (age >= LASER_IMPACT_TIME && radius !== effect.circle.radius) {
        effect.impacted = true
        effect.circle.radius = radius
        effect.scar.scaling.setAll(radius / effect.strike.radius)
        effect.scar.setEnabled(true)
        erasureChanged = true
      }
      if (age >= LASER_DURATION) {
        effect.completed = true
        effect.beam?.dispose(this.glow)
        effect.beam = null
        completed.push(effect)
      } else {
        effect.beam?.update(age, this.scene.activeCamera?.globalPosition ?? Vector3.Zero(), pose)
        glowing ||= age >= 0
      }
    }
    if (erasureChanged) { this.applyErasure(); this.onImpact?.() }
    for (const effect of completed) this.onComplete?.(effect.strike.id, { buildings: effect.buildings.length, entities: effect.entities.length, developments: effect.developments.length })
    this.glow.isEnabled = glowing
  }

  clearedAt(x: number, z: number): boolean { return this.erasure.contains(x, z) }
  isDevelopmentHidden(id: string): boolean { return this.erasedDevelopments.has(id) }

  private applyErasure(): void {
    const impacted = [...this.effects.values()].filter(effect => effect.impacted)
    const reached = (kind: 'buildings' | 'entities' | 'developments') => impacted.flatMap(effect => effect[kind]
      .filter(object => object.distance <= effect.circle.radius + 1e-6).map(object => object.id))
    this.erasure.circles = impacted.map(effect => effect.circle)
    this.city.hideBuildings(reached('buildings'), 'orbital')
    this.traffic.hideEntities(reached('entities'))
    this.erasedDevelopments = new Set(reached('developments'))
    this.invalidateShadows()
  }

  dispose(): void {
    this.onImpact = null
    this.onComplete = null
    this.setStrikes([])
    this.erasure.dispose()
    this.glow.dispose()
    this.scarMaterial.dispose()
  }
}
