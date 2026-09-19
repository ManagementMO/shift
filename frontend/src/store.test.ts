import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from './api'
import { useStore } from './store'
import { clock } from './world/playback'
import type { CityPack, DemandSet, Health, ScenarioSpec, Traveler } from './types'

const scenario = (pack_id: string, scenario_id: string): ScenarioSpec => ({
  pack_id, scenario_id, constraints: { horizon_s: 2700 },
}) as ScenarioSpec

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  useStore.setState(useStore.getInitialState(), true)
  vi.spyOn(api, 'health').mockResolvedValue({ ok: true } as Health)
  vi.spyOn(api, 'packs').mockResolvedValue([
    { pack_id: 'toronto', name: 'Toronto' },
    { pack_id: 'waterloo_e7', name: 'Waterloo · E7' },
  ])
  vi.spyOn(api, 'scenarios').mockResolvedValue([scenario('toronto', 'toronto-run')])
  vi.spyOn(api, 'pack').mockImplementation(async (pack_id) => ({ pack_id, center: [-80.5395046, 43.4729528] }) as CityPack)
  vi.spyOn(api, 'roads').mockResolvedValue({ type: 'FeatureCollection', features: [] })
  vi.spyOn(api, 'plans').mockResolvedValue([])
  vi.spyOn(api, 'runs').mockResolvedValue([])
  vi.spyOn(api, 'demand').mockResolvedValue({ travelers: [] } as unknown as DemandSet)
})

afterEach(() => {
  clock.pause()
  clock.seek(0)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('District selection', () => {
  it('ignores an earlier district response after a newer selection completes', async () => {
    const slow = deferred<CityPack>()
    vi.mocked(api.pack).mockImplementationOnce(() => slow.promise)
    const first = useStore.getState().selectPack('waterloo_e7')
    await useStore.getState().selectPack('waterloo')
    const latest = useStore.getState()
    slow.resolve({ pack_id: 'waterloo_e7', center: [-80.54, 43.47] } as CityPack)
    await first
    expect(useStore.getState().pack).toBe(latest.pack)
    expect(useStore.getState().roads).toBe(latest.roads)
    expect(useStore.getState().pack?.pack_id).toBe('waterloo')
  })

  it('cancels a pending switch when the currently displayed district is selected again', async () => {
    useStore.setState({ pack: { pack_id: 'toronto' } as CityPack })
    const slow = deferred<CityPack>()
    vi.mocked(api.pack).mockImplementationOnce(() => slow.promise)
    const first = useStore.getState().selectPack('waterloo_e7')
    await useStore.getState().selectPack('toronto')
    slow.resolve({ pack_id: 'waterloo_e7', center: [-80.54, 43.47] } as CityPack)
    await first
    expect(useStore.getState().pack?.pack_id).toBe('toronto')
  })

  it('does not surface errors from an obsolete district request', async () => {
    const slow = deferred<CityPack>()
    vi.mocked(api.pack).mockImplementationOnce(() => slow.promise)
    const first = useStore.getState().selectPack('waterloo_e7')
    await useStore.getState().selectPack('waterloo')
    slow.reject(new Error('obsolete request failed'))
    await first
    expect(useStore.getState().pack?.pack_id).toBe('waterloo')
    expect(useStore.getState().error).toBeNull()
  })

  it('does not let an unfinished boot overwrite a manual district selection', async () => {
    const slow = deferred<CityPack>()
    vi.mocked(api.pack).mockImplementationOnce(() => slow.promise)
    const boot = useStore.getState().boot()
    await vi.waitFor(() => expect(api.pack).toHaveBeenCalledWith('toronto'))
    await useStore.getState().selectPack('waterloo_e7')
    slow.resolve({ pack_id: 'toronto', center: [-79.38, 43.64] } as CityPack)
    await boot
    expect(useStore.getState().pack?.pack_id).toBe('waterloo_e7')
    expect(useStore.getState().scenarioId).toBeNull()
  })

  it('opens a requested E7 pack even when only Toronto has scenarios', async () => {
    await useStore.getState().boot('waterloo_e7')
    expect(useStore.getState().pack?.pack_id).toBe('waterloo_e7')
    expect(useStore.getState().scenarioId).toBeNull()
    expect(api.plans).not.toHaveBeenCalled()
  })

  it('opens the latest scenario belonging to the requested district', async () => {
    vi.mocked(api.scenarios).mockResolvedValue([
      scenario('waterloo_e7', 'e7-old'), scenario('toronto', 'toronto-run'), scenario('waterloo_e7', 'e7-new'),
    ])
    await useStore.getState().boot('waterloo_e7')
    expect(useStore.getState().scenarioId).toBe('e7-new')
    expect(api.pack).toHaveBeenCalledWith('waterloo_e7')
    expect(api.plans).toHaveBeenCalledWith('e7-new')
  })

  it.each([undefined, 'missing-pack'])('preserves the Toronto default for %s', async (packId) => {
    await useStore.getState().boot(packId)
    expect(useStore.getState().pack?.pack_id).toBe('toronto')
    expect(useStore.getState().scenarioId).toBe('toronto-run')
  })

  it('clears the previous city replay and selection when switching to a fresh district', async () => {
    useStore.setState({
      pack: { pack_id: 'toronto' } as CityPack,
      scenarioId: 'toronto-run', primaryRunId: 'old-run', compareRunId: 'old-compare', compareMode: true,
      travelers: { old: { person_id: 'old' } as Traveler }, selection: { kind: 'person', id: 'old' }, cameraMode: 'agent',
    })
    clock.seek(120)
    await useStore.getState().selectPack('waterloo_e7')
    const state = useStore.getState()
    expect(state.pack?.pack_id).toBe('waterloo_e7')
    expect(state.scenarioId).toBeNull()
    expect(state.primaryRunId).toBeNull()
    expect(state.compareRunId).toBeNull()
    expect(state.compareMode).toBe(false)
    expect(state.cameraMode).toBe('city')
    expect(state.travelers).toEqual({})
    expect(state.selection).toBeNull()
    expect(clock.t).toBe(0)
  })
})
