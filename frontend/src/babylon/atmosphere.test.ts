import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { Camera } from '@babylonjs/core/Cameras/camera'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Material } from '@babylonjs/core/Materials/material'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { PBRMetallicRoughnessMaterial } from '@babylonjs/core/Materials/PBR/pbrMetallicRoughnessMaterial'
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import type { SubMesh } from '@babylonjs/core/Meshes/subMesh'
import { Scene } from '@babylonjs/core/scene'

import { applyWorldAtmosphere, worldFadeRange } from './atmosphere'
import { buildSky } from './sky'
import type { WorldCrs } from './coords'

const bounds: WorldCrs['bounds_world'] = [-3200, -2450, 3200, 2450]
const materialTypes = [['standard', StandardMaterial], ['PBR', PBRMaterial], ['metallic-roughness', PBRMetallicRoughnessMaterial]] as const

describe('World fade distances', () => {
  it('keeps the focus region clear at close, city, and overview zooms', () => {
    for (const radius of [45, 1650, 9000]) {
      const [start, end, edge] = worldFadeRange(bounds, radius, 40000)
      expect(start).toBeGreaterThan(radius)
      expect(end).toBeGreaterThan(start)
      expect(end).toBeLessThan(40000)
      expect(edge).toBe(490)
    }
  })

  it('finishes the fade before the far clipping plane even for very large worlds', () => {
    const [start, end] = worldFadeRange([-100000, -100000, 100000, 100000], 9000, 40000)
    expect(start).toBeLessThan(end)
    expect(end).toBeLessThan(40000)
  })

  it('uses city size, not its coordinates, and scales down for smaller packs', () => {
    expect(worldFadeRange([6800, 7550, 13200, 12450], 1650, 40000)).toEqual(worldFadeRange(bounds, 1650, 40000))
    const [start, end, edge] = worldFadeRange([4000, 7000, 4400, 7400], 450, 40000)
    expect(start).toBeGreaterThan(450)
    expect(end).toBeGreaterThan(start)
    expect(edge).toBeLessThan(200)
  })
})

describe('Sky-matched world atmosphere', () => {
  let engine: NullEngine
  let scene: Scene
  let camera: ArcRotateCamera

  beforeEach(() => {
    engine = new NullEngine()
    scene = new Scene(engine)
    camera = new ArcRotateCamera('camera', 0, 1, 1650, Vector3.Zero(), scene)
    camera.maxZ = 40000
  })

  afterEach(() => {
    scene.dispose()
    engine.dispose()
  })

  it.each(materialTypes)('applies to existing and later %s materials but not the sky or another scene', (_name, MaterialType) => {
    const sky = buildSky(scene, new Color3(0.86, 0.87, 0.9))
    const terrain = new MaterialType('terrain', scene)
    scene.fogMode = Scene.FOGMODE_EXP2
    applyWorldAtmosphere(scene, bounds, sky)
    const traffic = new MaterialType('traffic', scene)
    expect(scene.fogMode).toBe(Scene.FOGMODE_NONE)
    expect(terrain.pluginManager?.getPlugin('WorldAtmosphere')).toBeTruthy()
    expect(traffic.pluginManager?.getPlugin('WorldAtmosphere')).toBeTruthy()
    expect(sky.material?.pluginManager?.getPlugin('WorldAtmosphere')).toBeFalsy()
    const texture = (sky.material as StandardMaterial).emissiveTexture!
    expect(terrain.hasTexture(texture)).toBe(true)
    expect(traffic.getActiveTextures()).toContain(texture)
    const other = new Scene(engine)
    const unrelated = new MaterialType('unrelated', other)
    expect(unrelated.pluginManager?.getPlugin('WorldAtmosphere')).toBeFalsy()
    other.dispose()
    const weather = new MaterialType('hazard-storm-cloud-mat', scene)
    expect(weather.pluginManager?.getPlugin('WorldAtmosphere')).toBeFalsy()
    const marks = new MaterialType('overlay-mat', scene)
    expect(marks.pluginManager?.getPlugin('WorldAtmosphere')).toBeFalsy()
  })

  it.each(materialTypes)('updates fade uniforms after zooming even when the %s material is frozen', (_name, MaterialType) => {
    const sky = buildSky(scene, new Color3(0.86, 0.87, 0.9))
    const terrain = new MaterialType('terrain', scene)
    applyWorldAtmosphere(scene, bounds, sky)
    terrain.freeze()
    const plugin = terrain.pluginManager!.getPlugin('WorldAtmosphere')!
    expect(plugin.registerForExtraEvents).toBe(true)
    const uniforms = { updateFloat4: vi.fn(), updateFloat3: vi.fn(), setTexture: vi.fn() }
    plugin.hardBindForSubMesh(uniforms as unknown as UniformBuffer, scene, engine, {} as SubMesh)
    expect(uniforms.updateFloat3).toHaveBeenLastCalledWith('worldFadeRange', ...worldFadeRange(bounds, 1650, 40000))
    camera.radius = 9000
    scene.onBeforeRenderObservable.notifyObservers(scene)
    plugin.hardBindForSubMesh(uniforms as unknown as UniformBuffer, scene, engine, {} as SubMesh)
    expect(uniforms.updateFloat3).toHaveBeenLastCalledWith('worldFadeRange', ...worldFadeRange(bounds, 9000, 40000))
    expect(uniforms.updateFloat4).toHaveBeenCalledWith('worldFadeBounds', ...bounds)
    expect(uniforms.setTexture).toHaveBeenLastCalledWith('worldSkySampler', (sky.material as StandardMaterial).emissiveTexture)
  })

  it('keeps sky sampling aligned when switching between orthographic and perspective views', () => {
    const sky = buildSky(scene, new Color3(0.86, 0.87, 0.9))
    const terrain = new StandardMaterial('terrain', scene)
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA
    applyWorldAtmosphere(scene, bounds, sky)
    terrain.freeze()
    const plugin = terrain.pluginManager!.getPlugin('WorldAtmosphere')!
    const uniforms = { updateFloat4: vi.fn(), updateFloat3: vi.fn(), setTexture: vi.fn() }
    plugin.hardBindForSubMesh(uniforms as unknown as UniformBuffer, scene, engine, {} as SubMesh)
    const orthographic = uniforms.updateFloat4.mock.calls.findLast(([name]) => name === 'worldSkyView')
    expect(orthographic).toBeDefined()
    expect(orthographic?.[4]).toBe(1)
    expect(Math.hypot(...orthographic!.slice(1, 4))).toBeCloseTo(1)
    camera.mode = Camera.PERSPECTIVE_CAMERA
    camera.alpha += 0.5
    scene.onBeforeRenderObservable.notifyObservers(scene)
    plugin.hardBindForSubMesh(uniforms as unknown as UniformBuffer, scene, engine, {} as SubMesh)
    const perspective = uniforms.updateFloat4.mock.calls.findLast(([name]) => name === 'worldSkyView')
    expect(perspective?.[4]).toBe(0)
    expect(perspective?.slice(1, 4)).not.toEqual(orthographic?.slice(1, 4))
  })

  it('converts the sky to linear space before composing PBR lighting', () => {
    const sky = buildSky(scene, new Color3(0.86, 0.87, 0.9))
    const terrain = new PBRMaterial('terrain', scene)
    applyWorldAtmosphere(scene, bounds, sky)
    const code = terrain.pluginManager?.getPlugin('WorldAtmosphere')?.getCustomCode('fragment')?.CUSTOM_FRAGMENT_BEFORE_FOG
    expect(code).toContain('PBR_FRAGMENT_SHADER')
    expect(code).toContain('finalColor.rgb')
    expect(code).toContain('toLinearSpace')
  })

  it.each(materialTypes)('keeps the shared sky texture alive when disposing a %s material and removes its observer', async (_name, MaterialType) => {
    const sky = buildSky(scene, new Color3(0.86, 0.87, 0.9))
    const baseline = [...Material.OnEventObservable.observers]
    applyWorldAtmosphere(scene, bounds, sky)
    expect(Material.OnEventObservable.observers.length).toBe(baseline.length + 1)
    let disposed = false
    const texture = (sky.material as StandardMaterial).emissiveTexture!
    texture.onDisposeObservable.add(() => { disposed = true })
    const terrain = new MaterialType('terrain', scene)
    terrain.dispose(false, true)
    expect(disposed).toBe(false)
    scene.dispose()
    expect(disposed).toBe(true)
    await vi.waitFor(() => expect(Material.OnEventObservable.observers.every((observer) => baseline.includes(observer))).toBe(true))
  })
})
