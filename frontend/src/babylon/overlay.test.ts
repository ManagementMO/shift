import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { WorldFrame, utmForward } from './coords'
import { Overlay, type Marks } from './overlay'
import { RoadIndex } from './roadIndex'
import type { HazardTrack } from '../types'

const hazard: HazardTrack = {
  track_id: 'h', waypoints: [[-79.39, 43.64]], radius_m: 100, start_s: 100, end_s: 300,
  modes: ['passenger', 'bus'], kind: 'storm', label: 'Static hazard',
  footprint: [[[-79.391, 43.639], [-79.389, 43.639], [-79.389, 43.641], [-79.391, 43.641], [-79.391, 43.639]]],
}

const marks = (overrides: Partial<Marks> = {}): Marks => ({
  closed: [], ghost: [], focus: [], ghostStops: [], hazards: [], ghostHazard: null, sketch: null, ...overrides,
})

describe('Babylon hazard zone overlay', () => {
  let engine: NullEngine
  let scene: Scene
  let overlay: Overlay

  beforeEach(() => {
    engine = new NullEngine()
    scene = new Scene(engine)
    const frame = new WorldFrame({
      utm_zone: 17, net_offset: [0, 0], origin_net: utmForward(-79.39, 43.64, 17),
      origin_lonlat: [-79.39, 43.64], bounds_world: [-1000, -1000, 1000, 1000],
    })
    overlay = new Overlay(scene, new RoadIndex({ roads: [] }), frame)
  })

  afterEach(() => {
    overlay.dispose()
    scene.dispose()
    engine.dispose()
  })

  it('draws nothing around an applied event: the weather visual is the whole mark', () => {
    overlay.set(marks({ hazards: [hazard] }))
    expect(scene.getMeshByName('hazard-outline')).toBeNull()
    expect(scene.getMeshByName('hazard-fill')).toBeNull()
    // Hovering it still shows the bright ring so it reads as clickable.
    overlay.set(marks({ hazards: [hazard], hoverHazard: hazard }))
    const outline = scene.getMeshByName('hazard-outline')
    expect(outline?.getTotalVertices()).toBeGreaterThan(0)
    expect(outline?.getVerticesData('position')?.every(Number.isFinite)).toBe(true)
  })

  it('renders a no-op preview as a zone without inventing affected roads', () => {
    overlay.set(marks({ ghostHazard: hazard }))
    expect(scene.getMeshByName('hazard-outline')?.getTotalVertices()).toBeGreaterThan(0)
    expect(scene.getMeshByName('overlay')).toBeNull()
  })

  it('renders a meter-scaled placement guide before exact preview', () => {
    overlay.set(marks({ sketch: hazard }))
    const fill = scene.getMeshByName('hazard-fill')
    expect(fill?.getBoundingInfo().boundingBox.extendSize.x).toBeCloseTo(100, 0)
    expect(fill?.getBoundingInfo().boundingBox.extendSize.z).toBeCloseTo(100, 0)
  })

  it('draws a polygon sketch as a closed outline (corner dots only while it is still open)', () => {
    const corners: [number, number][] = [[-79.391, 43.639], [-79.389, 43.639], [-79.389, 43.641], [-79.391, 43.641]]
    overlay.set(marks({ sketch: { ...hazard, shape: 'polygon', radius_m: 0, waypoints: corners.slice(0, 2) } }))
    // Open: a two-point ribbon plus a disc at each corner.
    expect(scene.getMeshByName('hazard-outline')!.getTotalVertices()).toBe(2 * 2 + 2 * 17)
    expect(scene.getMeshByName('hazard-fill')).toBeNull()
    overlay.set(marks({ sketch: { ...hazard, shape: 'polygon', radius_m: 0, waypoints: corners } }))
    const closed = scene.getMeshByName('hazard-outline')!
    expect(closed.getVerticesData('position')?.every(Number.isFinite)).toBe(true)
    // Closed: one ribbon around the four corners and no corner discs, so the rectangle reads clean.
    expect(closed.getTotalVertices()).toBe(5 * 2)
  })

  it('outlines the hovered event or draft brightly without changing the footprint fill', () => {
    overlay.set(marks({ hazards: [hazard], hoverHazard: hazard }))
    const colors = scene.getMeshByName('hazard-outline')!.getVerticesData('color')!
    expect(colors.slice(-4)).toEqual(new Float32Array([1, 1, 1, 1]))
    overlay.set(marks({ hazards: [hazard] }))
    expect(scene.getMeshByName('hazard-outline')).toBeNull()
    overlay.set(marks({ sketch: hazard, hoverSketch: true }))
    const sketchColors = scene.getMeshByName('hazard-outline')!.getVerticesData('color')!
    expect(sketchColors.slice(-4)).toEqual(new Float32Array([1, 1, 1, 1]))
  })

  it('follows the pointer with a placement cursor: a circle for buffers, a corner and rubber band for areas', () => {
    overlay.set(marks({ cursor: { kind: 'circle', x: 10, z: -20, radius: 80 } }))
    const fill = scene.getMeshByName('hazard-fill')!
    expect(fill.getBoundingInfo().boundingBox.extendSize.x).toBeCloseTo(80, 0)
    expect(fill.getBoundingInfo().boundingBox.centerWorld.x).toBeCloseTo(10, 0)
    const outlineCircle = scene.getMeshByName('hazard-outline')!.getTotalVertices()
    overlay.set(marks({ cursor: { kind: 'circle', x: 30, z: -20, radius: 80 } }))
    expect(scene.getMeshByName('hazard-fill')!.getBoundingInfo().boundingBox.centerWorld.x).toBeCloseTo(30, 0)
    overlay.set(marks({ cursor: { kind: 'corner', x: 0, z: 0, from: null, close: null } }))
    expect(scene.getMeshByName('hazard-fill')).toBeNull()
    const dot = scene.getMeshByName('hazard-outline')!.getTotalVertices()
    expect(dot).toBeLessThan(outlineCircle)
    overlay.set(marks({ cursor: { kind: 'corner', x: 0, z: 0, from: [50, 50], close: [-50, 50] } }))
    expect(scene.getMeshByName('hazard-outline')!.getTotalVertices()).toBeGreaterThan(dot)
    // A rectangle following the pointer: filled and outlined at the given corners.
    overlay.set(marks({ cursor: { kind: 'ring', ring: [-100, -50, 100, -50, 100, 50, -100, 50] } }))
    const rect = scene.getMeshByName('hazard-fill')!.getBoundingInfo().boundingBox
    expect(rect.extendSize.x).toBeCloseTo(100, 0)
    expect(rect.extendSize.z).toBeCloseTo(50, 0)
    overlay.set(marks({ cursor: null }))
    expect(scene.meshes).toHaveLength(0)
  })

  it('reuses unchanged geometry and clears it when the hazard is removed', () => {
    overlay.set(marks({ ghostHazard: hazard }))
    const outline = scene.getMeshByName('hazard-outline')
    expect(outline).not.toBeNull()
    overlay.set(marks({ ghostHazard: hazard }))
    expect(scene.getMeshByName('hazard-outline')).toBe(outline)
    overlay.set(marks())
    expect(scene.meshes).toHaveLength(0)
  })
})
