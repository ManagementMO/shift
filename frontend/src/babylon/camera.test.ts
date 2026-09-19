import { afterEach, describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector'

import { WorldCamera } from './camera'
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

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose()
})

describe('fixed city camera', () => {
  it('locks the viewing angle, zoom limits, and camera inputs', () => {
    const { cam, camera } = setup()
    expect(camera.fixed).toBe(true)
    expect(camera.pose.heading).toBeCloseTo(22)
    expect(camera.pose.elevation).toBeCloseTo(52)
    expect(cam.lowerRadiusLimit).toBe(cam.upperRadiusLimit)
    expect(cam.lowerAlphaLimit).toBe(cam.upperAlphaLimit)
    expect(cam.lowerBetaLimit).toBe(cam.upperBetaLimit)
    expect(Object.keys(cam.inputs.attached)).toHaveLength(0)
  })

  it('ignores preset flights, direct moves, and entity following', () => {
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

  it('keeps the standalone renderer lab camera editable', () => {
    const { camera } = setup(1440, 900, false)
    const pose = { target: [100, 200] as [number, number], radius: 300, heading: 45, elevation: 40 }
    camera.apply(pose)
    expect(camera.pose.radius).toBe(300)
    expect(camera.pose.target).toEqual([100, 200])
    expect(camera.pose.heading).toBeCloseTo(45)
  })
})
