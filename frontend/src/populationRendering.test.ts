import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { buildIndex } from './replay'
import { abstractEntityId, brainColor, NEUTRAL_BRAIN_COLOR } from './population'
import { bundle, claude } from './population.testData'
import { Traffic, trafficColorAt } from './babylon/traffic'
import { WorldFrame } from './babylon/coords'
import { RoadIndex } from './babylon/roadIndex'
import type { WorldRoad } from './babylon/worldData'
import type { EntityTrack } from './types'

const frame = new WorldFrame({ utm_zone: 17, net_offset: [-626705.41, -4831652.88], origin_net: [3203.875, 2450.355], origin_lonlat: [-79.3891482, 43.6485798], bounds_world: [-3204, -2451, 3204, 2451] })
const [x, z] = frame.lonLatToWorld(-79.38, 43.64)
const near = { x, y: 20, z, radius: 100 }

function assertBuffer(mesh: Mesh, color: number[]) {
  expect(mesh.isEnabled()).toBe(true)
  expect(mesh.thinInstanceCount).toBeGreaterThan(0)
  const values = mesh.getVertexBuffer(VertexBuffer.ColorInstanceKind)!.getFloatData(1)!
  color.forEach((value, index) => expect(values[index]).toBeCloseTo(value / 255, 5))
}

describe('population render paths', () => {
  it.each(['bicycle', 'car', 'delivery', 'truck'] as const)('preserves recorded identity and brain color for %s bodies', kind => {
    const engine = new NullEngine(), scene = new Scene(engine)
    const traffic = new Traffic(scene, frame, null)
    const data = bundle()
    const id = kind === 'bicycle' ? 'bike-body' : 'van-body'
    const time = kind === 'bicycle' ? 10 : 40
    data.tracks[id].kind = kind
    const rx = buildIndex(data)
    try {
      expect(trafficColorAt(rx, id, time, [0, 0, 0])).toEqual(brainColor(claude).map(value => value / 255))
      traffic.setReplay(rx)
      traffic.update(time, near)
      assertBuffer(scene.getMeshByName(`${kind}-body`) as Mesh, brainColor(claude))
      expect(traffic.poseOf(id)?.kind).toBe(kind)
      traffic.update(time, { ...near, radius: 5000 })
      assertBuffer(scene.getMeshByName(`${kind}-body`) as Mesh, brainColor(claude))
    } finally { traffic.dispose(); scene.dispose(); engine.dispose() }
  })

  it('keeps walking figures, distant markers, abstract presence and shared buses truthful across time', () => {
    const engine = new NullEngine(), scene = new Scene(engine)
    const traffic = new Traffic(scene, frame, null)
    const data = bundle()
    data.tracks['bike-body'].kind = 'person'
    data.population!.mobility_bindings[1].mode = 'walk'
    try {
      traffic.setReplay(buildIndex(data))
      traffic.update(10, near)
      const figure = scene.meshes.find(mesh => mesh.name.startsWith('person-') && mesh.name.endsWith('-body') && mesh.isEnabled()) as Mesh
      assertBuffer(figure, brainColor(claude))
      traffic.update(10, { ...near, radius: 5000 })
      expect(figure.isEnabled()).toBe(false)
      assertBuffer(scene.getMeshByName('crowd-marker-body') as Mesh, brainColor(claude))
      traffic.update(30, near)
      expect(traffic.poseOf('bike-body')).toBeNull()
      expect(traffic.poseOf(abstractEntityId('r1'))).not.toBeNull()
      assertBuffer(scene.getMeshByName('abstract-presence-body') as Mesh, brainColor(claude))
      traffic.update(40, near)
      assertBuffer(scene.getMeshByName('delivery-body') as Mesh, brainColor(claude))
      traffic.update(45, near)
      assertBuffer(scene.getMeshByName('bus-body') as Mesh, NEUTRAL_BRAIN_COLOR)
    } finally { traffic.dispose(); scene.dispose(); engine.dispose() }
  })

  it('switches resident and live sources without disposing or replacing static city materials', () => {
    const engine = new NullEngine(), scene = new Scene(engine)
    const building = new Mesh('preserved-city-building', scene)
    const material = new StandardMaterial('preserved-city-material', scene)
    building.material = material
    material.diffuseColor.set(0.23, 0.47, 0.61)
    const traffic = new Traffic(scene, frame, null)
    traffic.setReplay(buildIndex(bundle()))
    traffic.update(10, near)
    traffic.setLiveSource({ entity: () => ({ id: 'live-person', kind: 'person' as EntityTrack['kind'] }), releasedAt: () => 1,
      forEachAt: (_time, visit) => { visit(0, x, z, 0, 1, 1, 1, 0); return true } })
    traffic.update(10, near)
    expect(traffic.poseOf('bike-body')).toBeNull()
    expect(traffic.poseOf('live-person')).not.toBeNull()
    traffic.dispose()
    expect(building.material).toBe(material)
    expect(building.isDisposed()).toBe(false)
    expect(scene.materials).toContain(material)
    expect(material.diffuseColor.asArray()).toEqual([0.23, 0.47, 0.61])
    scene.dispose(); engine.dispose()
  })

  it('accepts explicit bicycle/delivery/truck road permissions without aliasing to car', () => {
    const road = (id: string, mode: WorldRoad['allow'][number]): WorldRoad => ({ id, allow: [mode], shape: [0, 0, 100, 0], w: 3, type: 'road', kind: 'road', prio: 1, speed: 10, from: 'a', to: 'b' })
    const roads = [road('bike', 'bicycle'), road('van', 'delivery'), road('heavy', 'truck')]
    for (const mode of ['bicycle', 'delivery', 'truck'] as const) expect(new RoadIndex({ roads }, r => r.allow.includes(mode)).size).toBe(1)
    expect(new RoadIndex({ roads }, r => r.allow.includes('car')).size).toBe(0)
  })
})
