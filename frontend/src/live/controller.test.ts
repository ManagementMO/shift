import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { liveApi } from './api'
import { LiveController } from './controller'
import type { LiveCommand, LiveSession } from './types'

const ID = 'live-111111111111'
const state = (id = ID, t = 9): LiveSession => ({
  session_id: id, pack_id: 'toronto', network_fingerprint: 'fixture',
  config: { pack_id: 'toronto', seed: 7, initial_population: 0, fleet_size: 2, horizon_s: 300, temperature_c: 20, car_share: 0.35 },
  parent_session_id: null, fork_s: null, time_s: t, available_until_s: t, horizon_s: 300,
  status: 'paused', revision: 0, temperature_c: 20,
  counts: { total: 0, not_departed: 0, walking: 0, waiting: 0, riding: 0, driving: 0, arrived: 0, unroutable: 0 },
  commands: [], entity_count: 0, engine_version: 'SUMO 1.27.1', error: null,
})
function frames(end: number): ArrayBuffer {
  const result = new ArrayBuffer((end + 1) * 48)
  const view = new DataView(result)
  for (let t = 0; t <= end; t++) {
    view.setUint32(t * 48, 0x31465343, true)
    view.setUint32(t * 48 + 4, t, true)
    view.setFloat32(t * 48 + 44, 20, true)
  }
  return result
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.spyOn(liveApi, 'state').mockResolvedValue(state())
  vi.spyOn(liveApi, 'metadata').mockResolvedValue({ entities: [], routes: [], fleet: [] })
  vi.spyOn(liveApi, 'chunk').mockResolvedValue(frames(9))
  vi.spyOn(liveApi, 'pause').mockResolvedValue(state())
  vi.spyOn(liveApi, 'advance').mockResolvedValue(state())
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Live operator control', () => {
  it('keeps scrubbing responsive while SUMO acknowledges pause', async () => {
    const controller = new LiveController()
    await controller.open(ID)
    vi.mocked(liveApi.pause).mockImplementation(() => new Promise(() => {}))
    controller.beginScrub()
    await controller.seek(4)
    expect(controller.clock.t).toBe(4)
    expect(controller.getSnapshot().busy).toBeNull()
    controller.stop()
  })

  it('scrubs only measured time and does not advance SUMO while inspecting history', async () => {
    const controller = new LiveController()
    await controller.open(ID)
    await controller.seek(500)
    expect(controller.clock.t).toBe(9)
    expect(controller.clock.playing).toBe(false)
    expect(liveApi.advance).not.toHaveBeenCalled()
    controller.stop()
  })

  it('previews against the selected historical playhead without applying the command', async () => {
    vi.spyOn(liveApi, 'preview').mockResolvedValue({ title: 'Temperature', detail: 'Cold response', assumption: 'Synthetic', at_s: 4, branches_history: true, intervention: { kind: 'temperature', temperature_c: 0 } })
    const apply = vi.spyOn(liveApi, 'apply')
    const controller = new LiveController()
    await controller.open(ID)
    await controller.seek(4)
    await controller.preview({ kind: 'temperature', temperature_c: 0 })
    expect(controller.getSnapshot().draft?.at_s).toBe(4)
    const request = vi.mocked(liveApi.preview).mock.calls[0][1]
    expect(request.at_s).toBe(4)
    expect(request.expected_revision).toBe(0)
    expect(apply).not.toHaveBeenCalled()
    controller.stop()
  })

  it('applies the same confirmed command identity and opens its resulting branch', async () => {
    const childId = 'live-222222222222'
    let applied: LiveCommand | null = null
    vi.spyOn(liveApi, 'preview').mockResolvedValue({ title: 'Temperature', detail: 'Cold response', assumption: 'Synthetic', at_s: 4, branches_history: true, intervention: { kind: 'temperature', temperature_c: 0 } })
    vi.spyOn(liveApi, 'apply').mockImplementation(async (_id, command) => {
      applied = command
      return { ...state(childId, 4), parent_session_id: ID, fork_s: 4, revision: 1, temperature_c: 0, commands: [command] }
    })
    vi.mocked(liveApi.state).mockImplementation(async id => id === ID ? state() : { ...state(childId, 4), parent_session_id: ID, fork_s: 4, revision: 1, temperature_c: 0, commands: applied ? [applied] : [] })
    vi.mocked(liveApi.chunk).mockImplementation(async id => frames(id === ID ? 9 : 4))
    const controller = new LiveController()
    await controller.open(ID)
    await controller.seek(4)
    await controller.preview({ kind: 'temperature', temperature_c: 0 })
    const previewed = vi.mocked(liveApi.preview).mock.calls[0][1]
    await controller.apply()
    expect(applied).toEqual(previewed)
    expect(controller.getSnapshot().primary?.state.session_id).toBe(childId)
    expect(controller.getSnapshot().draft).toBeNull()
    expect(controller.clock.t).toBe(4)
    controller.stop()
  })
})
