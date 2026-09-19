import { Color3 } from '@babylonjs/core/Maths/math.color'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import type { Scene } from '@babylonjs/core/scene'

import { TEXTURE_RECIPES, texturePixels, type TextureKind } from './appearance'

export class CityMaterials {
  private readonly scene: Scene
  private readonly materials = new Map<TextureKind, StandardMaterial>()

  constructor(scene: Scene) {
    this.scene = scene
  }

  get(kind: TextureKind): StandardMaterial {
    let material = this.materials.get(kind)
    if (material) return material
    const recipe = TEXTURE_RECIPES[kind]
    const texture = RawTexture.CreateRGBATexture(texturePixels(kind), 256, 256, this.scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
    texture.name = `city-${kind}`
    texture.wrapU = texture.wrapV = Texture.WRAP_ADDRESSMODE
    texture.anisotropicFilteringLevel = 8
    material = new StandardMaterial(`city-${kind}`, this.scene)
    material.diffuseTexture = texture
    material.diffuseColor = Color3.White()
    material.ambientColor = new Color3(0.25, 0.25, 0.25)
    material.specularColor = new Color3(recipe.specular, recipe.specular, recipe.specular)
    material.specularPower = kind === 'glass' || kind === 'water' ? 96 : 24
    this.materials.set(kind, material)
    return material
  }

  dispose(): void {
    for (const material of this.materials.values()) material.dispose(false, true)
    this.materials.clear()
  }
}
