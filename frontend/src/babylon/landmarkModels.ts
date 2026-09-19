import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import '@babylonjs/loaders/glTF'
import type { WorldScene } from './scene'

const MODELS = new Set(['cn_tower', 'rogers_centre', 'union_station', 'scotiabank_arena'])

export async function loadLandmarkModels(ws: WorldScene): Promise<void> {
  await Promise.all(ws.world.landmarks.filter(l => MODELS.has(l.kind)).map(async l => {
    try {
      const asset = await LoadAssetContainerAsync(`/assets/city/models/${l.kind}.glb`, ws.scene)
      if (ws.scene.isDisposed) { asset.dispose(); return }
      const root = new TransformNode(`model-${l.kind}`, ws.scene)
      root.position.set(l.x, 0.3, l.z)
      asset.addAllToScene()
      for (const mesh of asset.rootNodes) mesh.parent = root
      for (const mesh of asset.meshes) {
        mesh.isPickable = false
        mesh.receiveShadows = true
        mesh.freezeWorldMatrix()
        if (mesh.getTotalVertices()) ws.shadows?.addShadowCaster(mesh, false)
      }
      for (const material of asset.materials) {
        if (material instanceof PBRMaterial) material.environmentIntensity = 0.65
        material.freeze()
      }
      for (const mesh of ws.city.chunks) if (mesh.metadata?.landmarkKind === l.kind) {
        mesh.setEnabled(false)
        ws.shadows?.removeShadowCaster(mesh, false)
      }
      ws.landmarkModelsLoaded++
      ws.invalidateShadows()
    } catch (error) {
      if (!ws.scene.isDisposed) console.warn(`Using procedural ${l.kind} fallback`, error)
    }
  }))
}
