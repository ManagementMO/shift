import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { Scene } from '@babylonjs/core/scene'

import { DEVELOPMENT_USES, developmentActivity, developmentArrowFraction, developmentDirection, developmentRing, validDevelopmentGeometry } from '../development'
import type { CityPack, Development, DevelopmentSpec } from '../types'
import { hex, meshFromBatch, vertexColorMaterial, Y } from './city'
import type { WorldFrame } from './coords'
import { Batch, mix, type RGB } from './geometry'

export function developmentGeometry(spec: DevelopmentSpec, frame: WorldFrame, color: RGB): Batch {
  const batch = new Batch()
  if (!validDevelopmentGeometry(spec)) return batch
  const ring = developmentRing(spec, frame)
  const base = Y.building + 0.4
  const roof = base + spec.height_m
  batch.extrude(ring, undefined, base, roof, mix(color, hex('#e6e8e2'), 0.7), color)
  const outline = [...ring, ring[0], ring[1]]
  const step = Math.max(4, spec.height_m / 8)
  for (let y = base + step; y < roof - 1; y += step) batch.ribbon(outline, 0.5, y, mix(color, hex('#ffffff'), 0.55))
  const [x, z] = frame.lonLatToWorld(...spec.position)
  const marker = [x - 2, z - 2, x + 2, z - 2, x + 2, z + 2, x - 2, z + 2]
  batch.extrude(marker, undefined, roof, roof + 4, color, hex('#f5f6ef'))
  return batch
}

export type DevelopmentMarks = {
  developments: Development[]
  draft: DevelopmentSpec | null
  invalidDraft: boolean
  focusedId: string | null
  zones: CityPack['zones']
  t: number
}

export class DevelopmentOverlay {
  private readonly scene: Scene
  private readonly frame: WorldFrame
  private readonly material: StandardMaterial
  private readonly ghostMaterial: StandardMaterial
  private readonly markMaterial: StandardMaterial
  private meshes: Mesh[] = []
  private key = ''

  constructor(scene: Scene, frame: WorldFrame) {
    this.scene = scene
    this.frame = frame
    this.material = vertexColorMaterial('development-material', scene)
    this.ghostMaterial = vertexColorMaterial('development-ghost-material', scene)
    this.ghostMaterial.alpha = 0.45
    this.ghostMaterial.backFaceCulling = false
    this.markMaterial = vertexColorMaterial('development-mark-material', scene, 0)
    this.markMaterial.emissiveColor.set(0.4, 0.4, 0.4)
  }

  set(marks: DevelopmentMarks): void {
    const activity = marks.developments.map((d) => developmentActivity(d.spec, marks.t))
    const key = JSON.stringify([marks.developments, marks.draft, marks.invalidDraft, marks.focusedId, marks.zones, activity])
    if (key === this.key) return
    this.key = key
    for (const mesh of this.meshes) mesh.dispose()
    this.meshes = []
    const footprints = new Batch()
    const intentions = new Batch()
    const halos = new Batch()
    const add = (spec: DevelopmentSpec, id: string, ghost: boolean, direction: 'inbound' | 'outbound' | null): void => {
      if (!validDevelopmentGeometry(spec)) return
      const color = ghost ? hex(marks.invalidDraft ? '#d75e48' : '#1598b0') : hex(DEVELOPMENT_USES[spec.land_use].color)
      const mesh = meshFromBatch(`development-${id}`, developmentGeometry(spec, this.frame, color), this.scene, ghost ? this.ghostMaterial : this.material)
      mesh.isPickable = !ghost
      mesh.metadata = ghost ? null : { development_id: id }
      mesh.receiveShadows = true
      if (ghost) mesh.renderingGroupId = 1
      this.meshes.push(mesh)
      const ring = developmentRing(spec, this.frame, 3)
      footprints.ribbon([...ring, ring[0], ring[1]], ghost || marks.focusedId === id ? 3 : 1.6, Y.junction + 0.3, color)
      // Ground halo: a wide tinted ring around the lot so the new building reads at district scale, not just up close.
      // Depth-tested (default rendering group) so the building's own walls draw over it; only the outline is always-on-top.
      const center = this.frame.lonLatToWorld(...spec.position)
      const halo = Math.max(...spec.footprint_m) * 0.9 + 14
      halos.disc(center[0], center[1], halo, Y.junction + 0.22, mix(color, hex('#ffffff'), ghost ? 0.55 : 0.35), 40)
      halos.disc(center[0], center[1], halo - 4, Y.junction + 0.24, mix(color, hex('#f4f6f1'), 0.82), 40)
      if (!direction || (!ghost && marks.focusedId !== id)) return
      for (const zone of marks.zones) {
        if (!(spec.zone_shares[zone.zone_id] > 0)) continue
        const other = this.frame.lonLatToWorld(zone.lon, zone.lat)
        const [start, end] = direction === 'outbound' ? [center, other] : [other, center]
        const dx = end[0] - start[0], dz = end[1] - start[1]
        const length = Math.hypot(dx, dz)
        if (length < 1) continue
        intentions.ribbon([...start, ...end], 1.8, Y.stop + 0.3, color)
        const fraction = developmentArrowFraction(spec, direction, length)
        const tip = [start[0] + dx * fraction, start[1] + dz * fraction]
        const back = [tip[0] - dx / length * 18, tip[1] - dz / length * 18]
        const nx = -dz / length * 7, nz = dx / length * 7
        intentions.polygon([tip[0], tip[1], back[0] + nx, back[1] + nz, back[0] - nx, back[1] - nz], undefined, Y.stop + 0.35, color)
        intentions.disc(other[0], other[1], 4 + 8 * spec.zone_shares[zone.zone_id], Y.stop + 0.3, color, 20)
      }
    }
    marks.developments.forEach((development, i) => add(development.spec, development.development_id, false, activity[i]))
    if (marks.draft) add(marks.draft, 'draft', true, developmentDirection(marks.draft))
    if (!halos.isEmpty()) this.meshes.push(meshFromBatch('development-halos', halos, this.scene, this.markMaterial))
    for (const [name, batch] of [['footprints', footprints], ['intentions', intentions]] as const) {
      if (batch.isEmpty()) continue
      const mesh = meshFromBatch(`development-${name}`, batch, this.scene, this.markMaterial)
      mesh.renderingGroupId = 1
      this.meshes.push(mesh)
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.dispose()
    this.meshes = []
    this.material.dispose()
    this.ghostMaterial.dispose()
    this.markMaterial.dispose()
  }
}
