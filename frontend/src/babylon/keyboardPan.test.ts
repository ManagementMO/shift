import { afterEach, describe, expect, it, vi } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'

import { WorldCamera } from './camera'
import { KeyboardPan, PAN_BOOST, PAN_SPEED, panDirection } from './keyboardPan'
import type { WorldData } from './worldData'

const bounds: [number, number, number, number] = [-3000, -2000, 3000, 2000]
const world = { landmarks: [], crs: { bounds_world: bounds } } as unknown as WorldData
const engines: NullEngine[] = []

function setup(fixed = false) {
  const engine = new NullEngine()
  engines.push(engine)
  const scene = new Scene(engine)
  const cam = new ArcRotateCamera('cam', 0, 1, 1000, Vector3.Zero(), scene)
  const camera = new WorldCamera(cam, world, fixed)
  return { cam, camera, pan: new KeyboardPan(camera, bounds) }
}

/** Hold keys for `seconds` at 60 fps. */
function hold(pan: KeyboardPan, seconds: number) {
  for (let i = 0; i < seconds * 60; i++) pan.step(1 / 60)
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('pan direction', () => {
  it('moves further into the view for W and to the right for D, relative to the heading', () => {
    expect(panDirection(['KeyW'], 0)![1]).toBeCloseTo(1)
    expect(panDirection(['KeyD'], 0)![0]).toBeCloseTo(1)
    expect(panDirection(['KeyW'], 90)![0]).toBeCloseTo(1)
    expect(panDirection(['KeyD'], 90)![1]).toBeCloseTo(-1)
    expect(panDirection(['KeyA'], 180)![0]).toBeCloseTo(1)
    const diag = panDirection(['KeyW', 'KeyD'], 0)!
    expect(Math.hypot(diag[0], diag[1])).toBeCloseTo(1)
  })

  it('cancels out opposite keys and ignores keys it does not know', () => {
    expect(panDirection(['KeyW', 'KeyS'], 30)).toBeNull()
    expect(panDirection(['KeyQ', 'Space'], 30)).toBeNull()
    expect(panDirection([], 30)).toBeNull()
  })
})

describe('WASD travel', () => {
  it('slides the target across the ground at a pace set by the orbit radius, then glides to a stop', () => {
    const { camera, pan } = setup()
    camera.apply({ target: [0, 0], radius: 1000, heading: 0, elevation: 45 })
    pan.press('KeyW')
    hold(pan, 1)
    const after = camera.pose.target
    expect(after[0]).toBeCloseTo(0, 6)
    expect(after[1]).toBeGreaterThan(PAN_SPEED * 1000 * 0.7)
    expect(after[1]).toBeLessThan(PAN_SPEED * 1000)
    expect(pan.moving).toBe(true)
    pan.release()
    hold(pan, 1)
    expect(pan.moving).toBe(false)
    const rest = camera.pose.target
    hold(pan, 1)
    expect(camera.pose.target).toEqual(rest)
    expect(camera.pose.radius).toBe(1000)
    expect(camera.pose.heading).toBeCloseTo(0)
  })

  it('travels the same on-screen distance from every height and faster with the boost', () => {
    const near = setup()
    near.camera.apply({ target: [0, 0], radius: 200, heading: 90, elevation: 45 })
    near.pan.press('KeyW')
    hold(near.pan, 1)
    const far = setup()
    far.camera.apply({ target: [0, 0], radius: 2000, heading: 90, elevation: 45 })
    far.pan.press('KeyW')
    hold(far.pan, 1)
    expect(far.camera.pose.target[0] / near.camera.pose.target[0]).toBeCloseTo(10, 3)
    expect(near.camera.pose.target[1]).toBeCloseTo(0, 6)
    const boosted = setup()
    boosted.camera.apply({ target: [0, 0], radius: 200, heading: 90, elevation: 45 })
    boosted.pan.setBoost(true)
    boosted.pan.press('KeyW')
    hold(boosted.pan, 1)
    expect(boosted.camera.pose.target[0] / near.camera.pose.target[0]).toBeCloseTo(PAN_BOOST, 3)
  })

  it('takes over from a preset flight the moment a key goes down', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const { camera, pan } = setup()
    camera.flyTo({ target: [500, 500], radius: 600, heading: 20, elevation: 50 }, 1000, 'district')
    expect(camera.flying).toBe(true)
    pan.press('KeyA')
    expect(camera.flying).toBe(false)
    expect(cancelAnimationFrame).toHaveBeenCalled()
  })

  it('stops at the edge of the rendered city', () => {
    const { camera, pan } = setup()
    camera.apply({ target: [2900, 0], radius: 3000, heading: 90, elevation: 45 })
    pan.press('KeyW')
    hold(pan, 3)
    expect(camera.pose.target[0]).toBe(bounds[2])
  })

  it('raises with E and lowers with Q without rotating or zooming', () => {
    const { camera, pan } = setup()
    camera.apply({ target: [0, 0], y: 100, radius: 1000, heading: 25, elevation: 45 })
    const initial = camera.pose
    pan.press('KeyE')
    hold(pan, 1)
    expect(camera.pose.y).toBeGreaterThan(initial.y! + 500)
    expect(camera.pose.target).toEqual(initial.target)
    expect(camera.pose.radius).toBe(initial.radius)
    expect(camera.pose.heading).toBe(initial.heading)
    pan.release()
    hold(pan, 1)
    const elevated = camera.pose.y!
    pan.press('KeyQ')
    hold(pan, 1)
    expect(camera.pose.y).toBeLessThan(elevated - 500)
  })

  it('keeps the camera above the ground while descending', () => {
    const { cam, camera, pan } = setup()
    camera.apply({ target: [0, 0], y: 0, radius: 200, heading: 0, elevation: 45 })
    pan.press('KeyQ')
    hold(pan, 5)
    cam.getViewMatrix(true)
    expect(cam.position.y).toBeGreaterThanOrEqual(2)
    expect(cam.position.y).toBeLessThan(10)
  })

  it('does not move after being hidden, even if a key was held', () => {
    const { camera, pan } = setup()
    pan.press('KeyW')
    hold(pan, 0.25)
    pan.setEnabled(false)
    const before = camera.pose
    hold(pan, 1)
    expect(camera.pose).toEqual(before)
    expect(pan.moving).toBe(false)
  })

  it('does nothing for a fixed camera or while disabled', () => {
    const fixed = setup(true)
    const before = fixed.camera.pose
    fixed.pan.press('KeyW')
    hold(fixed.pan, 1)
    expect(fixed.camera.pose).toEqual(before)

    const { camera, pan } = setup()
    camera.apply({ target: [0, 0], radius: 1000, heading: 0, elevation: 45 })
    pan.setEnabled(false)
    pan.press('KeyW')
    hold(pan, 1)
    expect(camera.pose.target).toEqual([0, 0])
    pan.setEnabled(true)
    pan.press('KeyW')
    hold(pan, 1)
    expect(camera.pose.target[1]).toBeGreaterThan(0)
    pan.setEnabled(false)
    expect(pan.moving).toBe(false)
    hold(pan, 1)
    expect(pan.moving).toBe(false)
  })
})
