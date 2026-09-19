import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from './api'
import { buildIndex } from './replay'
import { useStore } from './store'
import type { CityPack, PlanWithValidation, RunBundle, ScenarioSpec, SimulationRun } from './types'
import { clock } from './world/playback'

vi.mock('./api', () => ({ api: {
  plans: vi.fn(), runs: vi.fn(), demand: vi.fn(), run: vi.fn(), bundle: vi.fn(), submitRun: vi.fn(),
} }))

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

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  clock.pause()
  clock.seek(0)
  clock.setSpeed(1)
  useStore.setState({
    ...useStore.getInitialState(), pack, scenarios: [scenario], scenarioId: scenario.scenario_id,
    runs: [run], replays: {}, playing: false, t: 0,
  })
  vi.mocked(api.plans).mockResolvedValue([])
  vi.mocked(api.runs).mockResolvedValue([run])
  vi.mocked(api.demand).mockResolvedValue({ demand_id: 'demand', seed: 1, travelers: [], synthetic: true, generation_method: 'test' })
  vi.mocked(api.run).mockResolvedValue(run)
  vi.mocked(api.bundle).mockResolvedValue(bundle)
  vi.mocked(api.submitRun).mockResolvedValue({ ...run, status: 'queued' })
})

afterEach(() => {
  clock.pause()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('opening a city replay', () => {
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
