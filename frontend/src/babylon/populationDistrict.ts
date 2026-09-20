import { Color3 } from '@babylonjs/core/Maths/math.color'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { Scene } from '@babylonjs/core/scene'
import type { PopulationDefinition } from '../types'
import { meshFromBatch, Y } from './city'
import type { WorldFrame } from './coords'
import { Batch } from './geometry'

export type DistrictBounds = [west: number, south: number, east: number, north: number]

/** Envelope of the frozen activity anchors, in world metres. This is not a movement barrier. */
export function populationDistrictBounds(definition: PopulationDefinition, frame: WorldFrame): DistrictBounds | null {
  if (!definition.anchors.length) return null
  const positions = definition.anchors.map(anchor => frame.lonLatToWorld(anchor.lon, anchor.lat))
  if (positions.some(position => position.some(value => !Number.isFinite(value)))) return null
  const padding = 30
  return [Math.min(...positions.map(p => p[0])) - padding, Math.min(...positions.map(p => p[1])) - padding,
    Math.max(...positions.map(p => p[0])) + padding, Math.max(...positions.map(p => p[1])) + padding]
}

/** A bounded native-resident activity district, drawn over the existing city without touching its materials. */
export class PopulationDistrict {
  private definition: PopulationDefinition | null = null
  private mesh: Mesh | null = null
  private readonly material: StandardMaterial
  private readonly scene: Scene
  private readonly frame: WorldFrame
  private readonly networkFingerprint: string

  constructor(scene: Scene, frame: WorldFrame, networkFingerprint: string) {
    this.scene = scene
    this.frame = frame
    this.networkFingerprint = networkFingerprint
    this.material = new StandardMaterial('population-district-material', scene)
    this.material.disableLighting = true
    this.material.emissiveColor = Color3.White()
    this.material.specularColor = Color3.Black()
  }

  setDefinition(definition: PopulationDefinition | null): void {
    if (definition?.network_fingerprint !== this.networkFingerprint) definition = null
    if (definition === this.definition) return
    this.definition = definition
    this.mesh?.dispose()
    this.mesh = null
    const bounds = definition ? populationDistrictBounds(definition, this.frame) : null
    if (!bounds) return
    const [x0, z0, x1, z1] = bounds
    const path = [x0, z0, x1, z0, x1, z1, x0, z1, x0, z0]
    const batch = new Batch()
    batch.ribbon(path, 8, Y.junction + 0.31, [0.08, 0.08, 0.08])
    batch.ribbon(path, 3, Y.junction + 0.33, [0.96, 0.54, 0.12])
    this.mesh = meshFromBatch('population-activity-district', batch, this.scene, this.material)
  }

  dispose(): void {
    this.mesh?.dispose()
    this.material.dispose()
  }
}
