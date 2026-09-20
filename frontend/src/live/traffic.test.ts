import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'

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
        for (let i = 0; i < 5000; i++) visit(i, i, 20, 90, 1.3, 1, 1)
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

  it('clears old positions when the requested history is not loaded', () => {
    const engine = new NullEngine(), scene = new Scene(engine)
    const traffic = new Traffic(scene, frame, null)
    traffic.setLiveSource({
      entity: () => ({ id: 'one', kind: 'person' }), releasedAt: () => 1,
      forEachAt: (t, visit) => { if (t !== 1) return false; visit(0, 4, 5, 0, 1, 1, 1); return true },
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
