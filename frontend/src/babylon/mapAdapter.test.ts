import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'

import { TORONTO_CITY } from '../world/camera'
import { BabylonSyncMap, radiusToZoom, zoomToRadius } from './mapAdapter'
import { WorldCamera } from './camera'
import type { WorldScene } from './scene'
import type { WorldData } from './worldData'

describe('Mapbox zoom ↔ orbit radius', () => {
  it('maps the Toronto city pose to the miniature-city hero scale', () => {
    const r = zoomToRadius(TORONTO_CITY.zoom, TORONTO_CITY.center[1])
    expect(r).toBeGreaterThan(1500)
    expect(r).toBeLessThan(1800)
  })
  it('halves the radius per zoom level', () => {
    const a = zoomToRadius(15, 43.65)
    const b = zoomToRadius(16, 43.65)
    expect(a / b).toBeCloseTo(2, 6)
  })
  it('round-trips through radiusToZoom', () => {
    for (const z of [12, 14.4, 15.05, 17.6]) expect(radiusToZoom(zoomToRadius(z, 43.65), 43.65)).toBeCloseTo(z, 6)
  })
  it('agent zoom lands at street scale', () => {
    const r = zoomToRadius(17.6, 43.65)
    expect(r).toBeGreaterThan(200)
    expect(r).toBeLessThan(320)
  })
})

describe('Native comparison camera synchronization', () => {
  it('preserves height and projection without drifting or emitting follower movement', () => {
    const engine = new NullEngine(), scene = new Scene(engine)
    const world = {landmarks:[],crs:{bounds_world:[-1000,-1000,1000,1000]}} as unknown as WorldData
    const cameraA = new WorldCamera(new ArcRotateCamera('a',0,1,1000,Vector3.Zero(),scene),world)
    const cameraB = new WorldCamera(new ArcRotateCamera('b',0,1,1000,Vector3.Zero(),scene),world)
    cameraA.apply({target:[482.123,-457.789],radius:270,heading:-28,elevation:26,y:3})
    cameraA.setProjection('perspective')
    const a = new BabylonSyncMap({camera:cameraA} as WorldScene)
    const b = new BabylonSyncMap({camera:cameraB} as WorldScene)
    let followerMoves = 0
    b.on('move', () => followerMoves++)
    for(let i=0;i<100;i++) { expect(b.syncFrom(a)).toBe(true); a.syncFrom(b) }
    expect(cameraB.pose.target).toEqual([482.123,-457.789])
    expect(cameraB.pose.y).toBe(3)
    expect(cameraB.pose.radius).toBe(270)
    expect(cameraB.projection).toBe('perspective')
    expect(followerMoves).toBe(0)
    b.setCameraMode('city')
    expect(cameraB.projection).toBe('isometric')
    a.dispose(); b.dispose(); scene.dispose(); engine.dispose()
  })
})
