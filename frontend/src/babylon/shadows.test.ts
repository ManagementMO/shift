import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent'
import { fitShadowLight } from './shadows'

describe('World-aligned sun shadows', () => {
  it('keeps the shadow transform identical through rotations, zooms and camera clip changes', () => {
    const engine = new NullEngine()
    engine.useReverseDepthBuffer = true
    const scene = new Scene(engine)
    const camera = new ArcRotateCamera('camera', 0, 0.8, 1000, Vector3.Zero(), scene)
    const sun = new DirectionalLight('sun', new Vector3(0.5, -0.72, 0.42).normalize(), scene)
    fitShadowLight(sun, [-3000, -3000, 3000, 3000], 600)
    const shadows = new ShadowGenerator(1024, sun)
    const near = Vector3.TransformCoordinates(sun.position.add(sun.direction.scale(sun.shadowMinZ! + 1)), shadows.getTransformMatrix())
    const far = Vector3.TransformCoordinates(sun.position.add(sun.direction.scale(sun.shadowMaxZ! - 1)), shadows.getTransformMatrix())
    expect(near.z).toBeGreaterThan(far.z)
    const reference = Array.from(shadows.getTransformMatrix().m)
    for (let heading = 0; heading < 360; heading += 15) {
      camera.alpha = heading * Math.PI / 180
      camera.radius = 50 + heading * 25
      camera.minZ = 0.1 + heading / 100
      camera.maxZ = 10000 + heading * 100
      camera.getViewMatrix(true)
      scene.incrementRenderId()
      expect(Array.from(shadows.getTransformMatrix().m)).toEqual(reference)
    }
    expect(sun.autoUpdateExtends).toBe(false)
    for (const x of [-3000, 3000]) for (const y of [0, 600]) for (const z of [-3000, 3000]) {
      const p = Vector3.TransformCoordinates(new Vector3(x, y, z), shadows.getTransformMatrix())
      expect(Math.abs(p.x)).toBeLessThan(1)
      expect(Math.abs(p.y)).toBeLessThan(1)
      expect(Math.abs(p.z)).toBeLessThanOrEqual(1)
    }
    scene.dispose()
    engine.dispose()
  })
})
