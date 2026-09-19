import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Ray } from '@babylonjs/core/Culling/ray'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Batch } from './geometry'
import { setback } from './architecture'
import { appendMassing, type MassingBuilding } from './massing'
import { meshFromBatch } from './city'
import { buildVegetation } from './vegetation'

describe('Cityscape geometry invariants', () => {
  it('keeps towers inside their lot and refuses courtyard or concave setbacks that cross empty space', () => {
    const rectangle = [0, 0, 40, 0, 40, 30, 0, 30]
    expect(setback(rectangle, undefined, 0.8)).toEqual([4, 3, 36, 3, 36, 27, 4, 27])
    expect(rectangle).toEqual([0, 0, 40, 0, 40, 30, 0, 30])
    expect(setback(rectangle, [[10, 10, 20, 10, 20, 20, 10, 20]], 0.8)).toBeNull()
    // U-shaped lot: its vertex centroid is in the courtyard/open notch.
    expect(setback([0,0, 30,0, 30,30, 20,30, 20,10, 10,10, 10,30, 0,30], undefined, 0.8)).toBeNull()
  })

  it('preserves massing courtyards, wall height and source coordinates', () => {
    const engine = new NullEngine(), scene = new Scene(engine)
    const building: MassingBuilding = { id: 'courtyard', cat: 'office', h: 40, x: 20, z: 20, tiers: [{ y0: 0, y1: 40, ring: [0,0,40,0,40,40,0,40], holes: [[12,12,28,12,28,28,12,28]] }] }
    const original = JSON.stringify(building)
    const wall = new Batch(), roof = new Batch()
    appendMassing(building, wall, roof, [0.7,0.7,0.7])
    expect(Math.max(...wall.positions.filter((_,i) => i%3===1))).toBeCloseTo(40.3)
    for (const batch of [wall, roof]) {
      expect(batch.positions.every(Number.isFinite)).toBe(true)
      expect(batch.uvs.every(Number.isFinite)).toBe(true)
      expect(batch.uvs.length).toBe(batch.vertexCount*2)
    }
    const mesh = meshFromBatch('roof', roof, scene, new StandardMaterial('roof', scene))
    const down = (x: number, z: number) => new Ray(new Vector3(x,100,z), new Vector3(0,-1,0), 200).intersectsMesh(mesh)
    expect(down(20,20).hit).toBe(false)
    expect(down(4,4).hit).toBe(true)
    expect(JSON.stringify(building)).toBe(original)
    scene.dispose(); engine.dispose()
  })

  it('renders exactly one tree detail level per cell and releases its update observer', () => {
    const engine = new NullEngine(), scene = new Scene(engine)
    const cam = new ArcRotateCamera('camera', 0, 1, 800, Vector3.Zero(), scene)
    const before = scene.onBeforeRenderObservable.observers.length
    const meshes = buildVegetation(scene, [{x:0,z:0,scale:1,shade:0.4}, {x:1800,z:0,scale:1,shade:0.7}], new StandardMaterial('trees', scene))
    cam.getViewMatrix(true)
    scene.onBeforeRenderObservable.notifyObservers(scene)
    const visible = meshes.filter(m => m.isEnabled())
    expect(visible).toHaveLength(2)
    expect(visible.reduce((n,m) => n+m.thinInstanceCount,0)).toBe(2)
    expect(visible.find(m => m.name.includes('0:0'))!.getTotalIndices()).toBeGreaterThan(visible.find(m => m.name.includes('4:0'))!.getTotalIndices())
    meshes.forEach(m => m.dispose())
    expect(scene.onBeforeRenderObservable.observers.filter(o => !o._willBeUnregistered).length).toBe(before)
    scene.dispose(); engine.dispose()
  })
})
