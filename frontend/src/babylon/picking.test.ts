import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import './WorldBabylon'
import { meshFromBatch, vertexColorMaterial } from './city'
import { Batch } from './geometry'

describe('development map picking', () => {
  it.each([false, true])('picks the ground with reverse depth %s through the production renderer imports', (reverse) => {
    const engine = new NullEngine()
    engine.useReverseDepthBuffer = reverse
    const scene = new Scene(engine)
    const camera = new FreeCamera('camera', new Vector3(0, 100, -100), scene)
    camera.setTarget(Vector3.Zero())
    const batch = new Batch()
    batch.polygon([-50, -50, 50, -50, 50, 50, -50, 50], undefined, 0, [1, 1, 1])
    const material = vertexColorMaterial('ground-material', scene)
    const ground = meshFromBatch('ground', batch, scene, material)
    ground.isPickable = true
    scene.setTransformMatrix(camera.getViewMatrix(), camera.getProjectionMatrix())
    const hit = scene.pick(engine.getRenderWidth() / 2, engine.getRenderHeight() / 2, (mesh) => mesh === ground)
    expect(hit?.hit).toBe(true)
    expect(hit?.pickedPoint?.y).toBeCloseTo(0)
    scene.dispose()
    engine.dispose()
  })
})
