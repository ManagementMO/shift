import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { Scene } from '@babylonjs/core/scene'

import { buildSky, skyTexturePixels } from './sky'

const horizon = new Color3(0.86, 0.87, 0.9)

describe('Procedural sky texture', () => {
  const width = 128, height = 64
  const pixels = skyTexturePixels(horizon, width, height)
  const pixel = (x: number, y: number) => pixels.slice((y * width + x) * 4, (y * width + x + 1) * 4)

  it('generates deterministic opaque clouds with variation beyond the vertical gradient', () => {
    expect(pixels).toEqual(skyTexturePixels(horizon, width, height))
    expect(pixels).toHaveLength(width * height * 4)
    for (let i = 3; i < pixels.length; i += 4) expect(pixels[i]).toBe(255)
    const shades = Array.from({ length: width }, (_, x) => pixel(x, height / 2)[0])
    expect(new Set(shades).size).toBeGreaterThan(15)
    expect(Math.max(...shades) - Math.min(...shades)).toBeGreaterThan(25)
  })

  it('joins seamlessly around the panorama and converges at both poles', () => {
    for (let y = 0; y < height; y++) expect(pixel(0, y)).toEqual(pixel(width - 1, y))
    for (let x = 0; x < width; x++) {
      expect(pixel(x, 0)).toEqual(pixel(0, 0))
      expect(pixel(x, height - 1)).toEqual(pixel(0, height - 1))
    }
  })

  it('fades the lower sky into the supplied haze color and keeps a blue zenith', () => {
    const haze = new Uint8Array([Math.round(horizon.r * 255), Math.round(horizon.g * 255), Math.round(horizon.b * 255), 255])
    for (let x = 0; x < width; x++) expect(pixel(x, Math.floor(height / 4))).toEqual(haze)
    const top = pixel(0, height - 1)
    expect(top[2]).toBeGreaterThan(top[0])
    expect(top[0]).toBeLessThan(haze[0])
  })
})

describe('Textured sky dome', () => {
  let engine: NullEngine
  let scene: Scene

  beforeEach(() => {
    engine = new NullEngine()
    scene = new Scene(engine)
  })

  afterEach(() => {
    scene.dispose()
    engine.dispose()
  })

  it('uses an opaque, unlit cloud texture without affecting picking or fog', () => {
    const sky = buildSky(scene, horizon)
    const material = sky.material as StandardMaterial
    expect(material.emissiveTexture).toBeInstanceOf(RawTexture)
    expect(material.getActiveTextures()).toHaveLength(1)
    expect(material.emissiveTexture?.getSize()).toEqual({ width: 1024, height: 512 })
    expect(material.emissiveTexture?.hasAlpha).toBe(false)
    expect(material.emissiveTexture?.wrapU).toBe(Texture.WRAP_ADDRESSMODE)
    expect(material.emissiveTexture?.wrapV).toBe(Texture.CLAMP_ADDRESSMODE)
    expect(material.disableLighting).toBe(true)
    expect(material.fogEnabled).toBe(false)
    expect(sky.applyFog).toBe(false)
    expect(sky.isPickable).toBe(false)
    expect(sky.infiniteDistance).toBe(true)
  })

  it('maps every triangle locally without stretching across the panorama seam', () => {
    const sky = buildSky(scene, horizon)
    const uvs = sky.getVerticesData('uv') ?? []
    expect(uvs).toHaveLength(sky.getTotalVertices() * 2)
    const indices = sky.getIndices()!
    const us = Array.from(uvs).filter((_, i) => i % 2 === 0)
    expect(Math.min(...us)).toBe(0)
    expect(Math.max(...us)).toBe(1)
    for (let i = 0; i < indices.length; i += 3) {
      const u = [uvs[indices[i] * 2], uvs[indices[i + 1] * 2], uvs[indices[i + 2] * 2]]
      expect(Math.max(...u) - Math.min(...u)).toBeLessThan(0.05)
    }
  })

  it('releases its texture when the scene is disposed', () => {
    const sky = buildSky(scene, horizon)
    const textures = sky.material!.getActiveTextures()
    expect(textures).toHaveLength(1)
    let disposed = false
    textures[0].onDisposeObservable.add(() => { disposed = true })
    scene.dispose()
    expect(disposed).toBe(true)
    expect(scene.textures).toHaveLength(0)
  })
})
