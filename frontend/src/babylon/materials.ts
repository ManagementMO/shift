import { Color3 } from '@babylonjs/core/Maths/math.color'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import type { Scene } from '@babylonjs/core/scene'

import { texturePixels, type TextureKind } from './appearance'

const GLAZED = new Set<TextureKind>(['glass', 'curtain', 'copper', 'balcony', 'darkglass'])
const SURFACES = new Set<TextureKind>(['roof', 'asphalt', 'pavement', 'grass', 'sand', 'concrete', 'water'])

export class CityMaterials {
  private readonly scene: Scene
  private readonly materials = new Map<TextureKind, PBRMaterial>()
  private readonly facadeResolution: number

  constructor(scene: Scene, facadeResolution = 1024) {
    this.scene = scene
    this.facadeResolution = facadeResolution
  }

  get(kind: TextureKind): PBRMaterial {
    const cached = this.materials.get(kind)
    if (cached) return cached
    const size = SURFACES.has(kind) ? 512 : this.facadeResolution
    const pixels = texturePixels(kind, size)
    const texture = RawTexture.CreateRGBATexture(pixels, size, size, this.scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
    texture.name = `city-${kind}-albedo`
    texture.wrapU = texture.wrapV = Texture.WRAP_ADDRESSMODE
    texture.anisotropicFilteringLevel = 16
    const material = new PBRMaterial(`city-${kind}`, this.scene)
    material.albedoTexture = texture
    material.albedoColor = Color3.White()
    material.metallic = GLAZED.has(kind) ? 0.25 : kind === 'water' ? 0.12 : 0
    material.roughness = GLAZED.has(kind) ? 0.3 : kind === 'water' ? 0.22 : kind === 'roof' ? 0.76 : 0.88
    material.environmentIntensity = GLAZED.has(kind) ? 0.5 : 0.25
    material.directIntensity = 1
    material.specularIntensity = kind === 'water' ? 0.55 : 0.6
    if (kind === 'brick' || kind === 'masonry' || kind === 'pavement' || kind === 'water') {
      const normal = new Uint8Array(pixels.length)
      const height = (x: number, y: number) => pixels[(((y + size) % size) * size + (x + size) % size) * 4] / 255
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4
        normal[i] = 128 + (height(x - 1, y) - height(x + 1, y)) * 95
        normal[i + 1] = 128 + (height(x, y - 1) - height(x, y + 1)) * 95
        normal[i + 2] = 255; normal[i + 3] = 255
      }
      const bump = RawTexture.CreateRGBATexture(normal, size, size, this.scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
      bump.name = `city-${kind}-normal`
      bump.gammaSpace = false
      bump.wrapU = bump.wrapV = Texture.WRAP_ADDRESSMODE
      bump.level = kind === 'water' ? 0.6 : 0.22
      material.bumpTexture = bump
    }
    this.materials.set(kind, material)
    return material
  }

  dispose(): void {
    for (const material of this.materials.values()) material.dispose(false, true)
    this.materials.clear()
  }
}
