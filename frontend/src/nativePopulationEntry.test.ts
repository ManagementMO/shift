import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { live } from './live/session'
import { populationArtifact, populationStatus } from './population.testData'
import { defaultPopulationSpec } from './populationControls'
import { useStore } from './store'
import type { CityPack, ScenarioSpec } from './types'
import { clock } from './world/playback'

const pack: CityPack = { pack_id: 'toronto', name: 'Toronto', version: '1', bbox: [-80, 43, -79, 44], center: [-79.38, 43.64], venue_edge_id: 'venue', venue_lonlat: [-79.38, 43.64], stops: [], zones: [], limitations: [], real_data: true, network_fingerprint: 'net' }
function scenario(id: string, date = '2026-01-01'): ScenarioSpec {
  return { scenario_id: id, population_id: id, scenario_kind: 'population', pack_id: 'toronto', demand_id: 'demand', evidence_bundle_id: null, evidence_hash: null, restrictions: [], hazards: [], constraints: { fleet: [], horizon_s: 600, service_window_s: [0, 600], allowed_stop_ids: [], objective: 'completion_by_horizon', hard_max_fleet: 0 }, parent_scenario_id: null, change_set: [], label: id, created_at: date }
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() })
  useStore.setState({ ...useStore.getInitialState(), pack }, true)
  vi.spyOn(api, 'populationStatus').mockResolvedValue(populationStatus())
  vi.spyOn(api, 'scenarios').mockResolvedValue([])
  vi.spyOn(api, 'runs').mockResolvedValue([])
  vi.spyOn(api, 'populationDefinition').mockImplementation(async id => ({ ...populationArtifact().definition, population_id: id }))
  vi.spyOn(live, 'create').mockResolvedValue(undefined)
  vi.spyOn(api, 'submitPopulationRun')
})
afterEach(() => { clock.pause(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('native city entry', () => {
  it('boots the real pack into native setup without creating a street session', async () => {
    vi.spyOn(api, 'health').mockResolvedValue({ ok: true, schema_version: '1', sumo: 'SUMO', providers: { llm: { provider: 'openrouter', model: 'configured', available: true, sponsor: false }, evidence: { provider: 'none', available: false, sponsor: false }, sentry: { enabled: false }, map: { mapbox_token_present: false }, share: { r2_configured: false, mode: 'local' } } })
    vi.spyOn(api, 'packs').mockResolvedValue([{ pack_id: pack.pack_id, name: pack.name }])
    vi.spyOn(api, 'pack').mockResolvedValue(pack)
    vi.spyOn(api, 'roads').mockResolvedValue({ type: 'FeatureCollection', features: [] })
    vi.spyOn(api, 'corridors').mockResolvedValue({})
    await useStore.getState().boot('toronto')
    expect(useStore.getState()).toMatchObject({ populationActive: true, tool: 'residents', pack })
    expect(live.create).not.toHaveBeenCalled()
    expect(api.submitPopulationRun).not.toHaveBeenCalled()
  })

  it('changing cities clears the prior residents and also enters native setup', async () => {
    const otherPack = { ...pack, pack_id: 'waterloo' }
    vi.spyOn(api, 'pack').mockResolvedValue(otherPack)
    vi.spyOn(api, 'roads').mockResolvedValue({ type: 'FeatureCollection', features: [] })
    vi.spyOn(api, 'corridors').mockResolvedValue({})
    useStore.setState({ populationDefinition: populationArtifact().definition, primaryRunId: 'old-run', selection: { kind: 'resident', id: 'r1' } })
    await useStore.getState().selectPack('waterloo')
    expect(useStore.getState()).toMatchObject({ populationActive: true, tool: 'residents', pack: otherPack, populationDefinition: null, primaryRunId: null, selection: null })
    expect(live.create).not.toHaveBeenCalled()
  })

  it('opens empty native setup without creating paid runs or rule-driven street travelers', async () => {
    await useStore.getState().enterNativePopulation('toronto')
    expect(useStore.getState()).toMatchObject({ populationActive: true, tool: 'residents', scenarioId: null, primaryRunId: null, populationDefinition: null })
    expect(live.create).not.toHaveBeenCalled()
    expect(api.submitPopulationRun).not.toHaveBeenCalled()
    expect(clock.playing).toBe(false)
  })

  it('opens the newest compatible native definition while skipping newer rules fixtures', async () => {
    vi.mocked(api.scenarios).mockResolvedValue([scenario('old'), scenario('native', '2026-03-01'), scenario('rules', '2026-04-01')])
    vi.mocked(api.populationDefinition).mockImplementation(async id => {
      const definition = { ...populationArtifact().definition, population_id: id }
      if (id === 'rules') definition.spec = { ...definition.spec, brains: definition.spec.brains.map(brain => ({ ...brain, control_mode: 'rules' })) }
      return definition
    })
    await useStore.getState().enterNativePopulation('toronto')
    expect(useStore.getState().scenarioId).toBe('native')
    expect(useStore.getState().populationDefinition?.population_id).toBe('native')
    expect(localStorage.setItem).toHaveBeenCalledWith('concrete-consequences:native-population:toronto', 'native')
    expect(live.create).not.toHaveBeenCalled()
    expect(api.submitPopulationRun).not.toHaveBeenCalled()
  })

  it('restores a preferred native definition even when the execution budget is exhausted', async () => {
    vi.mocked(api.populationStatus).mockResolvedValue({ ...populationStatus(), available: false, reason: 'Budget exhausted', budget: { ...populationStatus().budget, blocked: true, remaining_microdollars: 0 } })
    vi.mocked(localStorage.getItem).mockReturnValue('old')
    vi.mocked(api.scenarios).mockResolvedValue([scenario('old'), scenario('new', '2026-05-01')])
    await useStore.getState().enterNativePopulation('toronto')
    expect(useStore.getState().scenarioId).toBe('old')
    expect(useStore.getState().populationStatus?.available).toBe(false)
    expect(live.create).not.toHaveBeenCalled()
  })

  it('creates a no-inference definition after budget exhaustion without submitting a run', async () => {
    const status = { ...populationStatus(), available: false, reason: 'Budget exhausted', budget: { ...populationStatus().budget, blocked: true, remaining_microdollars: 0 } }
    useStore.setState({ populationStatus: status })
    vi.spyOn(api, 'createPopulation').mockResolvedValue(scenario('new-definition'))
    const spec = defaultPopulationSpec(status, { modelIds: [status.models[0].model_id] })
    await useStore.getState().createPopulation(spec)
    expect(api.createPopulation).toHaveBeenCalledWith(spec)
    expect(useStore.getState().scenarioId).toBe('new-definition')
    expect(api.submitPopulationRun).not.toHaveBeenCalled()
    expect(live.create).not.toHaveBeenCalled()
  })

  it('keeps native setup active when loading fails instead of falling back to street traffic', async () => {
    vi.mocked(api.scenarios).mockRejectedValue(new Error('offline'))
    await useStore.getState().enterNativePopulation('toronto')
    expect(useStore.getState()).toMatchObject({ populationActive: true, tool: 'residents', populationDefinition: null })
    expect(useStore.getState().error).toContain('offline')
    expect(live.create).not.toHaveBeenCalled()
  })

  it('ignores an old city entry when a newer entry finishes first', async () => {
    let finish!: (items: ScenarioSpec[]) => void
    vi.mocked(api.scenarios).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const oldEntry = useStore.getState().enterNativePopulation('toronto')
    await useStore.getState().enterNativePopulation('toronto')
    finish([scenario('stale')])
    await oldEntry
    expect(useStore.getState().scenarioId).toBeNull()
    expect(api.populationDefinition).not.toHaveBeenCalled()
  })
})
