import { describe, expect, it } from 'vitest'

import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'

import { alertTint, ALERT_HOPS, buildFigure, buildHead, farBoost, FIGURE_POSES, poseFor, SWARM_SCALES } from './figures'
import { Batch } from './geometry'
import { FLAG_FRESH, FLAG_IN_ZONE } from '../live/flags'

describe('Swarm figures', () => {
  it('chooses standing, walking and running poses from measured speed and state', () => {
    expect(poseFor(0.1, 0, 0, 1)).toBe('stand')
    expect(poseFor(1.3, 0, 0, 2)).toBe('stand')
    expect(new Set([poseFor(1.3, 0, 0, 1), poseFor(1.3, 0.25, 0, 1)])).toEqual(new Set(['walkA', 'walkB']))
    expect(poseFor(3.0, 0, 0, 1).startsWith('run')).toBe(true)
    expect(poseFor(1.3, 0, 0.5, 1)).not.toBe(poseFor(1.3, 0, 0, 1))
  })

  it('builds every pose as a closed low-poly figure about 1.8 m tall with a distinct stride', () => {
    const heights = FIGURE_POSES.map(pose => {
      const b = new Batch()
      buildFigure(b, pose)
      buildHead(b, pose)
      let top = 0
      for (let i = 1; i < b.positions.length; i += 3) top = Math.max(top, b.positions[i])
      expect(b.indices.length % 3).toBe(0)
      expect(b.vertexCount).toBeGreaterThan(24)
      return top
    })
    expect(heights.every(h => h > 1.6 && h < 2.0)).toBe(true)
    const a = new Batch(), b = new Batch()
    buildFigure(a, 'walkA'); buildFigure(b, 'walkB')
    expect(a.positions).not.toEqual(b.positions)
  })

  it('tints informed agents by hop and keeps unaware agents in their state colour', () => {
    expect(alertTint(0, [0.2, 0.6, 0.5])).toEqual([0.2, 0.6, 0.5])
    expect(alertTint(1, [0.2, 0.6, 0.5])).toEqual(ALERT_HOPS[0])
    expect(alertTint(3 | FLAG_FRESH, [0.2, 0.6, 0.5])).toEqual(ALERT_HOPS[2])
    expect(alertTint(7, [0.2, 0.6, 0.5])).toEqual(ALERT_HOPS[ALERT_HOPS.length - 1])
    const exposed = alertTint(1 | FLAG_IN_ZONE, [0.2, 0.6, 0.5])
    expect(exposed[0]).toBeLessThan(ALERT_HOPS[0][0])
  })

  it('enlarges only far-away pins and vehicles as the camera climbs', () => {
    expect(farBoost(300, 'marker')).toBe(1)
    expect(farBoost(1250, 'marker')).toBeGreaterThan(2.5)
    expect(farBoost(5000, 'marker')).toBe(3.4)
    expect(farBoost(600, 'vehicle')).toBe(1)
    expect(farBoost(1400, 'vehicle')).toBe(2)
  })

  it('offers life-size through giant swarm scales', () => {
    expect(SWARM_SCALES.map(s => s.value)).toEqual([1, 1.6, 2.2, 3])
    const engine = new NullEngine(), scene = new Scene(engine)
    scene.dispose(); engine.dispose()
  })
})
