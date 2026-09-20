import { afterEach, describe, expect, it, vi } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Camera } from '@babylonjs/core/Cameras/camera'

import { cityPose, WorldCamera } from './camera'
import type { WorldData } from './worldData'

const world: WorldData = {
  version: 1, pack_id: 'toronto', network_fingerprint: '',
  crs: { proj: '', utm_zone: 17, net_offset: [0, 0], origin_net: [0, 0], origin_lonlat: [-79.389, 43.649], bounds_world: [-3203.9, -2450.4, 3203.9, 2450.4] },
  anchors: [], venue: { x: 12.3, z: -774, edge: '' }, stops: [], zones: [], roads: [], junctions: [], buildings: [],
  landmarks: [
    { id: 'cn', kind: 'cn_tower', name: 'CN Tower', x: 179.1, z: -662.1, h: 553, ring: [] },
    { id: 'union', kind: 'union_station', name: 'Union Station', x: 704.9, z: -413.3, h: 26, ring: [] },
  ],
  green: [], sand: [], rail: [], water: [], counts: {}, provenance: [],
}
const engines: NullEngine[] = []

function setup(width = 1440, height = 900, fixed = true) {
  const engine = new NullEngine({ renderWidth: width, renderHeight: height, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 4 })
  engines.push(engine)
  const scene = new Scene(engine)
  const cam = new ArcRotateCamera('camera', 0, 0.5, 100, Vector3.Zero(), scene)
  return { cam, camera: new WorldCamera(cam, world, fixed) }
}

function expectInsideCity(cam: ArcRotateCamera, width: number, height: number) {
  const [x0, z0, x1, z1] = world.crs.bounds_world
  for (const [x, y] of [[0, 0], [width, 0], [0, height], [width, height]]) {
    const near = Vector3.Unproject(new Vector3(x, y, 0), width, height, Matrix.IdentityReadOnly, cam.getViewMatrix(), cam.getProjectionMatrix())
    const far = Vector3.Unproject(new Vector3(x, y, 1), width, height, Matrix.IdentityReadOnly, cam.getViewMatrix(), cam.getProjectionMatrix())
    const ray = far.subtract(near).normalize()
    expect(ray.y).toBeLessThan(0)
    const ground = near.add(ray.scale(-near.y / ray.y))
    expect(ground.x).toBeGreaterThan(x0 + 100)
    expect(ground.x).toBeLessThan(x1 - 100)
    expect(ground.z).toBeGreaterThan(z0 + 100)
    expect(ground.z).toBeLessThan(z1 - 100)
  }
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('fixed city camera', () => {
  it('locks the viewing angle, zoom limits, and camera inputs', () => {
    const { cam, camera } = setup()
    expect(camera.fixed).toBe(true)
    expect(camera.pose.heading).toBeCloseTo((cityPose(world).heading + 360) % 360)
    expect(camera.pose.elevation).toBeCloseTo(52)
    expect(cam.lowerRadiusLimit).toBe(cam.upperRadiusLimit)
    expect(cam.lowerAlphaLimit).toBe(cam.upperAlphaLimit)
    expect(cam.lowerBetaLimit).toBe(cam.upperBetaLimit)
    expect(Object.keys(cam.inputs.attached)).toHaveLength(0)
  })

  it('ignores unrestricted flights, direct moves, and entity following', () => {
    const { camera } = setup()
    const pose = camera.pose
    camera.apply({ target: [10000, 10000], radius: 9000, heading: 180, elevation: 5 })
    camera.flyTo({ target: [-10000, -10000], radius: 45, heading: 90, elevation: 8 }, 100, 'agent')
    camera.follow(20000, 20000)
    expect(camera.pose).toEqual(pose)
    expect(camera.mode).toBe('city')
    expect(camera.flying).toBe(false)
  })

  it.each([[1440, 900], [390, 844], [3440, 1440], [3840, 1080], [800, 300]])('keeps the entire ground viewport inside the rendered city at %ix%i', (width, height) => {
    const { cam } = setup(width, height)
    expectInsideCity(cam, width, height)
  })

  it('tightens the framing for ultrawide windows without changing the angle or center', () => {
    const { camera } = setup()
    const initial = camera.pose
    camera.resize(4)
    expect(camera.pose.radius).toBeLessThan(initial.radius)
    expect(camera.pose.target).toEqual(initial.target)
    expect(camera.pose.heading).toBe(initial.heading)
    expect(camera.pose.elevation).toBe(initial.elevation)
  })

  it('switches approved presets without unlocking free camera inputs', () => {
    const { cam, camera } = setup()
    const city = camera.pose
    camera.setPreset({ target: [12.3, -774], radius: 800, heading: -17, elevation: 45 }, 'district', 0)
    expect(camera.mode).toBe('district')
    expect(camera.pose.radius).toBeLessThan(city.radius)
    expect(camera.pose.target).toEqual([12.3, -774])
    expect(camera.pose.heading).not.toBe(city.heading)
    expect(cam.lowerRadiusLimit).toBe(cam.upperRadiusLimit)
    expect(Object.keys(cam.inputs.attached)).toHaveLength(0)
    expectInsideCity(cam, 1440, 900)
    camera.city(0)
    expect(camera.mode).toBe('city')
    expect(camera.pose).toEqual(city)
  })

  it('preserves the selected preset when the viewport resizes', () => {
    const { camera } = setup()
    camera.setPreset({ target: [100, -200], radius: 1400, heading: 80, elevation: 42 }, 'corridor', 0)
    const preset = camera.pose
    camera.resize(4)
    expect(camera.mode).toBe('corridor')
    expect(camera.pose.radius).toBeLessThan(preset.radius)
    expect(camera.pose.target).toEqual(preset.target)
    expect(camera.pose.heading).toBe(preset.heading)
    camera.resize(1440 / 900)
    expect(camera.pose).toEqual(preset)
  })

  it.each([[9000, 9000], [-9000, -9000], [3200, -2400]])('keeps an outlying preset target at %i,%i inside rendered bounds', (x, z) => {
    const { cam, camera } = setup(3440, 900)
    camera.setPreset({ target: [x, z], radius: 5000, heading: 140, elevation: 15, y: 100 }, 'incident', 0)
    expect(camera.pose.radius).toBeGreaterThan(1)
    expect(camera.pose.elevation).toBeGreaterThanOrEqual(42)
    expect(camera.pose.y).toBe(0)
    expectInsideCity(cam, 3440, 900)
  })

  it('keeps every animation frame within the rendered city', () => {
    let now = 0
    let frame: FrameRequestCallback | null = null
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => { frame = null })
    const { cam, camera } = setup(3440, 900)
    camera.setPreset({ target: [3000, -2400], radius: 900, heading: 170, elevation: 25 }, 'corridor', 1000)
    expect(camera.flying).toBe(true)
    for (now = 100; now <= 1000; now += 100) {
      const callback = frame as FrameRequestCallback | null
      frame = null
      callback?.(now)
      expectInsideCity(cam, 3440, 900)
    }
    expect(camera.flying).toBe(false)
    expect(camera.mode).toBe('corridor')
  })

  it('keeps free camera inputs available before and after choosing a preset', () => {
    const { cam, camera } = setup(1440, 900, false)
    expect(camera.fixed).toBe(false)
    expect(Object.keys(cam.inputs.attached).length).toBeGreaterThan(0)
    expectInsideCity(cam, 1440, 900)
    camera.setPreset({ target: [9000, 9000], radius: 5000, heading: 90, elevation: 20 }, 'district', 0)
    expectInsideCity(cam, 1440, 900)
    cam.radius *= 0.8
    cam.alpha += 0.3
    cam.target.x += 100
    const manual = camera.pose
    camera.resize(4)
    expect(camera.pose).toEqual(manual)
    expect(Object.keys(cam.inputs.attached).length).toBeGreaterThan(0)
    camera.city(0)
    expect(camera.pose).not.toEqual(manual)
    expectInsideCity(cam, 1440, 900)
  })

  it('maps secondary-click drag to rotation and middle or Ctrl-drag to pan', () => {
    const { cam } = setup(1440, 900, false)
    expect(cam.movement.input.resolveInteraction('pointer', { button: 2, modifiers: {} })?.interaction).toBe('rotate')
    expect(cam.movement.input.resolveInteraction('pointer', { button: 1, modifiers: {} })?.interaction).toBe('pan')
    expect(cam.movement.input.resolveInteraction('pointer', { button: 0, modifiers: { ctrl: true } })?.interaction).toBe('pan')
  })

  it('turns native look input around a stationary eye instead of orbiting the target', () => {
    const { cam, camera } = setup(1440, 900, false)
    camera.setPreferredProjection('perspective')
    camera.apply({ target: [100, 200], radius: 700, heading: 30, elevation: 35, y: 20 })
    cam.inputs.attached.fixedEyeLook?.attachControl()
    cam.getViewMatrix(true)
    const eye = cam.position.clone(), heading = camera.pose.heading
    cam.movement.rotationAccumulatedPixels.set(0.6, -0.15, 0)
    cam._checkInputs()
    cam.getViewMatrix(true)
    expect(Vector3.Distance(cam.position, eye)).toBeLessThan(0.00001)
    expect(camera.pose.heading).not.toBe(heading)
    expect(camera.pose.radius).toBe(700)
    expect(cam.inertialAlphaOffset).toBe(0)
    const turned = camera.pose
    cam._checkInputs()
    expect(camera.pose).toEqual(turned)
  })

  it('can look above the horizon without translating or rolling over', () => {
    const { cam, camera } = setup(1440, 900, false)
    camera.apply({ target: [0, 0], radius: 400, heading: 0, elevation: 20 })
    cam.upperBetaLimit = Math.PI - 0.08
    cam.inputs.attached.fixedEyeLook?.attachControl()
    cam.getViewMatrix(true)
    const eye = cam.position.clone()
    cam.movement.rotationAccumulatedPixels.set(0, 4, 0)
    cam._checkInputs()
    cam.getViewMatrix(true)
    expect(Vector3.Distance(cam.position, eye)).toBeLessThan(0.00001)
    expect(camera.pose.elevation).toBeLessThan(0)
    expect(cam.beta).toBeCloseTo(Math.PI - 0.08)
  })

  it('stops look input when camera controls are detached for placement', () => {
    const { cam, camera } = setup(1440, 900, false)
    cam.inputs.attached.fixedEyeLook?.attachControl()
    cam.inputs.attached.fixedEyeLook?.detachControl()
    const before = camera.pose
    cam.movement.rotationAccumulatedPixels.set(0.3, 0.2, 0)
    cam._checkInputs()
    expect(camera.pose).toEqual(before)
  })

  it('keeps native pan and zoom translating the camera while look is eye-anchored', () => {
    const { cam, camera } = setup(1440, 900, false)
    cam.inputs.attached.fixedEyeLook.attachControl()
    cam.getViewMatrix(true)
    const before = camera.eye
    cam.movement.panAccumulatedPixels.set(5, 0, 0)
    cam._checkInputs()
    expect(Vector3.Distance(before, camera.eye)).toBeGreaterThan(1)
    cam.movement.resetPanVelocity()
    const radius = cam.radius
    cam.movement.zoomAccumulatedPixels = 10
    cam._checkInputs()
    expect(cam.radius).toBeLessThan(radius)
  })

  it('does not let agent following recenter the eye after manual looking', () => {
    const { cam, camera } = setup(1440, 900, false)
    camera.agent(0, 0, 0, 0)
    cam.inputs.attached.fixedEyeLook.attachControl()
    cam.movement.rotationAccumulatedPixels.set(0.4, 0.1, 0)
    cam._checkInputs()
    const eye = camera.eye
    camera.follow(500, 500)
    expect(camera.mode).toBe('city')
    expect(Vector3.Distance(eye, camera.eye)).toBeLessThan(0.00001)
  })

  it('bounds the actual eye after zooming toward a below-ground look target', () => {
    const { cam, camera } = setup(1440, 900, false)
    camera.apply({ target: [0, 0], radius: 2000, heading: 30, elevation: 45, y: -1000 })
    cam.radius = 45
    camera.constrainEye([-1000, -1000, 1000, 1000], () => 17)
    expect(camera.eye.y).toBeCloseTo(20)
    expect(camera.pose.heading).toBeCloseTo(30)
    expect(camera.pose.radius).toBe(45)
  })

  it('keeps the standalone renderer lab camera editable', () => {
    const { camera } = setup(1440, 900, false)
    const pose = { target: [100, 200] as [number, number], radius: 300, heading: 45, elevation: 40 }
    camera.apply(pose)
    expect(camera.pose.radius).toBe(300)
    expect(camera.pose.target).toEqual([100, 200])
    expect(camera.pose.heading).toBeCloseTo(45)
  })
})

describe('Cityscape camera', () => {
  const world = { landmarks: [], crs: { bounds_world: [-1000, -1000, 1000, 1000] } } as unknown as WorldData

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

  it('keeps the cinematic preference through city and agent camera changes', () => {
    const engine = new NullEngine(), scene = new Scene(engine)
    const camera = new WorldCamera(new ArcRotateCamera('camera', 0, 1, 1000, Vector3.Zero(), scene), world)
    camera.setPreferredProjection('perspective')
    camera.city(0)
    expect(camera.projection).toBe('perspective')
    camera.agent(20, 30, 0, 0)
    camera.city(0)
    expect(camera.projection).toBe('perspective')
    camera.setPreferredProjection('isometric')
    camera.city(0)
    expect(camera.projection).toBe('isometric')
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
