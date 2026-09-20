import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { SmokeSprites, smokeTexturePixels } from './smoke'
import { vortexSmoke, type VortexShape } from './vortex'

const shape: VortexShape = { x: 430, z: -605, radius: 110, height: 260, direction: [1, 0], seconds: 16, strength: 1, seed: 0.3 }

describe('soft smoke particles', () => {
  it('has transparent sprite borders and varied density inside', () => {
    const size = 64
    const pixels = smokeTexturePixels(size)
    const alpha = (x: number, y: number) => pixels[(y * size + x) * 4 + 3]
    for (let i = 0; i < size; i++) {
      expect(alpha(0, i)).toBe(0)
      expect(alpha(size - 1, i)).toBe(0)
      expect(alpha(i, 0)).toBe(0)
      expect(alpha(i, size - 1)).toBe(0)
    }
    expect(alpha(32, 32)).toBeGreaterThan(40)
    expect(new Set(pixels.filter((_, i) => i % 4 === 3)).size).toBeGreaterThan(50)
    expect(smokeTexturePixels(size)).toEqual(pixels)
  })

  it('reconstructs the same vortex on rewind without a hard mesh surface', () => {
    const first = vortexSmoke(shape)
    vortexSmoke({ ...shape, seconds: 42 })
    expect(vortexSmoke(shape)).toEqual(first)
    expect(first).toHaveLength(760)
    expect(vortexSmoke({ ...shape, strength: 0 })).toEqual([])
    for (const p of first) {
      expect([p.x, p.y, p.z, p.width, p.height, p.alpha, p.angle].every(Number.isFinite)).toBe(true)
      expect(p.alpha).toBeGreaterThanOrEqual(0)
      expect(p.alpha).toBeLessThan(1)
    }
    const high = first.slice(0, 600).filter((p) => p.y > shape.height * 0.96)
    expect(high.length).toBeGreaterThan(0)
    expect(high.every((p) => p.alpha < 0.07)).toBe(true)
  })

  it('draws camera-facing quads with alpha blending and releases their assets', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const smoke = new SmokeSprites(scene, 'smoke-test')
    expect(smoke.mesh.getTotalVertices()).toBe(4)
    expect(smoke.mesh.isEnabled()).toBe(false)
    smoke.draw(vortexSmoke(shape))
    expect(smoke.mesh.thinInstanceCount).toBe(760)
    expect(smoke.mesh.material!.needAlphaBlending()).toBe(true)
    expect(smoke.mesh.material!.disableDepthWrite).toBe(true)
    smoke.draw([])
    expect(smoke.mesh.isEnabled()).toBe(false)
    smoke.dispose()
    expect(scene.getMeshByName('smoke-test')).toBeNull()
    expect(scene.textures).toHaveLength(0)
    scene.dispose()
    engine.dispose()
  })
})
