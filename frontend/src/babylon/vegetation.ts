import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import '@babylonjs/core/Meshes/thinInstanceMesh'
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import type { Scene } from '@babylonjs/core/scene'

import { Batch } from './geometry'
import type { TreePlacement } from './details'

function treeGeometry(detailed: boolean): Batch {
  const prototype = new Batch()
  prototype.lathe(0, 0, [[0.26, 0], [0.19, 5.7]], [0.34, 0.28, 0.21], 5, 1)
  const lobes = detailed
    ? [[0, 0, 4.5, 3.1, 1], [-1.7, 0.6, 4, 2.25, 0.93], [1.2, -1.1, 4.2, 2.3, 1.06]]
    : [[0, 0, 4.2, 3.4, 1]]
  for (const [x, z, y, r, shade] of lobes) {
    prototype.lathe(x, z, [[r * 0.3, y - 1], [r, y + 0.8], [r * 0.9, y + 2.8], [r * 0.35, y + 4.3], [0.1, y + 4.6]], [0.29 * shade, 0.44 * shade, 0.19 * shade], detailed ? 7 : 6, 1)
  }
  return prototype
}

export function buildVegetation(scene: Scene, trees: TreePlacement[], material: StandardMaterial): Mesh[] {
  const prototypes = [treeGeometry(true), treeGeometry(false)]
  const cells = new Map<string, TreePlacement[]>()
  for (const tree of trees) {
    const key = `${Math.floor(tree.x / 400)}:${Math.floor(tree.z / 400)}`
    let group = cells.get(key)
    if (!group) cells.set(key, (group = []))
    group.push(tree)
  }
  const meshes: Mesh[] = []
  const levels: { near: Mesh; far: Mesh; x: number; z: number; detailed: boolean }[] = []
  for (const [key, group] of cells) {
    const matrices = new Float32Array(group.length * 16)
    const colors = new Float32Array(group.length * 4)
    group.forEach((tree, i) => {
      const o = i * 16
      const a = tree.shade * Math.PI * 2, c = Math.cos(a) * tree.scale, s = Math.sin(a) * tree.scale
      matrices.set([c, 0, -s, 0, 0, tree.scale, 0, 0, s, 0, c, 0, tree.x, 0.25, tree.z, 1], o)
      colors.set([0.76 + tree.shade * 0.3, 0.84 + tree.shade * 0.16, 0.7 + tree.shade * 0.26, 1], i * 4)
    })
    const pair = prototypes.map((prototype, lod) => {
      const mesh = new Mesh(`trees-${key}-${lod === 0 ? 'near' : 'far'}`, scene)
      const vertices = new VertexData()
      vertices.positions = new Float32Array(prototype.positions)
      vertices.normals = new Float32Array(prototype.normals)
      vertices.colors = new Float32Array(prototype.colors)
      vertices.indices = new Uint16Array(prototype.indices)
      vertices.applyToMesh(mesh)
      mesh.material = material
      mesh.thinInstanceSetBuffer('matrix', matrices, 16, true)
      mesh.thinInstanceSetBuffer('color', colors, 4, true)
      mesh.thinInstanceRefreshBoundingInfo(true)
      mesh.receiveShadows = true
      mesh.isPickable = false
      mesh.freezeWorldMatrix()
      mesh.setEnabled(lod === 0)
      meshes.push(mesh)
      return mesh
    })
    levels.push({ near: pair[0], far: pair[1], x: group.reduce((v,t) => v+t.x,0)/group.length, z: group.reduce((v,t) => v+t.z,0)/group.length, detailed: true })
  }
  let frame = 0
  const observer = scene.onBeforeRenderObservable.add(() => {
    if (frame++ % 12 !== 0) return
    const camera = scene.activeCamera
    if (!camera) return
    if (!(camera instanceof ArcRotateCamera)) return
    const target = camera.target
    const radius = camera.position.subtract(target).length()
    for (const level of levels) {
      // A small hysteresis avoids toggling canopies back and forth at a boundary.
      const detailed = radius < 2300 && Math.hypot(level.x-target.x,level.z-target.z) < (level.detailed ? 1050 : 900)
      if (detailed === level.detailed) continue
      level.detailed = detailed
      level.near.setEnabled(detailed)
      level.far.setEnabled(!detailed)
    }
  })
  let remaining = meshes.length
  for (const mesh of meshes) mesh.onDisposeObservable.addOnce(() => {
    if (--remaining === 0) scene.onBeforeRenderObservable.remove(observer)
  })
  if (!remaining) scene.onBeforeRenderObservable.remove(observer)
  return meshes
}
