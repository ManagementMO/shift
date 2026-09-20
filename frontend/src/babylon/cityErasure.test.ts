import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder'
import { Scene } from '@babylonjs/core/scene'
import { CityErasure } from './cityErasure'

describe('circular city erasure', () => {
  let engine: NullEngine
  let scene: Scene
  let erasure: CityErasure

  beforeEach(() => { engine = new NullEngine(); scene = new Scene(engine) })
  afterEach(() => { erasure.dispose(); scene.dispose(); engine.dispose() })

  it('covers both material families, including late-loaded landmarks, without erasing the sky', () => {
    const ground = new PBRMaterial('ground', scene)
    const sky = new StandardMaterial('sky', scene)
    erasure = new CityErasure(scene)
    const landmark = new PBRMaterial('late-landmark', scene)
    const trees = new StandardMaterial('foliage', scene)
    for (const material of [ground, landmark, trees]) {
      const plugin = material.pluginManager?.getPlugin('OrbitalErasure')
      expect(plugin?.getCustomCode('fragment')?.CUSTOM_FRAGMENT_MAIN_BEGIN).toContain('vPositionW.xz')
      expect(plugin?.getCustomCode('fragment')?.CUSTOM_FRAGMENT_MAIN_BEGIN).toContain('discard')
    }
    expect(sky.pluginManager?.getPlugin('OrbitalErasure')).toBeFalsy()
  })

  it('updates frozen materials and preserves new developments and independently hidden travelers', () => {
    erasure = new CityErasure(scene)
    erasure.circles = [{ x: 40, z: 60, radius: 150 }]
    const material = new PBRMaterial('shared-building-and-development', scene)
    const mesh = CreateBox('city-prop', {}, scene)
    mesh.material = material
    material.freeze()
    const plugin = material.pluginManager!.getPlugin('OrbitalErasure')!
    const uniforms = { updateFloat: vi.fn(), updateFloat4: vi.fn() }
    const bind = () => plugin.hardBindForSubMesh(uniforms as unknown as UniformBuffer, scene, engine, mesh.subMeshes[0])
    bind()
    expect(plugin.registerForExtraEvents).toBe(true)
    expect(uniforms.updateFloat).toHaveBeenLastCalledWith('orbitalClipEnabled', 1)
    expect(uniforms.updateFloat4).toHaveBeenCalledWith('orbitalCut0', 40, 60, 150, 1)
    mesh.metadata = { development_id: 'new-building' }
    bind()
    expect(uniforms.updateFloat).toHaveBeenLastCalledWith('orbitalClipEnabled', 0)
    mesh.metadata = { cityTraffic: true }
    bind()
    expect(uniforms.updateFloat).toHaveBeenLastCalledWith('orbitalClipEnabled', 0)
    mesh.metadata = null
    erasure.circles = []
    bind()
    expect(uniforms.updateFloat).toHaveBeenLastCalledWith('orbitalClipEnabled', 0)
    expect(uniforms.updateFloat4).toHaveBeenLastCalledWith('orbitalCut7', 0, 0, 0, 0)
  })

  it('uses the union of cleared radii and restores only the removed circle', () => {
    erasure = new CityErasure(scene)
    const first = { x: 0, z: 0, radius: 100 }
    const second = { x: 150, z: 0, radius: 100 }
    erasure.circles = [first, second]
    expect(erasure.contains(75, 0)).toBe(true)
    expect(erasure.contains(0, 101)).toBe(false)
    erasure.circles = [second]
    expect(erasure.contains(75, 0)).toBe(true)
    expect(erasure.contains(0, 0)).toBe(false)
    erasure.dispose()
    expect(erasure.contains(75, 0)).toBe(false)
  })
})
