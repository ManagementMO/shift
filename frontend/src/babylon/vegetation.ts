import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import '@babylonjs/core/Meshes/thinInstanceMesh'
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import type { Scene } from '@babylonjs/core/scene'

import { Batch } from './geometry'
import type { TreePlacement } from './details'

export function buildVegetation(scene: Scene, trees: TreePlacement[], material: StandardMaterial): Mesh[] {
  const prototype = new Batch()
  prototype.lathe(0, 0, [[0.24, 0], [0.18, 4.5]], [0.38, 0.29, 0.19], 6, 1)
  prototype.lathe(0, 0, [[0.8, 2.5], [2.3, 3.4], [2.9, 5.1], [2.5, 6.9], [1.4, 8.1], [0.1, 8.7]], [0.46, 0.64, 0.29], 8, 1)
  const cells = new Map<string, TreePlacement[]>()
  for (const tree of trees) {
    const key = `${Math.floor(tree.x / 800)}:${Math.floor(tree.z / 800)}`
    let group = cells.get(key)
    if (!group) cells.set(key, (group = []))
    group.push(tree)
  }
  const meshes: Mesh[] = []
  for (const [key, group] of cells) {
    const mesh = new Mesh(`trees-${key}`, scene)
    const vertices = new VertexData()
    vertices.positions = new Float32Array(prototype.positions)
    vertices.normals = new Float32Array(prototype.normals)
    vertices.colors = new Float32Array(prototype.colors)
    vertices.indices = new Uint16Array(prototype.indices)
    vertices.applyToMesh(mesh)
    const matrices = new Float32Array(group.length * 16)
    const colors = new Float32Array(group.length * 4)
    group.forEach((tree, i) => {
      const o = i * 16
      const a = tree.shade * Math.PI * 2, c = Math.cos(a) * tree.scale, s = Math.sin(a) * tree.scale
      matrices.set([c, 0, -s, 0, 0, tree.scale, 0, 0, s, 0, c, 0, tree.x, 0.25, tree.z, 1], o)
      colors.set([0.76 + tree.shade * 0.3, 0.84 + tree.shade * 0.16, 0.7 + tree.shade * 0.26, 1], i * 4)
    })
    mesh.material = material
    mesh.thinInstanceSetBuffer('matrix', matrices, 16, true)
    mesh.thinInstanceSetBuffer('color', colors, 4, true)
    mesh.thinInstanceRefreshBoundingInfo(true)
    mesh.receiveShadows = true
    mesh.isPickable = false
    mesh.freezeWorldMatrix()
    meshes.push(mesh)
  }
  return meshes
}
