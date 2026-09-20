import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from './api'
import { buildIndex } from './replay'
import { useStore } from './store'
import type { CityPack, Corridor, DemandSet, Health, PlanWithValidation, RunBundle, ScenarioSpec, SimulationRun, Traveler } from './types'
import { clock } from './world/playback'

const pack: CityPack = {
  pack_id: 'toronto', name: 'Toronto', version: '1', bbox: [0, 0, 1, 1], center: [0, 0],
  venue_edge_id: 'venue', venue_lonlat: [0, 0], stops: [], zones: [], limitations: [],
  real_data: false, network_fingerprint: '',
}
const scenario: ScenarioSpec = {
  scenario_id: 'scenario', pack_id: 'toronto', demand_id: 'demand', evidence_bundle_id: null,
  evidence_hash: null, restrictions: [], hazards: [], parent_scenario_id: null, change_set: [],
  label: 'Test scenario', created_at: '', constraints: {
    fleet: [], horizon_s: 120, service_window_s: [0, 120], allowed_stop_ids: [],
    objective: 'completion_by_horizon', hard_max_fleet: 2,
  },
}
const plan: PlanWithValidation = {
  plan: { plan_id: 'baseline', name: 'Baseline', family: 'none', duties: [], authored_by: 'baseline', rationale: '', assumptions: [], parent_plan_id: null },
  validation: { plan_id: 'baseline', valid: true, issues: [] },
}
const run: SimulationRun = {
  run_id: 'run', scenario_id: scenario.scenario_id, plan_id: 'plan', seed: 1, status: 'completed',
  engine_version: '', progress: 1, run_dir: '', error: null, warnings: [], metrics: null,
  manifest_hash: '', created_at: '',
}
const bundle: RunBundle = {
  run, tracks: { car: { entity_id: 'car', kind: 'car', samples: [[0, 0, 0, 0, 1], [120, 1, 1, 0, 1]], breaks: [] } },
  events: [], occupancy: {}, stopQueue: {}, compile: null,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

afterEach(() => {
  clock.pause()
  clock.seek(0)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('opening a city replay', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    clock.pause()
    clock.seek(0)
    clock.setSpeed(1)
    useStore.setState({
      ...useStore.getInitialState(), pack, scenarios: [scenario], scenarioId: scenario.scenario_id,
      runs: [run], replays: {}, playing: false, t: 0,
    }, true)
    vi.spyOn(api, 'plans').mockResolvedValue([])
    vi.spyOn(api, 'runs').mockResolvedValue([run])
    vi.spyOn(api, 'demand').mockResolvedValue({ demand_id: 'demand', seed: 1, travelers: [], synthetic: true, generation_method: 'test' })
    vi.spyOn(api, 'run').mockResolvedValue(run)
    vi.spyOn(api, 'bundle').mockResolvedValue(bundle)
    vi.spyOn(api, 'submitRun').mockResolvedValue({ ...run, status: 'queued' })
  })

  it('starts the completed replay when selecting a scenario', async () => {
    await useStore.getState().selectScenario(scenario.scenario_id)
    expect(useStore.getState().primaryRunId).toBe(run.run_id)
    expect(clock.playing).toBe(true)
    expect(clock.t).toBe(0)
  })

  it('waits for a completed replay instead of playing an empty city', async () => {
    clock.play()
    vi.mocked(api.runs).mockResolvedValueOnce([])
    await useStore.getState().selectScenario(scenario.scenario_id)
    expect(useStore.getState().primaryRunId).toBeNull()
    expect(clock.playing).toBe(false)
  })

  it('prepares a default run for a fresh scenario and plays it when ready', async () => {
    vi.mocked(api.plans).mockResolvedValueOnce([plan])
    vi.mocked(api.runs).mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...run, status: 'queued' }])
    await useStore.getState().selectScenario(scenario.scenario_id)
    expect(api.submitRun).toHaveBeenCalledExactlyOnceWith(scenario.scenario_id, 'baseline', 1)
    expect(clock.playing).toBe(false)
    await useStore.getState().refreshRuns()
    expect(clock.playing).toBe(true)
  })

  it.each(['queued', 'running', 'failed', 'canceled'] as const)('does not automatically resubmit a %s run', async (status) => {
    vi.mocked(api.plans).mockResolvedValueOnce([plan])
    vi.mocked(api.runs).mockResolvedValueOnce([{ ...run, status }])
    await useStore.getState().selectScenario(scenario.scenario_id)
    expect(api.submitRun).not.toHaveBeenCalled()
    expect(clock.playing).toBe(false)
  })

  it('does not submit an invalid default plan', async () => {
    vi.mocked(api.plans).mockResolvedValueOnce([{ ...plan, validation: { plan_id: 'baseline', valid: false, issues: [] } }])
    vi.mocked(api.runs).mockResolvedValueOnce([])
    await useStore.getState().selectScenario(scenario.scenario_id)
    expect(api.submitRun).not.toHaveBeenCalled()
  })

  it('automatically plays a loaded replay from the start at 1x', async () => {
    clock.seek(60)
    await useStore.getState().openRun(run.run_id)
    expect(useStore.getState().primaryRunId).toBe(run.run_id)
    expect(useStore.getState().playing).toBe(true)
    expect(clock.playing).toBe(true)
    expect(clock.t).toBe(0)
    expect(clock.speed).toBe(1)
    expect(clock.horizon).toBe(120)
  })

  it('opens a replay at recorded activity instead of waiting through an empty intro', async () => {
    vi.mocked(api.bundle).mockResolvedValueOnce({
      ...bundle,
      tracks: { car: { ...bundle.tracks.car, samples: [[60, 0, 0, 90, 4], [61, 0.001, 0, 90, 4]] } },
    })
    await useStore.getState().openRun(run.run_id)
    expect(clock.playing).toBe(true)
    expect(clock.speed).toBe(1)
    expect(clock.t).toBe(60)
    expect(useStore.getState().t).toBe(60)
    clock.pause()
    clock.seek(0)
    expect(clock.t).toBe(0)
  })

  it('starts cached replays without fetching again', async () => {
    useStore.setState({ replays: { [run.run_id]: buildIndex(bundle) } })
    await useStore.getState().openRun(run.run_id)
    expect(api.bundle).not.toHaveBeenCalled()
    expect(clock.playing).toBe(true)
    expect(clock.horizon).toBe(120)
  })

  it('does not resume or rewind the current replay after an explicit pause', async () => {
    await useStore.getState().openRun(run.run_id)
    clock.pause()
    clock.seek(30)
    await useStore.getState().openRun(run.run_id)
    expect(clock.playing).toBe(false)
    expect(clock.t).toBe(30)
  })

  it('does not play when the replay cannot load', async () => {
    vi.mocked(api.bundle).mockRejectedValueOnce(new Error('Replay unavailable'))
    await useStore.getState().openRun(run.run_id)
    expect(clock.playing).toBe(false)
    expect(useStore.getState().primaryRunId).toBeNull()
    expect(useStore.getState().loadingReplay).toBeNull()
    expect(useStore.getState().error).toContain('Replay unavailable')
  })

  it('does not activate a replay that finishes loading after the scenario changes', async () => {
    let resolve!: (value: RunBundle) => void
    vi.mocked(api.bundle).mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const opening = useStore.getState().openRun(run.run_id)
    useStore.setState({ scenarioId: 'other' })
    resolve(bundle)
    await opening
    expect(useStore.getState().primaryRunId).toBeNull()
    expect(clock.playing).toBe(false)
  })

  it('does not restart the old replay after switching to a fresh district', async () => {
    const loading = deferred<RunBundle>()
    vi.mocked(api.bundle).mockReturnValueOnce(loading.promise)
    vi.spyOn(api, 'pack').mockResolvedValue({ ...pack, pack_id: 'waterloo_e7' })
    vi.spyOn(api, 'roads').mockResolvedValue({ type: 'FeatureCollection', features: [] })
    const opening = useStore.getState().openRun(run.run_id)
    await useStore.getState().selectPack('waterloo_e7')
    loading.resolve(bundle)
    await opening
    expect(useStore.getState().pack?.pack_id).toBe('waterloo_e7')
    expect(useStore.getState().primaryRunId).toBeNull()
    expect(clock.playing).toBe(false)
  })

  it('automatically opens the first completed run discovered by polling', async () => {
    await useStore.getState().refreshRuns()
    expect(useStore.getState().primaryRunId).toBe(run.run_id)
    expect(clock.playing).toBe(true)
  })

  it('does not override pause when polling an already open run', async () => {
    await useStore.getState().openRun(run.run_id)
    clock.pause()
    await useStore.getState().refreshRuns()
    expect(clock.playing).toBe(false)
  })
})

describe('District selection', () => {
  const scenario = (pack_id: string, scenario_id: string): ScenarioSpec => ({
    pack_id, scenario_id, constraints: { horizon_s: 2700 },
  }) as ScenarioSpec

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
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
    vi.spyOn(api, 'corridors').mockImplementation(async (pack_id): Promise<Record<string, Corridor>> => (pack_id === 'toronto' ? { front_west: { label: 'Front St W', edge_ids: ['e1'] } } : {}))
    vi.spyOn(api, 'plans').mockResolvedValue([])
    vi.spyOn(api, 'runs').mockResolvedValue([])
    vi.spyOn(api, 'demand').mockResolvedValue({ travelers: [] } as unknown as DemandSet)
    vi.spyOn(api, 'createFlagship').mockRejectedValue(new Error('Unexpected scenario creation'))
  })

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
    expect(api.createFlagship).not.toHaveBeenCalled()
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

  it('loads the named corridors with the city and keeps the city usable without them', async () => {
    await useStore.getState().boot('toronto')
    expect(Object.keys(useStore.getState().corridors)).toEqual(['front_west'])
    vi.mocked(api.corridors).mockRejectedValueOnce(new Error('no corridors.json'))
    await useStore.getState().selectPack('waterloo_e7')
    expect(useStore.getState().pack?.pack_id).toBe('waterloo_e7')
    expect(useStore.getState().corridors).toEqual({})
    expect(useStore.getState().error).toBeNull()
  })

  it('keeps the scenario chosen from the globe when a slower earlier selection finishes later', async () => {
    vi.mocked(api.scenarios).mockResolvedValue([scenario('toronto', 'boot-default'), scenario('toronto', 'chosen-from-globe')])
    useStore.setState({ pack: { pack_id: 'toronto' } as CityPack, scenarios: [scenario('toronto', 'boot-default'), scenario('toronto', 'chosen-from-globe')] })
    const slow = deferred<[]>()
    vi.mocked(api.plans).mockImplementationOnce(() => slow.promise as Promise<never>)
    vi.mocked(api.runs).mockImplementation(async (sid) => sid === 'boot-default' ? [{ run_id: 'stale', scenario_id: 'boot-default', status: 'completed' }] as never : [])
    const stale = useStore.getState().selectScenario('boot-default')
    await useStore.getState().selectScenario('chosen-from-globe')
    slow.resolve([])
    await stale
    const state = useStore.getState()
    expect(state.scenarioId).toBe('chosen-from-globe')
    expect(state.runs).toEqual([])
    expect(state.primaryRunId).toBeNull()
  })

  it('clears the previous city replay and selection when switching to a fresh district', async () => {
    useStore.setState({
      pack: { pack_id: 'toronto' } as CityPack,
      scenarioId: 'toronto-run', primaryRunId: 'old-run',
      travelers: { old: { person_id: 'old' } as Traveler }, selection: { kind: 'person', id: 'old' }, cameraMode: 'agent', picking: true,
    })
    clock.seek(120)
    await useStore.getState().selectPack('waterloo_e7')
    const state = useStore.getState()
    expect(state.pack?.pack_id).toBe('waterloo_e7')
    expect(state.scenarioId).toBeNull()
    expect(state.primaryRunId).toBeNull()
    expect(state).not.toHaveProperty('compareRunId')
    expect(state).not.toHaveProperty('compareMode')
    expect(state.cameraMode).toBe('city')
    expect(state.picking).toBe(false)
    expect(state.travelers).toEqual({})
    expect(state.selection).toBeNull()
    expect(clock.t).toBe(0)
    expect(api.createFlagship).not.toHaveBeenCalled()
  })
})
