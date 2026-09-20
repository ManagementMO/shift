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
import { Y } from './babylon/city'
import { selectionEntityId, selectionForEntity } from './selection'
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

  it('highlights and picks stationary presence at its anchor and configured ground height', () => {
    const engine = new NullEngine(), scene = new Scene(engine)
    const pathY = 2
    const traffic = new Traffic(scene, frame, null, pathY)
    const rx = buildIndex(bundle())
    const id = abstractEntityId('r1')
    const [anchorX, anchorZ] = frame.lonLatToWorld(-79.379, 43.64)
    try {
      traffic.setReplay(rx)
      traffic.setAgentScale(3)
      traffic.hoverId = id
      traffic.update(30, near)
      const presence = scene.getMeshByName('abstract-presence-body') as Mesh
      const hover = scene.getMeshByName('hover-halo-body') as Mesh
      expect(hover.isEnabled()).toBe(true)
      const matrix = presence.thinInstanceGetWorldMatrices()[0].m
      expect(matrix[0]).toBe(3)
      expect(matrix[12]).toBeCloseTo(anchorX, 3)
      expect(matrix[13]).toBe(pathY)
      expect(matrix[14]).toBeCloseTo(anchorZ, 3)
      const hit = traffic.pick(anchorX, pathY + 0.08 * 3, (x, y) => ({ x, y }), 0.01)
      expect(hit).toEqual({ id, kind: 'person' })
      expect(selectionForEntity(rx, hit!.id, hit!.kind, 30)).toEqual({ kind: 'resident', id: 'r1' })
      traffic.selectedId = id
      traffic.update(30, near)
      expect(hover.isEnabled()).toBe(false)
      expect(scene.getMeshByName('selection-halo-body')!.isEnabled()).toBe(true)
      assertBuffer(presence, brainColor(claude))
    } finally { traffic.dispose(); scene.dispose(); engine.dispose() }
  })

  it('keeps resident selection and follow poses attached across stationary, vehicle and shared-bus bindings', () => {
    const engine = new NullEngine(), scene = new Scene(engine)
    const traffic = new Traffic(scene, frame, null)
    const rx = buildIndex(bundle())
    try {
      traffic.setReplay(rx)
      for (const [time, id, kind] of [[10, 'bike-body', 'bicycle'], [30, 'abstract:r1', 'person'], [40, 'van-body', 'delivery'], [45, 'shared-bus', 'bus']] as const) {
        traffic.selectedId = selectionEntityId(rx, { kind: 'resident', id: 'r1' }, time)
        traffic.update(time, near)
        expect(traffic.selectedId).toBe(id)
        expect(traffic.poseOf(id)).toMatchObject({ kind })
        expect(scene.getMeshByName('selection-halo-body')!.isEnabled()).toBe(true)
        const pose = traffic.poseOf(id)!
        const hit = traffic.pick(pose.x, pose.z, (x, _y, z) => ({ x, y: z }), 0.01)
        expect(hit).toEqual({ id, kind })
        expect(selectionForEntity(rx, id, kind, time)).toEqual(kind === 'bus' ? { id, kind } : { id: 'r1', kind: 'resident' })
      }
      expect(traffic.poseOf('van-body')).toBeNull()
      expect(traffic.poseOf('abstract:r1')).toBeNull()
      assertBuffer(scene.getMeshByName('bus-body') as Mesh, NEUTRAL_BRAIN_COLOR)
    } finally { traffic.dispose(); scene.dispose(); engine.dispose() }
  })

  it('picks enlarged vehicle bodies at their drawn height without shifting recorded lane positions', () => {
    const engine = new NullEngine(), scene = new Scene(engine)
    const traffic = new Traffic(scene, frame, null)
    const data = bundle()
    data.tracks['van-body'].kind = 'car'
    try {
      traffic.setReplay(buildIndex(data))
      traffic.setAgentScale(3)
      traffic.update(40, { ...near, radius: 5000 })
      const car = scene.getMeshByName('car-body') as Mesh
      const matrix = car.thinInstanceGetWorldMatrices()[0].m
      const scale = matrix[5]
      expect(scale).toBeGreaterThan(3)
      const pose = traffic.poseOf('van-body')!
      expect(matrix[12]).toBeCloseTo(pose.x, 3)
      expect(matrix[14]).toBeCloseTo(pose.z, 3)
      expect(traffic.pick(pose.x, Y.road + 0.7 * scale, (x, y) => ({ x, y }), 0.01)).toEqual({ id: 'van-body', kind: 'car' })
      expect(scene.getMeshByName('car-trim')!.isEnabled()).toBe(true)
    } finally { traffic.dispose(); scene.dispose(); engine.dispose() }
  })

  it('picks distant pedestrian pins using their rendered height and keeps hovered people detailed', () => {
    const engine = new NullEngine(), scene = new Scene(engine)
    const traffic = new Traffic(scene, frame, null)
    const data = bundle()
    data.tracks['bike-body'].kind = 'person'
    try {
      traffic.setReplay(buildIndex(data))
      traffic.setAgentScale(3)
      traffic.update(10, { ...near, radius: 5000 })
      const marker = scene.getMeshByName('crowd-marker-body') as Mesh
      const scale = marker.thinInstanceGetWorldMatrices()[0].m[5]
      expect(traffic.pick(x, Y.path + 1.6 * scale, (x, y) => ({ x, y }), 0.01)).toEqual({ id: 'bike-body', kind: 'person' })
      traffic.hoverId = 'bike-body'
      traffic.update(10, { ...near, radius: 5000 })
      expect(marker.isEnabled()).toBe(false)
      expect(scene.getMeshByName('hover-halo-body')!.isEnabled()).toBe(true)
      expect(traffic.pick(x, Y.path + 0.9 * 3, (x, y) => ({ x, y }), 0.01)).toEqual({ id: 'bike-body', kind: 'person' })
    } finally { traffic.dispose(); scene.dispose(); engine.dispose() }
  })

  it('accepts explicit bicycle/delivery/truck road permissions without aliasing to car', () => {
    const road = (id: string, mode: WorldRoad['allow'][number]): WorldRoad => ({ id, allow: [mode], shape: [0, 0, 100, 0], w: 3, type: 'road', kind: 'road', prio: 1, speed: 10, from: 'a', to: 'b' })
    const roads = [road('bike', 'bicycle'), road('van', 'delivery'), road('heavy', 'truck')]
    for (const mode of ['bicycle', 'delivery', 'truck'] as const) expect(new RoadIndex({ roads }, r => r.allow.includes(mode)).size).toBe(1)
    expect(new RoadIndex({ roads }, r => r.allow.includes('car')).size).toBe(0)
  })
})
