import { afterEach, describe, expect, it, vi } from 'vitest'

import { liveApi } from './api'
import { LiveChannel } from './channel'
import type { LiveMetadata, LiveSession } from './types'

const snapshot = (time_s: number, revision = 0): LiveSession => ({
  session_id: 'live-123456789abc', pack_id: 'toronto', network_fingerprint: 'fixture',
  config: { pack_id: 'toronto', seed: 7, initial_population: 1, fleet_size: 2, horizon_s: 300, temperature_c: 20, car_share: 0 },
  parent_session_id: null, fork_s: null, time_s, available_until_s: time_s, horizon_s: 300,
  status: 'paused', revision, temperature_c: 20, counts: { total: 1, walking: 1, not_departed: 0, waiting: 0, riding: 0, driving: 0, arrived: 0, unroutable: 0 },
  commands: [], entity_count: 1, engine_version: 'SUMO 1.27.1', error: null,
})
const metadata: LiveMetadata = { entities: [{ index: 0, id: 'one', person_id: 'one', kind: 'person', depart_s: 0, origin_edge: 'a', destination_edge: 'b', destination_zone_id: 'Z_FIN', walk_limit_m: 1500 }], routes: [], fleet: [] }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
afterEach(() => vi.restoreAllMocks())

describe('Live channel ownership', () => {
  it('does not replace a newer session revision with a slow earlier response', async () => {
    const old = deferred<LiveSession>()
    vi.spyOn(liveApi, 'state').mockImplementationOnce(() => old.promise).mockResolvedValueOnce(snapshot(5, 1))
    vi.spyOn(liveApi, 'metadata').mockResolvedValue(metadata)
    const channel = new LiveChannel(snapshot(0))
    const first = channel.refresh()
    await channel.refresh()
    old.resolve(snapshot(3))
    await first
    expect(channel.state.time_s).toBe(5)
    expect(channel.state.revision).toBe(1)
    expect(channel.entity(0)?.id).toBe('one')
    channel.dispose()
  })

  it('does not revive a disposed channel when a response completes', async () => {
    const pending = deferred<LiveSession>()
    vi.spyOn(liveApi, 'state').mockImplementation(() => pending.promise)
    vi.spyOn(liveApi, 'metadata').mockResolvedValue(metadata)
    const channel = new LiveChannel(snapshot(0))
    const work = channel.refresh()
    channel.dispose()
    pending.resolve(snapshot(5, 1))
    await work
    expect(channel.entity(0)).toBeUndefined()
    expect(channel.state.time_s).toBe(0)
  })
})
