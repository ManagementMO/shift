import type { Scene } from '@babylonjs/core/scene'
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import type { Pose } from './camera'
import { Batch } from './geometry'

export const FLYOVER_DURATION_S = 26
const MODEL_SCALE = 22
const WHITE: [number, number, number] = [1, 1, 1]
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
type Point = [number, number, number]

export interface PlaneFlight {
  view: Pose
  altitude: number
  halfSpan: number
  heading: number
}

export function planeAltitude(roofHeight: number): number {
  return Math.max(240, roofHeight + Math.max(100, 8 * MODEL_SCALE + 30))
}

export function planeShadowHeight(roofHeight: number): number {
  return planeAltitude(roofHeight) + 15 * MODEL_SCALE + 20
}

export function planeFlight(bounds: readonly number[], roofHeight: number, view: Pose, aspect: number): PlaneFlight {
  const [x0, z0, x1, z1] = bounds
  const margin = Math.min(x1 - x0, z1 - z0) * 0.15
  const altitude = planeAltitude(roofHeight)
  const framing: Pose = {
    target: [clamp(view.target[0], x0 + margin, x1 - margin), clamp(view.target[1], z0 + margin, z1 - margin)],
    radius: Math.max(1900, altitude * 3.1, Math.min(3300, view.radius)),
    heading: view.heading,
    elevation: clamp(view.elevation, 48, 65),
    y: altitude * 0.2,
  }
  return { view: framing, altitude, halfSpan: framing.radius * 0.44 * clamp(aspect, 0.55, 3) + 40 * MODEL_SCALE + 40, heading: view.heading * Math.PI / 180 + Math.PI / 2 }
}

export function planePose(flight: PlaneFlight, elapsed: number): { x: number; y: number; z: number; yaw: number; pitch: number; roll: number } | null {
  if (elapsed < 0 || elapsed >= FLYOVER_DURATION_S) return null
  const p = elapsed / FLYOVER_DURATION_S
  const along = (p * 2 - 1) * flight.halfSpan
  const curve = Math.sin(p * Math.PI) * 90
  const turn = Math.atan2(Math.cos(p * Math.PI) * Math.PI * 90, flight.halfSpan * 2)
  const dx = Math.sin(flight.heading), dz = Math.cos(flight.heading)
  return {
    x: flight.view.target[0] + dx * along + dz * curve,
    y: flight.altitude + 18 * p * p,
    z: flight.view.target[1] + dz * along - dx * curve,
    yaw: flight.heading + turn,
    pitch: -Math.atan2(36 * p, flight.halfSpan * 2),
    roll: -0.07 * Math.sin(p * Math.PI * 2),
  }
}

function append(target: Batch, source: Batch, matrix: Matrix): void {
  const offset = target.vertexCount
  const normalMatrix = Matrix.Transpose(Matrix.Invert(matrix))
  for (let i = 0; i < source.positions.length; i += 3) {
    const p = Vector3.TransformCoordinates(Vector3.FromArray(source.positions, i), matrix)
    const n = Vector3.TransformNormal(Vector3.FromArray(source.normals, i), normalMatrix).normalize()
    target.vertex(p.x, p.y, p.z, n.x, n.y, n.z, WHITE)
  }
  for (const i of source.indices) target.indices.push(offset + i)
}

function slab(ring: number[], bottom: number, top: number): Batch {
  const batch = new Batch()
  batch.walls(ring, undefined, bottom, top, WHITE, 1)
  batch.polygon(ring, undefined, top, WHITE)
  const vertex = batch.vertexCount, index = batch.indices.length
  batch.polygon(ring, undefined, bottom, WHITE)
  for (let i = vertex; i < batch.vertexCount; i++) batch.normals[i * 3 + 1] = -1
  for (let i = index; i < batch.indices.length; i += 3) [batch.indices[i + 1], batch.indices[i + 2]] = [batch.indices[i + 2], batch.indices[i + 1]]
  return batch
}

function tube(target: Batch, x: number, y: number, z: number, profile: [number, number][]): void {
  const batch = new Batch()
  batch.lathe(0, 0, profile, WHITE, 40, 1)
  append(target, batch, Matrix.RotationX(Math.PI / 2).multiply(Matrix.Translation(x, y, z)))
}

function quad(batch: Batch, points: Point[]): void {
  const [a, b, c] = points.map(p => Vector3.FromArray(p))
  const n = Vector3.Cross(c.subtract(a), b.subtract(a)).normalize()
  const base = batch.vertexCount
  for (const [x, y, z] of points) batch.vertex(x, y, z, n.x, n.y, n.z, WHITE)
  batch.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
}

function buildPlane(scene: Scene): { root: TransformNode; meshes: Mesh[]; materials: PBRMaterial[] } {
  const body = new Batch(), navy = new Batch(), glass = new Batch(), metal = new Batch()
  tube(body, 0, 0, 0, [[0, -35], [0.7, -33], [1.6, -28], [2.7, -20], [3.3, -12], [3.3, 19], [2.9, 24], [2.1, 29], [0.9, 33], [0, 34.5]])
  for (const side of [-1, 1]) {
    append(body, slab([side * 2, 7, side * 8, 5, side * 34, -11, side * 34.7, -15.5, side * 11, -10, side * 2, -7], -0.65, 0.25), Matrix.Identity())
    append(body, slab([side * 1.4, -21, side * 13, -28, side * 13, -31, side * 1.4, -28], 0.8, 1.4), Matrix.Identity())
    append(navy, slab([0, -11, 2.7, -13, 2.7, -16, 0, -15.5], -0.25, 0.25), Matrix.RotationZ(Math.PI / 2).multiply(Matrix.Translation(side * 34.2, 0.2, 0)))
    append(metal, slab([side * 10.4, -2, side * 11.6, -2, side * 11.6, 5, side * 10.4, 5], -3, 0), Matrix.Identity())
    tube(body, side * 11, -3.7, 2, [[0.9, -4], [1.4, -3], [1.9, 0], [1.9, 2.8], [1.6, 3.8], [1.3, 3.95]])
    tube(metal, side * 11, -3.7, 2, [[1.9, 2.8], [1.6, 3.8], [1.3, 3.96]])
    tube(glass, side * 11, -3.7, 2, [[1.28, 3.97], [1.28, 3.99]])
    tube(metal, side * 11, -3.7, 2, [[0.28, 4], [0, 4.6]])
    for (let z = -11; z < 22; z += 1.8) {
      quad(glass, [
        [side * 3.25, 0.68, z], [side * 3.25, 0.68, z + 0.75],
        [side * 3.08, 1.28, z + 0.75], [side * 3.08, 1.28, z],
      ])
    }
    quad(glass, [[side * 2.68, 1.16, 25], [side * 1.98, 1.03, 28.5], [side * 1.28, 1.88, 28.5], [side * 1.86, 2.25, 25]])
  }
  append(navy, slab([0, -18, 10.5, -29, 10.5, -33, 0, -32], -0.45, 0.45), Matrix.RotationZ(Math.PI / 2).multiply(Matrix.Translation(0, 1.4, 0)))
  const root = new TransformNode('plane-flyover', scene)
  root.scaling.setAll(MODEL_SCALE)
  const meshes: Mesh[] = [], materials: PBRMaterial[] = []
  const parts: [string, Batch, string, number, number][] = [
    ['body', body, '#eef1f3', 0.18, 0.3], ['trim', navy, '#243747', 0.32, 0.3],
    ['glass', glass, '#101e2a', 0.5, 0.18], ['metal', metal, '#bbc5cf', 0.72, 0.26],
  ]
  for (const [name, batch, color, metallic, roughness] of parts) {
    const material = new PBRMaterial(`plane-${name}`, scene)
    material.albedoColor = Color3.FromHexString(color)
    material.metallic = metallic
    material.roughness = roughness
    material.backFaceCulling = name !== 'glass'
    const mesh = new Mesh(`plane-${name}`, scene)
    const data = new VertexData()
    data.positions = batch.positions
    data.normals = batch.normals
    data.indices = batch.indices
    data.applyToMesh(mesh)
    mesh.material = material
    mesh.parent = root
    mesh.isPickable = false
    mesh.receiveShadows = true
    meshes.push(mesh)
    materials.push(material)
  }
  return { root, meshes, materials }
}

export class PlaneFlyover {
  private readonly scene: Scene
  private readonly shadows: ShadowGenerator | null
  private readonly bounds: readonly number[]
  private readonly roofHeight: number
  private model: ReturnType<typeof buildPlane> | null = null
  private flight: PlaneFlight | null = null
  private elapsed = 0

  constructor(scene: Scene, shadows: ShadowGenerator | null, bounds: readonly number[], roofHeight: number) {
    this.scene = scene
    this.shadows = shadows
    this.bounds = bounds
    this.roofHeight = roofHeight
  }

  get active(): boolean { return this.flight !== null }

  start(view: Pose, aspect: number): Pose {
    this.clear()
    this.flight = planeFlight(this.bounds, this.roofHeight, view, aspect)
    this.model = buildPlane(this.scene)
    for (const mesh of this.model.meshes) this.shadows?.addShadowCaster(mesh, false)
    this.update(0)
    return this.flight.view
  }

  update(dt: number): void {
    if (!this.flight || !this.model) return
    this.elapsed += clamp(dt, 0, 0.1)
    const pose = planePose(this.flight, this.elapsed)
    if (!pose) { this.clear(); return }
    this.model.root.position.set(pose.x, pose.y, pose.z)
    this.model.root.rotation.set(pose.pitch, pose.yaw, pose.roll)
    this.shadows?.getShadowMap()?.resetRefreshCounter()
  }

  clear(): void {
    if (this.model) {
      for (const mesh of this.model.meshes) this.shadows?.removeShadowCaster(mesh, false)
      this.model.root.dispose()
      for (const material of this.model.materials) material.dispose()
      this.shadows?.getShadowMap()?.resetRefreshCounter()
    }
    this.model = null
    this.flight = null
    this.elapsed = 0
  }

  dispose(): void { this.clear() }
}
