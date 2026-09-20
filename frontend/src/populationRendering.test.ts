import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import { buildIndex, entitiesAt } from './replay'
import { abstractEntityId, brainColor, NEUTRAL_BRAIN_COLOR } from './population'
import { bundle, claude } from './population.testData'
import { Traffic, trafficColorAt } from './babylon/traffic'
import { WorldFrame } from './babylon/coords'
import { buildWorldLayers } from './world/layers'
import { RoadIndex } from './babylon/roadIndex'
import type { WorldRoad } from './babylon/worldData'

function layerColor(zoom: number, layerId: string, accessor: string, time = 10, data = bundle()) {
  const rx = buildIndex(data)
  const layers = buildWorldLayers({ pack: null, roads: null, scenario: null, replay: rx, t: time, zoom, selection: null, select: () => {} })
  const layer = layers.find((l) => l.id === layerId)!
  expect(layer).toBeDefined()
  const props = layer.props as unknown as Record<string, unknown>
  const getColor = props[accessor] as (entity: ReturnType<typeof entitiesAt>[number]) => number[]
  const entity = (props.data as ReturnType<typeof entitiesAt>).find((e) => e.residentId === 'r1')!
  expect(entity).toBeDefined()
  return getColor(entity).slice(0, 3)
}

describe('population render paths', () => {
  it('uses one brain-family color for Babylon instances/markers and deck near/far mobility markers', () => {
    const rx = buildIndex(bundle())
    const color = brainColor(claude)
    expect(trafficColorAt(rx, 'bike-body', 10, [0, 0, 0])).toEqual(color.map((v) => v / 255))
    expect(layerColor(16, 'bicycles', 'getColor')).toEqual(color)
    expect(layerColor(12, 'bicycles-far', 'getFillColor')).toEqual(color)
    expect(layerColor(16, 'deliveries', 'getColor', 40)).toEqual(color)
    expect(layerColor(12, 'deliveries-far', 'getFillColor', 40)).toEqual(color)
    expect(layerColor(16, 'population-abstract', 'getLineColor', 30)).toEqual(color)
    const car = bundle()
    car.tracks['van-body'].kind = 'car'
    expect(layerColor(16, 'cars', 'getColor', 40, car)).toEqual(color)
    expect(layerColor(12, 'cars-far', 'getFillColor', 40, car)).toEqual(color)
    const truck = bundle()
    truck.tracks['van-body'].kind = 'truck'
    expect(layerColor(16, 'trucks', 'getColor', 40, truck)).toEqual(color)
    expect(layerColor(12, 'trucks-far', 'getFillColor', 40, truck)).toEqual(color)
  })

  it('writes assignment colors into real Babylon thin-instance buffers at near and far LOD and after a mode change', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const frame = new WorldFrame({ utm_zone: 17, net_offset: [-626705.41, -4831652.88], origin_net: [3203.875, 2450.355], origin_lonlat: [-79.3891482, 43.6485798], bounds_world: [-3204, -2451, 3204, 2451] })
    const traffic = new Traffic(scene, frame, null)
    const data = bundle()
    data.tracks['bike-body'].kind = 'person'
    data.population!.mobility_bindings[1].mode = 'walk'
    const rx = buildIndex(data)
    const [x, z] = frame.lonLatToWorld(-79.38, 43.64)
    const near = { x, y: 20, z, radius: 100 }
    const assertBuffer = (name: string, rgb: number[]) => {
      const mesh = scene.getMeshByName(name) as Mesh
      expect(mesh.isEnabled()).toBe(true)
      expect(mesh.thinInstanceCount).toBeGreaterThan(0)
      const values = mesh.getVertexBuffer(VertexBuffer.ColorInstanceKind)!.getFloatData(1)!
      rgb.forEach((value, i) => expect(values[i]).toBeCloseTo(value / 255, 5))
    }
    try {
      traffic.setReplay(rx)
      traffic.update(10, near)
      assertBuffer('person-body', brainColor(claude))
      traffic.update(10, { ...near, radius: 5000 })
      expect(scene.getMeshByName('person-body')!.isEnabled()).toBe(false)
      assertBuffer('crowd-marker-body', brainColor(claude))
      traffic.update(30, near)
      expect(traffic.poseOf('bike-body')).toBeNull()
      expect(traffic.poseOf(abstractEntityId('r1'))).not.toBeNull()
      assertBuffer('abstract-presence-body', brainColor(claude))
      traffic.update(40, near)
      assertBuffer('delivery-body', brainColor(claude))
      traffic.update(45, near)
      assertBuffer('bus-body', NEUTRAL_BRAIN_COLOR)
    } finally {
      traffic.dispose()
      scene.dispose()
      engine.dispose()
    }
  })

  it('keeps both deck person LOD paths and selected bodies in their family color', () => {
    for (const zoom of [12, 16]) {
      const data = bundle()
      data.tracks['bike-body'].kind = 'person'
      const rx = buildIndex(data)
      const layers = buildWorldLayers({ pack: null, roads: null, scenario: null, replay: rx, t: 10, zoom, selection: { kind: 'resident', id: 'r1' }, select: () => {} })
      const layer = layers.find((l) => l.id === (zoom < 15.2 ? 'people-far' : 'people-near'))!
      const props = layer.props as unknown as Record<string, unknown>
      const color = props[zoom < 15.2 ? 'getFillColor' : 'getColor'] as (entity: ReturnType<typeof entitiesAt>[number]) => number[]
      expect(color(entitiesAt(rx, 10).find((e) => e.id === 'bike-body')!).slice(0, 3)).toEqual(brainColor(claude))
    }
  })

  it('accepts explicit bicycle/delivery/truck road permissions without aliasing to car', () => {
    const road = (id: string, mode: WorldRoad['allow'][number]): WorldRoad => ({ id, allow: [mode], shape: [0, 0, 100, 0], w: 3, type: 'road', kind: 'road', prio: 1, speed: 10, from: 'a', to: 'b' })
    const roads = [road('bike', 'bicycle'), road('van', 'delivery'), road('heavy', 'truck')]
    for (const mode of ['bicycle', 'delivery', 'truck'] as const) expect(new RoadIndex({ roads }, (r) => r.allow.includes(mode)).size).toBe(1)
    expect(new RoadIndex({ roads }, (r) => r.allow.includes('car')).size).toBe(0)
  })
})
