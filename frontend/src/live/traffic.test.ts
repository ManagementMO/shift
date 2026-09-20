import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import { Scene } from '@babylonjs/core/scene'

import { vehicleScale } from '../babylon/figures'
import { Traffic } from '../babylon/traffic'
import { WorldFrame } from '../babylon/coords'

const frame = new WorldFrame({ utm_zone: 17, net_offset: [0, 0], origin_net: [0, 0], origin_lonlat: [-79, 43], bounds_world: [-1000, -1000, 1000, 1000] })

describe('Live traffic rendering', () => {
  it('draws 5000 individually measured agents through shared instances and keeps picking identities', () => {
    const engine = new NullEngine(), scene = new Scene(engine)
    const traffic = new Traffic(scene, frame, null)
    traffic.setLiveSource({
      entity: index => ({ id: `person-${index}`, kind: 'person' }),
      releasedAt: () => 5000,
      forEachAt: (_t, visit) => {
        for (let i = 0; i < 5000; i++) visit(i, i, 20, 90, 1.3, 1, 1, 0)
        return true
      },
    })
    traffic.update(12, { x: 0, y: 600, z: 0, radius: 1250 })
    expect(traffic.stats.people).toBe(5000)
    expect(traffic.stats.released).toBe(5000)
    expect(traffic.poseOf('person-4000')).toMatchObject({ x: 4000, z: 20, kind: 'person' })
    expect(traffic.pick(4000, 20, (x, _y, z) => ({ x, y: z }), 0.1)).toEqual({ id: 'person-4000', kind: 'person' })
    expect(scene.meshes.filter(m => m.isEnabled()).length).toBeLessThan(12)
    traffic.dispose()
    expect(scene.meshes).toHaveLength(0)
    scene.dispose(); engine.dispose()
  })

  it('draws informed agents with alert colours, fresh-news rings and the chosen swarm scale', () => {
    const engine = new NullEngine(), scene = new Scene(engine)
    const traffic = new Traffic(scene, frame, null)
    traffic.setAgentScale(2.2)
    traffic.setLiveSource({
      entity: index => ({ id: `a-${index}`, kind: index === 2 ? 'car' : 'person' }),
      releasedAt: () => 3,
      forEachAt: (_t, visit) => {
        visit(0, 0, 0, 0, 1.3, 1, 1, 0)
        visit(1, 10, 0, 0, 1.3, 1, 1, 1 | 64)
        visit(2, 20, 0, 0, 12, 2, 4, 2 | 8)
        return true
      },
    })
    traffic.update(5, { x: 0, y: 200, z: 0, radius: 300 })
    expect(traffic.stats.people).toBe(2)
    expect(traffic.stats.alerted).toBe(2)
    expect(traffic.stats.fresh).toBe(1)
    const car = scene.meshes.find(m => m.name === 'car-body') as Mesh
    const matrices = car.thinInstanceGetWorldMatrices()
    expect(matrices[0].getRow(1)!.y).toBeCloseTo(vehicleScale(2.2))
    expect(vehicleScale(2.2)).toBeLessThan(2.2)
    const figure = scene.meshes.find(m => m.name.startsWith('person-') && m.isEnabled()) as Mesh
    expect(figure.thinInstanceGetWorldMatrices()[0].getRow(1)!.y).toBeCloseTo(2.2)
    expect(scene.meshes.find(m => m.name === 'alert-ring-body')!.isEnabled()).toBe(true)
    traffic.dispose(); scene.dispose(); engine.dispose()
  })

  it('clears old positions when the requested history is not loaded', () => {
    const engine = new NullEngine(), scene = new Scene(engine)
    const traffic = new Traffic(scene, frame, null)
    traffic.setLiveSource({
      entity: () => ({ id: 'one', kind: 'person' }), releasedAt: () => 1,
      forEachAt: (t, visit) => { if (t !== 1) return false; visit(0, 4, 5, 0, 1, 1, 1, 0); return true },
    })
    const view = { x: 0, y: 600, z: 0, radius: 1250 }
    traffic.update(1, view)
    expect(traffic.poseOf('one')).not.toBeNull()
    traffic.update(50, view)
    expect(traffic.poseOf('one')).toBeNull()
    expect(traffic.stats.people).toBe(0)
    traffic.dispose(); scene.dispose(); engine.dispose()
  })
})
