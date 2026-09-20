import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { WorldFrame } from './coords'
import { DEFAULT_TORNADO, dragPlacement, pickTornadoGround, placedTornado, placementDirection, placementShortcut, projectTornadoPoint, tornadoDamage, tornadoHeight, tornadoPower, tornadoRadius } from './tornadoPlacement'

const frame = new WorldFrame({ utm_zone: 17, net_offset: [0, 0], origin_net: [630000, 4830000], origin_lonlat: [-79.39, 43.65], bounds_world: [-1000, -1000, 1000, 1000] })

describe('tornado placement', () => {
  it('keeps the preset radius for clicks and measures a dragged radius in metres', () => {
    expect(dragPlacement({ x: 0, z: 0 }, { x: 3, z: 4 }, 2, 110).radius).toBe(110)
    const drag = dragPlacement({ x: 10, z: 20 }, { x: 70, z: 100 }, 60, 110)
    expect(drag.radius).toBe(100)
    expect(drag.direction).toEqual([0.6, 0.8])
    expect(tornadoRadius(-50)).toBe(30)
    expect(tornadoRadius(10000)).toBe(240)
    expect(tornadoRadius(NaN)).toBe(110)
  })

  it('rotates clockwise with R, reverses with Shift+R, and wraps without changing size', () => {
    let settings = { ...DEFAULT_TORNADO }
    settings = { ...settings, ...placementShortcut(settings, 'KeyR') }
    expect(settings.heading).toBe(135)
    expect(settings.drift).toBe(true)
    expect(settings.radius).toBe(DEFAULT_TORNADO.radius)
    settings = { ...settings, ...placementShortcut(settings, 'KeyR', true) }
    expect(settings.heading).toBe(90)
    for (let i = 0; i < 8; i++) settings = { ...settings, ...placementShortcut(settings, 'KeyR') }
    expect(settings.heading).toBe(90)
    const direction = placementDirection([1, 0], 180)
    expect(direction[0]).toBeCloseTo(0)
    expect(direction[1]).toBeCloseTo(-1)
  })

  it('casts along the preview heading even when the sizing drag points elsewhere', () => {
    const settings = { ...DEFAULT_TORNADO, heading: 180, drift: true }
    const h = placedTornado(frame, { x: 100, z: 100 }, [1, 0], settings, 0, 'rotated')
    const [x, z] = frame.lonLatToWorld(...h.waypoints[1])
    expect(x).toBeCloseTo(100, 2)
    expect(z).toBeCloseTo(-230, 2)
  })

  it('maps size, power and travel shortcuts without repurposing unrelated keys', () => {
    expect(placementShortcut(DEFAULT_TORNADO, 'BracketRight')).toEqual({ radius: 115 })
    expect(placementShortcut({ ...DEFAULT_TORNADO, radius: 30 }, 'BracketLeft')).toEqual({ radius: 30 })
    expect(placementShortcut(DEFAULT_TORNADO, 'Digit5')).toEqual({ power: 5 })
    expect(placementShortcut(DEFAULT_TORNADO, 'KeyF')).toEqual({ drift: true })
    expect(placementShortcut(DEFAULT_TORNADO, 'KeyS')).toBeNull()
  })

  it('schedules a stationary summon at the selected point and time without backend modes', () => {
    const h = placedTornado(frame, { x: 220, z: 330 }, [1, 0], DEFAULT_TORNADO, 90, 'cast-1')
    expect(h.waypoints).toHaveLength(1)
    const [x, z] = frame.lonLatToWorld(...h.waypoints[0])
    expect(x).toBeCloseTo(220, 2)
    expect(z).toBeCloseTo(330, 2)
    expect(h.start_s).toBe(92)
    expect(h.end_s).toBe(392)
    expect(h.modes).toEqual([])
    expect(h.power).toBe(3)
  })

  it('clamps a drift path to the city bounds and freezes the settings in the event', () => {
    const settings = { ...DEFAULT_TORNADO, drift: true, power: 5 }
    const h = placedTornado(frame, { x: 950, z: 100 }, [1, 0], settings, 0, 'cast-2')
    settings.power = 1
    expect(h.power).toBe(5)
    expect(h.waypoints).toHaveLength(2)
    const [x, z] = frame.lonLatToWorld(...h.waypoints[1])
    expect(x).toBeCloseTo(1000, 2)
    expect(z).toBeCloseTo(100, 2)
  })

  it('makes power change the visual damage rules, not just its label', () => {
    expect(tornadoDamage(1).maxCollapse).toBe(0)
    expect(tornadoDamage(5).maxCollapse).toBeGreaterThan(tornadoDamage(3).maxCollapse!)
    expect(tornadoDamage(5).maxCollapseHeight).toBeGreaterThan(tornadoDamage(2).maxCollapseHeight!)
    expect(tornadoHeight(110, 3)).toBeCloseTo(260)
    expect(tornadoHeight(200, 5)).toBeGreaterThan(tornadoHeight(60, 1))
    expect(tornadoPower(Infinity)).toBe(3)
    expect(tornadoPower(9)).toBe(5)
  })

  it('places the footprint under the cursor with reverse depth and projects it back', () => {
    const engine = new NullEngine()
    engine.useReverseDepthBuffer = true
    const scene = new Scene(engine)
    const camera = new ArcRotateCamera('cam', -1.9, 0.7, 600, new Vector3(220, 0.7, 330), scene)
    scene.activeCamera = camera
    scene.render()
    const x = engine.getRenderWidth() * engine.getHardwareScalingLevel() / 2
    const y = engine.getRenderHeight() * engine.getHardwareScalingLevel() / 2
    const hit = pickTornadoGround(scene, x, y)!
    expect(hit.x).toBeCloseTo(220, 1)
    expect(hit.z).toBeCloseTo(330, 1)
    const projected = projectTornadoPoint(scene, hit.x, 0.7, hit.z)
    expect(projected.x).toBeCloseTo(x, 1)
    expect(projected.y).toBeCloseTo(y, 1)
    scene.dispose()
    engine.dispose()
  })
})
