import { describe, expect, it } from 'vitest'

import { buildIndex } from './replay'
import type { EntityTrack, RunBundle } from './types'

function bundle(tracks: Record<string, EntityTrack>): RunBundle {
  return {
    run: { run_id: 'run', scenario_id: 'scenario', plan_id: 'baseline', seed: 1, status: 'completed', engine_version: '', progress: 1, run_dir: '', error: null, warnings: [], metrics: null, manifest_hash: '', created_at: '' },
    tracks, events: [], occupancy: {}, stopQueue: {}, compile: null,
  }
}

function car(id: string, start: number, speed = 4): EntityTrack {
  return { entity_id: id, kind: 'car', breaks: [], samples: [[start, -79.38, 43.64, 90, speed], [start + 1, -79.37995, 43.64, 90, speed]] }
}

describe('recorded activity start', () => {
  it('keeps immediate playback when traffic is already active at zero', () => {
    expect(buildIndex(bundle({ car: car('car', 0) })).activityStart).toBe(0)
  })

  it('skips an empty intro and isolated early traffic before the main activity', () => {
    const tracks: Record<string, EntityTrack> = { early: car('early', 7) }
    for (let i = 0; i < 12; i++) tracks[`car-${i}`] = car(`car-${i}`, 248)
    const rx = buildIndex(bundle(tracks))
    expect(rx.activityStart).toBe(248)
    expect(rx.tMax).toBe(249)
    expect(rx.tracks.early.times[0]).toBe(7)
  })

  it('does not mistake stationary vehicles for activity', () => {
    const rx = buildIndex(bundle({ parked: car('parked', 0, 0), moving: car('moving', 90) }))
    expect(rx.activityStart).toBe(90)
  })

  it('keeps an empty or stationary-only replay at its beginning', () => {
    expect(buildIndex(bundle({})).activityStart).toBe(0)
    expect(buildIndex(bundle({ parked: car('parked', 0, 0) })).activityStart).toBe(0)
  })
})
