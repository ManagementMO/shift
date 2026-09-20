import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { SmokeSprites, smokeTexturePixels } from './smoke'

describe('tornado-style weather sprites', () => {
  it.each([false, true])('feathers every texture border to zero alpha (ground=%s)', (ground) => {
    const n = 64, pixels = smokeTexturePixels(n, ground)
    const alpha = (x: number, y: number) => pixels[(y * n + x) * 4 + 3]
    for (let i = 0; i < n; i++) {
      expect(alpha(0, i)).toBe(0)
      expect(alpha(n - 1, i)).toBe(0)
      expect(alpha(i, 0)).toBe(0)
      expect(alpha(i, n - 1)).toBe(0)
    }
    expect(alpha(32, 32)).toBeGreaterThan(40)
    expect(new Set(pixels.filter((_, i) => i % 4 === 3)).size).toBeGreaterThan(50)
    expect(smokeTexturePixels(n, ground)).toEqual(pixels)
    if (ground) {
      expect(alpha(40, 32)).toBeLessThan(alpha(32, 32))
      expect(alpha(50, 32)).toBeLessThan(alpha(40, 32))
      expect(alpha(60, 32)).toBeLessThan(3)
    }
  })

  it('uses instanced soft quads, not solid cloud geometry, and releases every resource', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const smoke = new SmokeSprites(scene, 'hazard-cloud-test')
    expect(smoke.mesh.getTotalVertices()).toBe(4)
    expect(smoke.mesh.isEnabled()).toBe(false)
    smoke.draw(Array.from({ length: 120 }, (_, i) => ({ x: i, y: 100, z: 0, width: 30, height: 20, angle: i, color: [1, 1, 1], alpha: 0.3 })))
    expect(smoke.mesh.thinInstanceCount).toBe(120)
    expect(smoke.mesh.material!.needAlphaBlending()).toBe(true)
    expect(smoke.mesh.material!.disableDepthWrite).toBe(true)
    smoke.draw([])
    expect(smoke.mesh.isEnabled()).toBe(false)
    smoke.dispose()
    expect(scene.meshes).toHaveLength(0)
    expect(scene.materials).toHaveLength(0)
    expect(scene.textures).toHaveLength(0)
    scene.dispose()
    engine.dispose()
  })
})
