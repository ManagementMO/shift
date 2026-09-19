import { afterEach, describe, expect, it, vi } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { Camera } from '@babylonjs/core/Cameras/camera'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { WorldCamera } from './camera'
import type { WorldData } from './worldData'

const world = { landmarks: [], crs: { bounds_world: [-1000, -1000, 1000, 1000] } } as unknown as WorldData
afterEach(() => vi.unstubAllGlobals())

describe('Cityscape camera', () => {
  it('keeps an undistorted orthographic image as zoom changes', () => {
    const engine = new NullEngine({ renderWidth: 1200, renderHeight: 800, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 4 })
    const scene = new Scene(engine)
    const cam = new ArcRotateCamera('camera', 0, 1, 1000, Vector3.Zero(), scene)
    const camera = new WorldCamera(cam, world)
    expect(cam.mode).toBe(Camera.ORTHOGRAPHIC_CAMERA)
    camera.apply({ target: [0, 0], radius: 1000, heading: -28, elevation: 43 })
    const firstHeight = cam.orthoTop! - cam.orthoBottom!
    expect((cam.orthoRight! - cam.orthoLeft!) / firstHeight).toBeCloseTo(1.5)
    camera.apply({ ...camera.pose, radius: 500 })
    expect(cam.orthoTop! - cam.orthoBottom!).toBeCloseTo(firstHeight / 2)
    scene.dispose(); engine.dispose()
  })

  it('applies reduced-motion jumps immediately and restores strategic projection after inspecting an agent', () => {
    const engine = new NullEngine(), scene = new Scene(engine)
    const cam = new ArcRotateCamera('camera', 0, 1, 1000, Vector3.Zero(), scene)
    const camera = new WorldCamera(cam, world)
    camera.agent(120, -40, 30, 0)
    expect(camera.flying).toBe(false)
    expect(camera.pose.target).toEqual([120, -40])
    expect(cam.mode).toBe(Camera.PERSPECTIVE_CAMERA)
    expect(camera.pose.radius).toBe(95)
    camera.city(0)
    expect(cam.mode).toBe(Camera.ORTHOGRAPHIC_CAMERA)
    expect(camera.pose.target).toEqual([0, 0])
    scene.dispose(); engine.dispose()
  })

  it('cancels pending camera animation when leaving a scene', () => {
    const request = vi.fn(() => 17), cancel = vi.fn()
    vi.stubGlobal('requestAnimationFrame', request)
    vi.stubGlobal('cancelAnimationFrame', cancel)
    const engine = new NullEngine(), scene = new Scene(engine)
    const camera = new WorldCamera(new ArcRotateCamera('camera', 0, 1, 1000, Vector3.Zero(), scene), world)
    camera.city(1000)
    expect(camera.flying).toBe(true)
    camera.cancel()
    expect(cancel).toHaveBeenCalledWith(17)
    expect(camera.flying).toBe(false)
    scene.dispose(); engine.dispose()
  })
})
