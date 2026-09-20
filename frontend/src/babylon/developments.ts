import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import type { Observer } from '@babylonjs/core/Misc/observable'
import type { Scene } from '@babylonjs/core/scene'

import { developmentArrowFraction, developmentColor, developmentDirection, developmentRing, validDevelopmentGeometry } from '../development'
import type { CityPack, Development, DevelopmentSpec } from '../types'
import { TEXTURE_RECIPES } from './appearance'
import { architectureBatches, hex, meshFromBatch, PALETTE, vertexColorMaterial, Y, type CityMeshes } from './city'
import type { WorldFrame } from './coords'
import { Batch, hash01, mix, type RGB } from './geometry'
import { buildVegetation } from './vegetation'
import type { BuildingCategory, WorldBuilding } from './worldData'

const RISE_MS = 620
const RIPPLE_MS = 950
const GLIDE_RATE = 14 // 1/s — how quickly the aimed ghost catches up with the cursor

const easeOutCubic = (k: number): number => 1 - Math.pow(1 - k, 3)

/** Flat lawn with a path cross and a deterministic grove of trees; never a tower. */
function parkGeometry(batch: Batch, spec: DevelopmentSpec, frame: WorldFrame, color: RGB): void {
  const ring = developmentRing(spec, frame)
  const base = Y.green + 0.2
  batch.extrude(ring, undefined, Y.ground + 0.05, base, mix(color, hex('#7a8f5a'), 0.5), mix(color, hex('#c9dc9c'), 0.45))
  const [cx, cz] = frame.lonLatToWorld(...spec.position)
  const [w, d] = spec.footprint_m
  const path = mix(hex('#d9cfa6'), color, 0.12)
  batch.ribbon([cx - w / 2 + 3, cz, cx + w / 2 - 3, cz], 2.6, base + 0.08, path)
  batch.ribbon([cx, cz - d / 2 + 3, cx, cz + d / 2 - 3], 2.6, base + 0.08, path)
  const trunk = hex('#6b4a2c')
  const canopy: RGB[] = [mix(color, hex('#2f6b2a'), 0.55), mix(color, hex('#5da648'), 0.35), mix(color, hex('#8cc46a'), 0.3)]
  const spacing = 11
  for (let ix = 0, x = cx - w / 2 + 7; x <= cx + w / 2 - 7; x += spacing, ix++) {
    for (let iz = 0, z = cz - d / 2 + 7; z <= cz + d / 2 - 7; z += spacing, iz++) {
      const j = hash01(`${spec.name}:${ix}:${iz}`)
      if (Math.abs(x - cx) < 3 || Math.abs(z - cz) < 3) continue // keep the paths clear
      const tx = x + (j - 0.5) * 4, tz = z + (hash01(`${iz}:${ix}:${spec.name}`) - 0.5) * 4
      const h = 5 + j * 3.5, r = 2 + j * 1.2
      batch.lathe(tx, tz, [[0.32, base], [0.32, base + h * 0.4]], trunk, 8)
      batch.lathe(tx, tz, [[0, base + h * 0.38], [r * 0.7, base + h * 0.55], [r, base + h * 0.75], [r * 0.7, base + h * 0.92], [0, base + h]], canopy[Math.floor(j * 3) % 3], 10)
    }
  }
}

export function developmentGeometry(spec: DevelopmentSpec, frame: WorldFrame, color: RGB): Batch {
  const batch = new Batch()
  if (!validDevelopmentGeometry(spec)) return batch
  if (spec.land_use === 'park') {
    parkGeometry(batch, spec, frame, color)
    return batch
  }
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

/**
 * A confirmed development as the city itself would draw it: the same procedural architecture, facade textures and
 * roof materials as the surrounding OSM buildings, so it is indistinguishable from its neighbours.
 */
export function cityBuildingFor(id: string, spec: DevelopmentSpec, frame: WorldFrame): WorldBuilding {
  const cat: BuildingCategory = spec.land_use === 'office' ? (spec.height_m >= 65 ? 'tower' : 'office')
    : spec.land_use === 'school' ? 'civic' : spec.height_m > 15 ? 'apartments' : 'residential'
  return { id, ring: developmentRing(spec, frame), h: spec.height_m, cat, name: spec.name }
}

/** Where a confirmed park's trees stand: the same deterministic grove the placement ghost showed. */
export function parkTrees(spec: DevelopmentSpec, frame: WorldFrame): { x: number; z: number; scale: number; shade: number }[] {
  const [cx, cz] = frame.lonLatToWorld(...spec.position)
  const [w, d] = spec.footprint_m
  const out: { x: number; z: number; scale: number; shade: number }[] = []
  const spacing = 11
  for (let ix = 0, x = cx - w / 2 + 7; x <= cx + w / 2 - 7; x += spacing, ix++) {
    for (let iz = 0, z = cz - d / 2 + 7; z <= cz + d / 2 - 7; z += spacing, iz++) {
      if (Math.abs(x - cx) < 3 || Math.abs(z - cz) < 3) continue
      const j = hash01(`${spec.name}:${ix}:${iz}`)
      out.push({ x: x + (j - 0.5) * 4, z: z + (hash01(`${iz}:${ix}:${spec.name}`) - 0.5) * 4, scale: 0.85 + j * 0.5, shade: hash01(`${ix}:${iz}`) })
    }
  }
  return out
}

/** A thin ground ring used for the placement ripple. */
function ringBatch(cx: number, cz: number, r: number, width: number, y: number, color: RGB): Batch {
  const batch = new Batch()
  const pts: number[] = []
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2
    pts.push(cx + Math.cos(a) * r, cz + Math.sin(a) * r)
  }
  batch.ribbon(pts, width, y, color)
  return batch
}

/** Meshes from `meshFromBatch` are frozen for the static city; the ghost must move and scale every frame. */
function animatable(mesh: Mesh): Mesh {
  mesh.unfreezeWorldMatrix()
  mesh.doNotSyncBoundingInfo = false
  return mesh
}

export type DevelopmentMarks = {
  developments: Development[]
  draft: DevelopmentSpec | null
  /** Where the draft is drawn: its placed position, or the cursor while it is still being aimed. */
  ghostPosition: [number, number] | null
  placed: boolean
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
  private readonly ghostMarkMaterial: StandardMaterial
  private meshes: Mesh[] = []
  private roots: TransformNode[] = []
  private key = ''
  private ghostRoot: TransformNode | null = null
  private ghostBase: [number, number] = [0, 0]
  private ghostTarget: [number, number] | null = null
  private ghostSnap = true
  private ghostSpecKey = ''
  private placedKey = ''
  private rising = new Map<TransformNode, number>()
  private ripples: { mesh: Mesh; material: StandardMaterial; start: number }[] = []
  private seen: Set<string> | null = null
  private readonly observer: Observer<Scene>
  private readonly city: CityMeshes | null
  private now = 0

  constructor(scene: Scene, frame: WorldFrame, city: CityMeshes | null = null) {
    this.scene = scene
    this.frame = frame
    this.city = city
    this.material = vertexColorMaterial('development-material', scene)
    this.ghostMaterial = vertexColorMaterial('development-ghost-material', scene)
    this.ghostMaterial.alpha = 0.42
    this.ghostMaterial.backFaceCulling = false
    this.ghostMaterial.emissiveColor.set(0.18, 0.18, 0.18)
    this.markMaterial = vertexColorMaterial('development-mark-material', scene, 0)
    this.markMaterial.emissiveColor.set(0.4, 0.4, 0.4)
    this.ghostMarkMaterial = vertexColorMaterial('development-ghost-mark-material', scene, 0)
    this.ghostMarkMaterial.emissiveColor.set(0.55, 0.55, 0.55)
    this.ghostMarkMaterial.disableLighting = true
    this.observer = scene.onBeforeRenderObservable.add(() => this.animate(scene.getEngine().getDeltaTime()))
  }

  /** World-space (x, z) the ghost is heading to, or null when nothing is being aimed. Exposed for tests. */
  ghostWorldTarget(): [number, number] | null {
    return this.ghostTarget ? [this.ghostBase[0] + this.ghostTarget[0], this.ghostBase[1] + this.ghostTarget[1]] : null
  }

  set(marks: DevelopmentMarks): void {
    const draftSansPosition = marks.draft ? { ...marks.draft, position: null } : null
    const placedAt = marks.placed && marks.draft ? marks.draft.position : null
    const key = JSON.stringify([marks.developments, draftSansPosition, placedAt, marks.invalidDraft, marks.focusedId, marks.zones])
    if (key !== this.key) {
      this.key = key
      this.rebuild(marks, placedAt)
    }
    this.aimGhost(marks)
  }

  private rebuild(marks: DevelopmentMarks, placedAt: [number, number] | null): void {
    const previouslySeen = this.seen
    for (const mesh of this.meshes) mesh.dispose()
    for (const root of this.roots) root.dispose()
    this.meshes = []
    this.roots = []
    this.rising.clear()
    const ghostBefore = this.ghostRoot
    this.ghostRoot = null
    const footprints = new Batch()
    const intentions = new Batch()

    const arrows = (spec: DevelopmentSpec, direction: 'inbound' | 'outbound', color: RGB): void => {
      const center = this.frame.lonLatToWorld(...spec.position)
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

    // --- saved developments: drawn like any other city building (same textures, no halo, outline or arrows). A
    // thin outline appears only while one is selected, so the delete card has an unambiguous anchor.
    const seen = new Set<string>()
    for (const development of marks.developments) {
      const { spec } = development
      const id = development.development_id
      seen.add(id)
      if (!validDevelopmentGeometry(spec)) continue
      const fresh = !!previouslySeen && !previouslySeen.has(id) // a freshly confirmed building rises out of the ground
      const root = new TransformNode(`development-${id}-root`, this.scene)
      for (const mesh of this.savedMeshes(id, spec)) {
        mesh.isPickable = true
        mesh.metadata = { development_id: id }
        mesh.receiveShadows = true
        mesh.parent = root
        if (fresh) animatable(mesh)
        this.meshes.push(mesh)
      }
      this.roots.push(root)
      if (fresh) this.rising.set(root, this.now)
      if (marks.focusedId === id) {
        const ring = developmentRing(spec, this.frame, 2)
        footprints.ribbon([...ring, ring[0], ring[1]], 2.2, Y.junction + 0.3, hex('#e7e7e1'))
      }
    }
    this.seen = seen

    // --- the draft: a translucent ghost that glides after the cursor until it is placed ---
    if (marks.draft && validDevelopmentGeometry(marks.draft)) {
      const spec = marks.draft
      const color = hex(marks.invalidDraft ? '#d75e48' : developmentColor(spec))
      const anchor = placedAt ?? marks.ghostPosition ?? spec.position
      const built: DevelopmentSpec = { ...spec, position: anchor }
      const root = new TransformNode('development-ghost-root', this.scene)
      const body = animatable(meshFromBatch('development-draft', developmentGeometry(built, this.frame, color), this.scene, this.ghostMaterial))
      body.renderingGroupId = 1
      body.parent = root
      const outline = new Batch()
      const ring = developmentRing(built, this.frame, 3)
      outline.ribbon([...ring, ring[0], ring[1]], 3.2, Y.junction + 0.3, mix(color, hex('#ffffff'), 0.25))
      const corner = 6
      for (let i = 0; i < 8; i += 2) { // bracket corners so the outline reads as a placement target, not a road
        const x = ring[i], z = ring[i + 1], sx = x < anchorX(this.frame, anchor) ? 1 : -1, sz = z < anchorZ(this.frame, anchor) ? 1 : -1
        outline.ribbon([x, z, x + sx * corner, z], 1.4, Y.junction + 0.34, color)
        outline.ribbon([x, z, x, z + sz * corner], 1.4, Y.junction + 0.34, color)
      }
      const marksMesh = animatable(meshFromBatch('development-draft-outline', outline, this.scene, this.ghostMarkMaterial))
      marksMesh.renderingGroupId = 1
      marksMesh.parent = root
      this.meshes.push(body, marksMesh)
      this.ghostRoot = root
      this.ghostBase = this.frame.lonLatToWorld(...anchor)
      const specKey = JSON.stringify(draftKey(spec))
      // Re-anchoring (a new spec, or the geometry rebuilt under the cursor) must not make the ghost jump: carry the
      // previous root offset over so the glide continues from where it was.
      if (ghostBefore && this.ghostSpecKey === specKey && !placedAt) root.position.copyFrom(ghostBefore.position)
      this.ghostSpecKey = specKey
      this.ghostSnap = !ghostBefore
      if (placedAt) {
        const placedKey = JSON.stringify([placedAt, specKey])
        if (placedKey !== this.placedKey) {
          this.placedKey = placedKey
          this.rising.set(root, this.now)
          this.ripple(this.ghostBase, Math.max(...spec.footprint_m) / 2 + 6, color)
        }
        arrows(spec, developmentDirection(spec), color)
      } else this.placedKey = ''
    } else {
      this.ghostSpecKey = ''
      this.placedKey = ''
      this.ghostTarget = null
    }
    ghostBefore?.dispose()

    for (const [name, batch] of [['footprints', footprints], ['intentions', intentions]] as const) {
      if (batch.isEmpty()) continue
      const mesh = meshFromBatch(`development-${name}`, batch, this.scene, this.markMaterial)
      mesh.renderingGroupId = 1
      this.meshes.push(mesh)
    }
  }

  /** Meshes for a confirmed development, textured with the city's own materials when a city is attached. */
  private savedMeshes(id: string, spec: DevelopmentSpec): Mesh[] {
    const city = this.city
    if (!city) {
      // Headless/test scenes: keep the flat vertex-colour look.
      return [meshFromBatch(`development-${id}`, developmentGeometry(spec, this.frame, hex(developmentColor(spec))), this.scene, this.material)]
    }
    if (spec.land_use === 'park') {
      const lawn = new Batch(TEXTURE_RECIPES.grass.metres)
      const ring = developmentRing(spec, this.frame)
      lawn.polygon(ring, undefined, Y.green + 0.06, PALETTE.green)
      const meshes = [meshFromBatch(`development-${id}`, lawn, this.scene, city.materials.get('grass'))]
      for (const tree of buildVegetation(this.scene, parkTrees(spec, this.frame), city.foliage, Y.green)) {
        tree.name = `development-${id}-trees`
        tree.unfreezeWorldMatrix()
        tree.thinInstanceEnablePicking = true // clicking a tree selects the park
        meshes.push(tree)
      }
      return meshes
    }
    const meshes: Mesh[] = []
    let first = true
    for (const [kind, batch] of architectureBatches(cityBuildingFor(id, spec, this.frame))) {
      if (batch.isEmpty()) continue
      meshes.push(meshFromBatch(first ? `development-${id}` : `development-${id}-${kind}`, batch, this.scene, city.materials.get(kind)))
      first = false
    }
    return meshes
  }

  private aimGhost(marks: DevelopmentMarks): void {
    if (!this.ghostRoot || !marks.draft) return
    const target = marks.placed ? marks.draft.position : marks.ghostPosition
    if (!target) {
      this.ghostTarget = null
      this.ghostRoot.setEnabled(false)
      return
    }
    const [x, z] = this.frame.lonLatToWorld(...target)
    this.ghostTarget = [x - this.ghostBase[0], z - this.ghostBase[1]]
    if (!this.ghostRoot.isEnabled()) {
      this.ghostRoot.setEnabled(true)
      this.ghostSnap = true
    }
    if (this.ghostSnap) {
      this.ghostRoot.position.x = this.ghostTarget[0]
      this.ghostRoot.position.z = this.ghostTarget[1]
      this.ghostSnap = false
    }
  }

  private ripple(at: [number, number], radius: number, color: RGB): void {
    const material = vertexColorMaterial(`development-ripple-${this.ripples.length}-${this.now}`, this.scene, 0)
    material.disableLighting = true
    material.emissiveColor.set(0.6, 0.6, 0.6)
    material.alpha = 0.75
    const mesh = animatable(meshFromBatch('development-ripple', ringBatch(0, 0, radius, 2.2, Y.junction + 0.32, mix(color, hex('#ffffff'), 0.2)), this.scene, material))
    mesh.position.set(at[0], 0, at[1])
    mesh.renderingGroupId = 1
    this.ripples.push({ mesh, material, start: this.now })
  }

  /** Per-frame motion: cursor glide, breathing ghost, rise-in of placed/confirmed buildings, fading ripples. */
  animate(deltaMs: number): void {
    this.now += deltaMs
    const dt = Math.min(0.1, deltaMs / 1000)
    if (this.ghostRoot && this.ghostTarget && this.ghostRoot.isEnabled()) {
      const k = 1 - Math.exp(-GLIDE_RATE * dt)
      const p = this.ghostRoot.position
      p.x += (this.ghostTarget[0] - p.x) * k
      p.z += (this.ghostTarget[1] - p.z) * k
    }
    const breath = 0.5 + 0.5 * Math.sin(this.now / 340)
    this.ghostMaterial.alpha = 0.34 + 0.16 * breath
    this.ghostMarkMaterial.emissiveColor.set(0.45 + 0.35 * breath, 0.45 + 0.35 * breath, 0.45 + 0.35 * breath)
    for (const [node, start] of this.rising) {
      const k = Math.min(1, (this.now - start) / RISE_MS)
      node.scaling.y = 0.04 + 0.96 * easeOutCubic(k)
      if (k >= 1) { node.scaling.y = 1; this.rising.delete(node) }
    }
    this.ripples = this.ripples.filter(({ mesh, material, start }) => {
      const k = (this.now - start) / RIPPLE_MS
      if (k >= 1) { mesh.dispose(); material.dispose(); return false }
      const s = 1 + 1.6 * easeOutCubic(k)
      mesh.scaling.set(s, 1, s)
      material.alpha = 0.75 * (1 - k)
      return true
    })
  }

  dispose(): void {
    this.scene.onBeforeRenderObservable.remove(this.observer)
    for (const mesh of this.meshes) mesh.dispose()
    for (const root of this.roots) root.dispose()
    this.meshes = []
    this.roots = []
    for (const { mesh, material } of this.ripples) { mesh.dispose(); material.dispose() }
    this.ripples = []
    this.ghostRoot?.dispose()
    this.ghostRoot = null
    this.material.dispose()
    this.ghostMaterial.dispose()
    this.markMaterial.dispose()
    this.ghostMarkMaterial.dispose()
  }
}

function draftKey(spec: DevelopmentSpec): unknown {
  return { ...spec, position: null }
}
function anchorX(frame: WorldFrame, anchor: [number, number]): number {
  return frame.lonLatToWorld(...anchor)[0]
}
function anchorZ(frame: WorldFrame, anchor: [number, number]): number {
  return frame.lonLatToWorld(...anchor)[1]
}
