import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'

import { facadeFor, TEXTURE_RECIPES, texturePixels } from './appearance'
import { CityMaterials } from './materials'

describe('Reusable city appearance', () => {
  it('selects facades from building properties, not city names or coordinates', () => {
    expect(facadeFor({ cat: 'office', h: 60 })).toBe('glass')
    expect(facadeFor({ cat: 'residential', h: 8 })).toBe('brick')
    expect(facadeFor({ cat: 'apartments', h: 30 })).toBe('masonry')
    expect(facadeFor({ cat: 'industrial', h: 12 })).toBe('industrial')
    expect(facadeFor({ cat: 'generic', h: 130 })).toBe('glass')
    expect(facadeFor({ cat: 'generic', h: 12 })).toBe('masonry')
  })

  it('generates deterministic opaque textures with visible variation', () => {
    for (const kind of Object.keys(TEXTURE_RECIPES) as (keyof typeof TEXTURE_RECIPES)[]) {
      const a = texturePixels(kind, 32)
      expect(a).toEqual(texturePixels(kind, 32))
      expect(a.length).toBe(32 * 32 * 4)
      const shades = new Set<number>()
      for (let i = 0; i < a.length; i += 4) {
        expect(a[i + 3]).toBe(255)
        shades.add(a[i])
      }
      expect(shades.size).toBeGreaterThan(3)
      expect(TEXTURE_RECIPES[kind].metres.every((n) => n > 0)).toBe(true)
    }
  })

  it('shares materials within a scene and releases all owned textures', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const baseline = scene.textures.length
    const library = new CityMaterials(scene)
    const a = library.get('glass')
    const brdf = a.environmentBRDFTexture
    expect(library.get('glass')).toBe(a)
    expect(library.get('brick')).not.toBe(a)
    expect(scene.textures.filter(t => t !== brdf).length).toBe(baseline + 3)
    expect(a.albedoTexture?.getSize().width).toBe(1024)
    library.dispose()
    expect(scene.textures.filter(t => t !== brdf).length).toBe(baseline)
    expect(scene.textures).toContain(brdf)
    scene.dispose()
    expect(scene.textures).toHaveLength(0)
    engine.dispose()
  })
})
