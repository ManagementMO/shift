import { describe, expect, it } from 'vitest'

import { interiorBox, pointInRing, roadDashes, treePlacements } from './details'
import type { WorldData, WorldRoad } from './worldData'

const square = (x: number, z: number, size: number) => [x, z, x + size, z, x + size, z + size, x, z + size]
const road: WorldRoad = { id: 'lane', shape: [0, 0, 100, 0], w: 3.2, type: 'highway.residential', kind: 'road', allow: ['car'], prio: 1, speed: 10, from: 'a', to: 'b' }

const park = (): Pick<WorldData, 'green' | 'buildings' | 'roads' | 'water' | 'junctions'> => ({
  green: [square(0, 0, 100)],
  buildings: [{ id: 'building', ring: square(30, 30, 30), cat: 'generic', h: 12 }],
  roads: [{ ...road, shape: [0, 15, 100, 15], lanes: [{ shape: [0, 15, 100, 15], w: 8, allow: ['car'] }] }],
  water: [{ ring: square(70, 70, 25) }],
  junctions: [{ id: 'junction', ring: square(60, 10, 12), kind: 'road', type: 'priority', x: 66, z: 16 }],
})

describe('Geometry-driven cosmetic detail', () => {
  it('keeps rooftop equipment inside footprints and outside courtyards', () => {
    const b = { ring: square(0, 0, 30), holes: [square(10, 10, 10)] }
    const box = interiorBox(b, 2)
    expect(box).not.toBeNull()
    for (let i = 0; i < box!.length; i += 2) {
      expect(pointInRing(box![i], box![i + 1], b.ring)).toBe(true)
      expect(pointInRing(box![i], box![i + 1], b.holes[0])).toBe(false)
    }
    expect(interiorBox({ ring: square(0, 0, 1) }, 2)).toBeNull()
  })

  it('creates dashes along bends with an end margin and a lateral offset', () => {
    const dashes = roadDashes([0, 0, 20, 0, 20, 20], 1.6)
    expect(dashes.length).toBeGreaterThan(2)
    expect(dashes[0][0]).toBeGreaterThanOrEqual(4)
    expect(dashes[0][1]).toBeCloseTo(1.6)
    expect(dashes.flat().every(Number.isFinite)).toBe(true)
    expect(roadDashes([0, 0, 1, 0], 0)).toEqual([])
    expect(roadDashes([], 0)).toEqual([])
  })

  it('places stable park trees without intersecting buildings, lanes, water or junctions', () => {
    const world = park()
    const trees = treePlacements(world)
    expect(trees.length).toBeGreaterThan(5)
    expect(trees).toEqual(treePlacements(world))
    for (const t of trees) {
      expect(pointInRing(t.x, t.z, world.green[0])).toBe(true)
      expect(pointInRing(t.x, t.z, world.buildings[0].ring)).toBe(false)
      expect(pointInRing(t.x, t.z, world.water[0].ring)).toBe(false)
      expect(pointInRing(t.x, t.z, world.junctions[0].ring)).toBe(false)
      expect(Math.abs(t.z - 15)).toBeGreaterThan(6)
    }
  })

  it('works at another city origin, deduplicates overlapping parks and enforces a budget', () => {
    const world = { green: [square(-17000, 24000, 150)], buildings: [], roads: [], water: [], junctions: [] }
    const trees = treePlacements(world, 20)
    expect(trees.length).toBe(20)
    expect(treePlacements({ ...world, green: [...world.green, ...world.green] }, 20)).toEqual(trees)
    expect(treePlacements({ ...world, green: [] })).toEqual([])
    expect(treePlacements(world, 0)).toEqual([])
  })
})
