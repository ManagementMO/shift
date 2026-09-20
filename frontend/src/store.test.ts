import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from './store'
import { bundle, populationArtifact, populationStatus, run } from './population.testData'
import { clock } from './world/playback'
import { residentViewAt } from './population'
import { buildIndex } from './replay'
import { shouldPollRuns } from './populationLifecycle'
import type { CityPack, RunStatus, ScenarioSpec } from './types'

const initial = useStore.getState()

it('keeps live selections independent of a cached resident recording after returning to the street', () => {
  useStore.setState({ populationActive: false, primaryRunId: 'pop-run', replays: { 'pop-run': buildIndex(bundle()) }, tool: null })
  clock.seek(10)
  useStore.getState().select({ kind: 'bicycle', id: 'bike-body' })
  expect(useStore.getState().selection).toEqual({ kind: 'bicycle', id: 'bike-body' })
  useStore.setState({ populationActive: true })
  useStore.getState().select({ kind: 'bicycle', id: 'bike-body' })
  expect(useStore.getState().selection).toEqual({ kind: 'resident', id: 'r1' })
  expect(useStore.getState().tool).toBeNull()
})
const pack: CityPack = { pack_id: 'toronto', name: 'Toronto', version: '1', bbox: [-80, 43, -79, 44], center: [-79.38, 43.64], venue_edge_id: 'venue', venue_lonlat: [-79.38, 43.64], stops: [], zones: [], limitations: [], real_data: true, network_fingerprint: 'net' }
const scenario = (population = true): ScenarioSpec => ({ scenario_id: 'scenario', pack_id: 'toronto', demand_id: 'demand', ...(population ? { scenario_kind: 'population', population_id: 'population' } as const : {}),
  evidence_bundle_id: null, evidence_hash: null, restrictions: [], hazards: [], constraints: { fleet: [], horizon_s: 3600, service_window_s: [0, 3600], allowed_stop_ids: [], objective: 'completion_by_horizon', hard_max_fleet: 0 },
  parent_scenario_id: null, change_set: [], label: 'Society', created_at: '2026-01-01' })

function fetchReplay(population = true) {
  const data = bundle(population ? populationArtifact() : null)
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') throw new Error(`Unexpected model/action submission: ${url}`)
    if (url === '/api/population/status') return Response.json(populationStatus())
    if (url === '/api/population/scenarios/population') return Response.json(data.population!.definition)
    if (url.startsWith('/api/runs?')) return Response.json([data.run])
    if (url.endsWith('/scenario')) return Response.json(scenario(population))
    if (url.endsWith('/cohort')) return Response.json({ cohort: [], desired_depart: {}, arrived: {} })
    if (url.endsWith('/tracks')) return Response.json(data.tracks)
    if (url.endsWith('/events')) return Response.json(data.events)
    if (url.endsWith('/occupancy') || url.endsWith('/stop_queue')) return Response.json({})
    if (url.endsWith('/compile')) return new Response('', { status: 404 })
    if (url.endsWith('/population')) return Response.json(data.population)
    if (url.endsWith('/plans')) return Response.json([])
    if (url.endsWith('/demand')) return Response.json({ travelers: [] })
    throw new Error(`Unexpected GET: ${url}`)
  })
}

function lifecycleServer(status: RunStatus = 'running') {
  let record = run({ run_kind: 'population', population_id: 'population', status, progress: 0.1, manifest_hash: 'checkpoint-0' })
  let artifact = populationArtifact()
  let rejectResume = false
  let wrongIdentity = false
  let hold: Promise<void> | null = null
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/population/status') return Response.json(populationStatus())
    if (url === '/api/population/scenarios/population') return Response.json(artifact.definition)
    if (url.endsWith('/pause') && init?.method === 'POST') return Response.json({ requested: true, run_id: record.run_id })
    if (url.endsWith('/resume') && init?.method === 'POST') {
      if (rejectResume) return new Response('Paired checkpoint hash mismatch', { status: 409 })
      if (wrongIdentity) return Response.json({ ...record, run_id: 'wrong-run', status: 'queued' })
      record = { ...record, status: 'queued' }
      return Response.json(record)
    }
    if (url.endsWith('/cancel') && init?.method === 'POST') {
      record = { ...record, status: 'canceled' }
      return Response.json({ canceled: true })
    }
    if (init?.method === 'POST') throw new Error(`Unexpected action: ${url}`)
    if (url.startsWith('/api/runs?') || url === '/api/runs/pop-run') return Response.json(url.includes('?') ? [record] : record)
    if (url.endsWith('/population')) {
      const body = JSON.stringify(artifact)
      if (hold) await hold
      return new Response(body, { headers: { 'content-type': 'application/json' } })
    }
    if (url.endsWith('/tracks')) return Response.json(bundle().tracks)
    if (url.endsWith('/events')) return Response.json([])
    if (url.endsWith('/compile')) return new Response('', { status: 404 })
    if (url.endsWith('/occupancy') || url.endsWith('/stop_queue')) return Response.json({})
    throw new Error(`Unexpected GET: ${url}`)
  })
  const data = bundle(artifact)
  data.run = record
  const cached = buildIndex(data)
  useStore.setState({ populationActive: true, scenarioId: 'scenario', populationDefinition: artifact.definition, runs: [record], replays: { [record.run_id]: cached }, primaryRunId: record.run_id, selection: { kind: 'resident', id: 'r1' } })
  clock.setHorizon(60)
  clock.seek(12)
  vi.stubGlobal('fetch', fetcher)
  return {
    fetcher, cached,
    reject: () => { rejectResume = true },
    wrongRun: () => { wrongIdentity = true },
    holdArtifacts: (promise: Promise<void> | null) => { hold = promise },
    record: (next: RunStatus, end = 90) => {
      record = { ...record, status: next, progress: end / 3600, manifest_hash: `checkpoint-${end}` }
      artifact = { ...populationArtifact(), metrics: { ...populationArtifact().metrics, end_time_s: end } }
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  useStore.setState({ ...initial, pack, scenarios: [scenario()], populationStatus: populationStatus() }, true)
  clock.pause()
  clock.seek(0)
})

afterEach(() => {
  clock.pause()
  vi.unstubAllGlobals()
})

describe('population store boundaries', () => {
  it('selects a definition, opens a replay and scrubs/selects without any POST or transit compiler calls', async () => {
    const fetcher = fetchReplay()
    vi.stubGlobal('fetch', fetcher)
    await useStore.getState().selectScenario('scenario')
    expect(useStore.getState().primaryRunId).toBe('pop-run')
    expect(useStore.getState().populationDefinition?.population_id).toBe('population')
    expect(useStore.getState().plans).toEqual([])
    const getCount = fetcher.mock.calls.length
    clock.seek(10)
    useStore.getState().select({ kind: 'bicycle', id: 'bike-body' })
    expect(useStore.getState().selection).toEqual({ kind: 'resident', id: 'r1' })
    clock.seek(40)
    expect(useStore.getState().selection).toEqual({ kind: 'resident', id: 'r1' })
    clock.play()
    clock.seek(30)
    const rx = useStore.getState().replays['pop-run']
    expect(residentViewAt(rx.population!, 'r1', clock.t)?.decision?.source).toBe('jiuwenswarm')
    expect(fetcher.mock.calls).toHaveLength(getCount)
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
    expect(fetcher.mock.calls.some(([url]) => /\/plans$|\/demand$/.test(String(url)))).toBe(false)
  })

  it('retains the legacy plans/demand path without requesting a population artifact', async () => {
    const fetcher = fetchReplay(false)
    vi.stubGlobal('fetch', fetcher)
    useStore.setState({ scenarios: [scenario(false)] })
    await useStore.getState().selectScenario('scenario')
    expect(useStore.getState().primaryRunId).toBe('pop-run')
    expect(useStore.getState().replays['pop-run'].population).toBeNull()
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/plans'))).toBe(true)
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/demand'))).toBe(true)
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/population'))).toBe(false)
  })

  it('blocks native submission when JiuwenSwarm is unavailable or the scale gate has not been raised', async () => {
    const status = { ...populationStatus(), available: false, reason: 'Native JiuwenSwarm unavailable' }
    const fetcher = vi.fn(async () => Response.json(status))
    vi.stubGlobal('fetch', fetcher)
    const definition = populationArtifact().definition
    useStore.setState({ scenarioId: 'scenario', populationDefinition: definition })
    await useStore.getState().submitPopulationRun()
    expect(useStore.getState().error).toContain('Native JiuwenSwarm unavailable')
    expect(fetcher).toHaveBeenCalledTimes(1)
    fetcher.mockImplementation(async () => Response.json(populationStatus()))
    definition.spec.count = 240
    await useStore.getState().submitPopulationRun()
    expect(useStore.getState().error).toMatch(/20 residents.*proof/)
    expect(fetcher).toHaveBeenCalledTimes(2)
    definition.spec.brains = [{ ...definition.spec.brains[0], control_mode: 'rules' }]
    await useStore.getState().submitPopulationRun()
    expect(useStore.getState().error).toContain('rules fixture')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('uses only the explicit population endpoint and reuses its idempotency key after a failed submission', async () => {
    const requests: Record<string, string>[] = []
    const queued = run({ run_kind: 'population', population_id: 'population', status: 'queued', progress: 0 })
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/population/status') return Response.json(populationStatus())
      if (url.startsWith('/api/runs?')) return Response.json([queued])
      if (url === '/api/population/runs' && init?.method === 'POST') {
        requests.push(JSON.parse(String(init.body)))
        if (requests.length === 1) throw new Error('Submission response lost')
        return Response.json(queued)
      }
      throw new Error(`Unexpected request ${url}`)
    })
    vi.stubGlobal('fetch', fetcher)
    useStore.setState({ scenarioId: 'scenario', populationDefinition: populationArtifact().definition })
    await useStore.getState().submitPopulationRun()
    expect(useStore.getState().error).toContain('Submission response lost')
    await Promise.all([useStore.getState().submitPopulationRun(), useStore.getState().submitPopulationRun()])
    expect(requests).toHaveLength(2)
    expect(requests[0]).toEqual(requests[1])
    expect(Object.keys(requests[0]).sort()).toEqual(['idempotency_key', 'population_id'])
    expect(requests[0].population_id).toBe('population')
    expect(useStore.getState().runs[0].run_kind).toBe('population')
    expect(useStore.getState().populationSubmitting).toBe(false)
  })

  it('opens a paused run after a fresh frontend load without resuming or invoking cognition', async () => {
    const server = lifecycleServer('paused')
    useStore.setState({ replays: {}, primaryRunId: null, populationDefinition: null })
    await useStore.getState().selectScenario('scenario')
    expect(useStore.getState().primaryRunId).toBe('pop-run')
    expect(useStore.getState().replays['pop-run'].bundle.run.status).toBe('paused')
    expect(shouldPollRuns(useStore.getState().runs)).toBe(false)
    expect(server.fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('waits for backend paused status after a request and refreshes the recorded boundary without resetting the resident', async () => {
    const server = lifecycleServer()
    clock.pause()
    expect(server.fetcher).not.toHaveBeenCalled()
    await useStore.getState().pausePopulationRun('pop-run')
    expect(useStore.getState().runs[0].status).toBe('running')
    expect(useStore.getState().populationActions['pop-run']).toMatchObject({ action: 'pause', phase: 'requested' })
    expect(shouldPollRuns(useStore.getState().runs)).toBe(true)
    server.record('paused')
    await useStore.getState().refreshRuns()
    expect(shouldPollRuns(useStore.getState().runs)).toBe(false)
    expect(useStore.getState().populationActions['pop-run']).toBeUndefined()
    expect(useStore.getState().replays['pop-run']).not.toBe(server.cached)
    expect(useStore.getState().replays['pop-run'].tMax).toBe(90)
    expect(useStore.getState().selection).toEqual({ kind: 'resident', id: 'r1' })
    expect(clock.t).toBe(12)
    expect(server.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => url)).toEqual(['/api/population/runs/pop-run/pause'])
  })

  it('refreshes the changed execution boundary without eagerly downloading every historical population run', async () => {
    const server = lifecycleServer('running')
    const current = useStore.getState().runs[0]
    const archived = { ...current, run_id: 'archived-population', status: 'completed' as const }
    useStore.setState({ runs: [archived, current] })
    server.record('paused')
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith('/api/runs?')) {
        const response = await server.fetcher(input, init)
        return Response.json([archived, ...(await response.json())])
      }
      return server.fetcher(input, init)
    })
    vi.stubGlobal('fetch', fetcher)
    await useStore.getState().refreshRuns()
    expect(useStore.getState().replays['pop-run'].tMax).toBe(90)
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/archived-population/'))).toBe(false)
  })

  it('resumes the same run, clears its old bundle, restarts polling and replaces the replay when records finalize', async () => {
    const server = lifecycleServer('paused')
    await useStore.getState().resumePopulationRun('pop-run')
    expect(useStore.getState().runs[0]).toMatchObject({ run_id: 'pop-run', status: 'queued' })
    expect(useStore.getState().replays['pop-run']).toBeUndefined()
    expect(useStore.getState().populationReplayDirty['pop-run']).toBe(true)
    expect(useStore.getState().primaryRunId).toBe('pop-run')
    expect(useStore.getState().selection).toEqual({ kind: 'resident', id: 'r1' })
    expect(shouldPollRuns(useStore.getState().runs)).toBe(true)
    server.record('completed', 120)
    await useStore.getState().refreshRuns()
    expect(useStore.getState().replays['pop-run'].tMax).toBe(120)
    expect(useStore.getState().populationReplayDirty['pop-run']).toBeFalsy()
    expect(useStore.getState().selection).toEqual({ kind: 'resident', id: 'r1' })
    expect(clock.horizon).toBe(120)
    expect(clock.t).toBe(12)
    expect(shouldPollRuns(useStore.getState().runs)).toBe(false)
    expect(server.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => url)).toEqual(['/api/population/runs/pop-run/resume'])
  })

  it('keeps the paused replay intact when checkpoint verification fails or resume returns another simulation identity', async () => {
    const failed = lifecycleServer('paused')
    failed.reject()
    await useStore.getState().resumePopulationRun('pop-run')
    expect(useStore.getState().runs[0].status).toBe('paused')
    expect(useStore.getState().replays['pop-run']).toBe(failed.cached)
    expect(useStore.getState().populationActions['pop-run']).toMatchObject({ action: 'resume', phase: 'error' })
    expect(useStore.getState().error).toContain('checkpoint hash mismatch')
    const wrong = lifecycleServer('paused')
    wrong.wrongRun()
    await useStore.getState().resumePopulationRun('pop-run')
    expect(useStore.getState().error).toMatch(/same|identity|different/i)
    expect(useStore.getState().replays['pop-run']).toBe(wrong.cached)
    expect(useStore.getState().runs[0].run_id).toBe('pop-run')
  })

  it('rejects a late pre-resume artifact response rather than putting stale records back in the cache', async () => {
    const server = lifecycleServer('paused')
    let release = () => {}
    server.holdArtifacts(new Promise<void>((resolve) => { release = resolve }))
    const loading = useStore.getState().openRun('pop-run', 'primary', true)
    await vi.waitFor(() => expect(server.fetcher.mock.calls.some(([url]) => String(url).endsWith('/population'))).toBe(true))
    await useStore.getState().resumePopulationRun('pop-run')
    release()
    await loading
    expect(useStore.getState().replays['pop-run']).toBeUndefined()
    expect(useStore.getState().selection).toEqual({ kind: 'resident', id: 'r1' })
    server.holdArtifacts(null)
    server.record('paused', 100)
    await useStore.getState().refreshRuns()
    expect(useStore.getState().replays['pop-run'].tMax).toBe(100)
  })

  it('retains explicit stop semantics and does not resume canceled runs or bypass the native scale gate', async () => {
    const server = lifecycleServer('running')
    await useStore.getState().cancelRun('pop-run')
    expect(useStore.getState().runs[0].status).toBe('canceled')
    await useStore.getState().resumePopulationRun('pop-run')
    expect(server.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url]) => url)).toEqual(['/api/runs/pop-run/cancel'])
    const large = lifecycleServer('paused')
    useStore.setState({ populationDefinition: { ...populationArtifact().definition, spec: { ...populationArtifact().definition.spec, count: 240 } } })
    await useStore.getState().resumePopulationRun('pop-run')
    expect(useStore.getState().error).toMatch(/20 residents.*proof/)
    expect(large.fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('prevents population scenarios from going through transport submission', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    useStore.setState({ scenarioId: 'scenario' })
    await useStore.getState().submitRun('any-plan')
    expect(fetcher).not.toHaveBeenCalled()
    expect(useStore.getState().error).toMatch(/not transit compilation/)
  })
})
