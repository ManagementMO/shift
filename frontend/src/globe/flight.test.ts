import { describe, expect, it } from 'vitest'
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { destinationPack, flightPose, geoPoint, pointGeo, orbitRadius, lockOrbit, LOCATIONS, type Orbit } from './flight'

describe('Globe entry flight', () => {
  it('puts pins on the sphere and round-trips geographic coordinates', () => {
    for (const place of LOCATIONS) {
      const p = geoPoint(place.lat, place.lon)
      expect(Math.hypot(...p)).toBeCloseTo(1)
      const geo = pointGeo(p)
      expect(geo.lat).toBeCloseTo(place.lat)
      expect(geo.lon).toBeCloseTo(place.lon)
    }
    expect(geoPoint(90, 0)[1]).toBeCloseTo(1)
    expect(geoPoint(-90, 0)[1]).toBeCloseTo(-1)
  })

  it('keeps east to the right instead of mirroring the continents', () => {
    const eye = Vector3.FromArray(geoPoint(43.65, -79.38, 3.25))
    const view = Matrix.LookAtRH(eye, Vector3.Zero(), Vector3.Up())
    const west = Vector3.TransformCoordinates(Vector3.FromArray(geoPoint(43.65, -90)), view)
    const east = Vector3.TransformCoordinates(Vector3.FromArray(geoPoint(43.65, -70)), view)
    expect(east.x).toBeGreaterThan(west.x)
  })

  it('backs away on narrow screens so the globe fits', () => {
    expect(orbitRadius(1000, 650)).toBe(3.25)
    expect(orbitRadius(390, 588)).toBeGreaterThan(4.5)
    expect(orbitRadius(0, 0)).toBe(3.25)
  })

  it('locks manual wheel and pinch zoom while leaving rotation and scripted descent available', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const camera = new ArcRotateCamera('globe', 0, 1, 3.25, Vector3.Zero(), scene)
    lockOrbit(camera, 3.25)
    expect(camera.inputs.attached.mousewheel).toBeUndefined()
    expect(camera.pinchPrecision).toBe(Infinity)
    for (const radius of [1.1, 12]) {
      camera.radius = radius
      camera._checkInputs()
      expect(camera.radius).toBe(3.25)
    }
    camera.inertialAlphaOffset = 0.1
    camera._checkInputs()
    expect(camera.alpha).not.toBe(0)
    expect(camera.radius).toBe(3.25)
    camera.lowerRadiusLimit = 1.01
    camera.radius = 1.1
    camera._checkInputs()
    expect(camera.radius).toBe(1.1)
    lockOrbit(camera, 4.6)
    expect(camera.radius).toBe(4.6)
    expect(camera.lowerRadiusLimit).toBe(camera.upperRadiusLimit)
    scene.dispose()
    engine.dispose()
  })

  it('routes every preset and arbitrary globe point to the Toronto prototype', () => {
    for (const place of [...LOCATIONS, { id: 'custom', name: 'Selected location', region: 'Globe', lat: 0, lon: 180 }]) {
      expect(destinationPack(place)).toBe('toronto')
    }
  })

  it('approaches the selected point without entering the globe or jumping at the date line', () => {
    const start: Orbit = { alpha: Math.PI - 0.01, beta: 1.1, radius: 3.2 }
    const target = { lat: 0, lon: 1 }
    let radius = start.radius
    for (let i = 0; i <= 100; i++) {
      const pose = flightPose(start, target, i / 100)
      expect(Object.values(pose).every(Number.isFinite)).toBe(true)
      expect(pose.radius).toBeGreaterThan(1)
      expect(pose.radius).toBeLessThanOrEqual(radius + 1e-8)
      expect(Math.abs(pose.alpha - start.alpha)).toBeLessThan(Math.PI)
      radius = pose.radius
    }
    expect(flightPose(start, target, 0)).toEqual(start)
    expect(flightPose(start, target, 1).radius).toBeCloseTo(1.025)
  })
})
