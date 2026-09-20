import { describe, expect, it } from 'vitest'
import type { LiveSession } from '../live/types'
import { recentItems, relativeTime, sessionSummary } from './recentItems'

const session = (id: string, over: Partial<LiveSession> = {}): LiveSession =>
  ({
    session_id: id, pack_id: 'toronto', status: 'paused', available_until_s: 600, horizon_s: 3600, commands: [],
    config: { pack_id: 'toronto', seed: 7, horizon_s: 3600, initial_population: 600, fleet_size: 2, temperature_c: 20, car_share: 0.35 },
    counts: { total: 850, not_departed: 0, walking: 0, waiting: 0, riding: 0, driving: 0, arrived: 0, unroutable: 0 },
    ...over,
  }) as LiveSession

describe('Live cities on the globe', () => {
  it('summarises a city by its people, changes and progress', () => {
    expect(sessionSummary(session('a'))).toEqual({ title: '850 travelers', status: 'Paused · 10 min simulated', live: true })
    const changed = session('b', { status: 'running', commands: [{ command_id: 'c1', at_s: 10, expected_revision: 1, intervention: { kind: 'temperature', temperature_c: -10 } }] })
    expect(sessionSummary(changed)).toEqual({ title: '850 travelers · 1 change', status: 'Running · 10 min simulated', live: true })
    expect(sessionSummary(session('c', { status: 'completed', available_until_s: 3600 })).status).toBe('Finished · 60 min simulated')
  })

  it('lists newest first, keeps known cities only and drops failed SUMO runs', () => {
    const items = recentItems([session('old'), session('bad', { status: 'failed' }), session('elsewhere', { pack_id: 'nowhere' }), session('new')])
    expect(items.map((i) => i.session.session_id)).toEqual(['new', 'old'])
  })

  it('describes ages in words', () => {
    expect(relativeTime(Date.now() - 5_000)).toBe('just now')
    expect(relativeTime(Date.now() - 5 * 60_000)).toBe('5 min ago')
  })
})
