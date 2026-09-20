import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { parsePopulationArtifact } from './populationValidation'
import { populationArtifact, run } from './population.testData'

function replayFetch(populationStatus = 200, data: unknown = populationArtifact()) {
  return vi.fn(async (input: string | URL | Request) => {
    const path = String(input)
    if (path.endsWith('/population')) return new Response(JSON.stringify(data), { status: populationStatus })
    if (path.endsWith('/events')) return Response.json([])
    if (path.endsWith('/compile')) return new Response('', { status: 404 })
    return Response.json({})
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('optional population API artifacts', () => {
  it('does not request population artifacts for archived transport runs', async () => {
    const fetcher = replayFetch()
    vi.stubGlobal('fetch', fetcher)
    expect((await api.bundle(run())).population).toBeNull()
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/population'))).toBe(false)
  })

  it('loads population artifacts only for explicit population runs and tolerates 404 absence', async () => {
    vi.stubGlobal('fetch', replayFetch())
    expect((await api.bundle(run({ run_kind: 'population', population_id: 'population' }))).population?.version).toBe('population-1')
    vi.stubGlobal('fetch', replayFetch(404))
    expect((await api.bundle(run({ run_kind: 'population' }))).population).toBeNull()
  })

  it('surfaces malformed new artifacts, unexpected HTTP failures and wrong-run data', async () => {
    vi.stubGlobal('fetch', replayFetch(200, { version: 'population-1' }))
    await expect(api.bundle(run({ run_kind: 'population' }))).rejects.toThrow(/population/i)
    vi.stubGlobal('fetch', replayFetch(503))
    await expect(api.bundle(run({ run_kind: 'population' }))).rejects.toThrow(/503/)
    vi.stubGlobal('fetch', replayFetch(200, { ...populationArtifact(), run_id: 'different-run' }))
    await expect(api.bundle(run({ run_kind: 'population' }))).rejects.toThrow(/run/i)
  })

  it('posts explicit pause and same-identity resume requests without using cancel or new-run submission', async () => {
    const resumed = run({ run_kind: 'population', population_id: 'population', status: 'queued' })
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({})
      return String(input).endsWith('/pause') ? Response.json({ requested: true, run_id: 'pop-run' }) : Response.json(resumed)
    })
    vi.stubGlobal('fetch', fetcher)
    expect(await api.pausePopulationRun('pop-run')).toEqual({ requested: true, run_id: 'pop-run' })
    expect((await api.resumePopulationRun('pop-run')).run_id).toBe('pop-run')
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/population/runs/pop-run/pause', '/api/population/runs/pop-run/resume'])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Paired checkpoint hash mismatch', { status: 409 })))
    await expect(api.resumePopulationRun('pop-run')).rejects.toThrow(/409.*checkpoint hash mismatch/)
  })

  it('does not reuse browser HTTP caches for mutable population records', async () => {
    const fetcher = replayFetch()
    vi.stubGlobal('fetch', fetcher)
    await api.bundle(run({ run_kind: 'population', population_id: 'population', status: 'paused' }))
    for (const call of fetcher.mock.calls) expect((call as unknown as [string, RequestInit])[1]?.cache).toBe('no-store')
  })

  it('validates the actual nested DTO and half-open mobility data instead of accepting ad hoc state dictionaries', () => {
    expect(parsePopulationArtifact(populationArtifact()).definition.profiles[0].resident_id).toBe('r1')
    expect(() => parsePopulationArtifact({ ...populationArtifact(), states: [{ t: 10, resident_id: 'r1' }] })).toThrow(/state/)
    const artifact = populationArtifact()
    artifact.mobility_bindings[0].measured = true
    expect(() => parsePopulationArtifact(artifact)).toThrow(/stationary|abstract/)
    expect(() => parsePopulationArtifact({ ...populationArtifact(), version: 'population-2' })).toThrow(/version/)
  })

  it('validates optional swarm binding time without converting unknown legacy timing to zero', () => {
    const artifact = populationArtifact()
    expect(parsePopulationArtifact(artifact).swarm_bindings[0].bound_s).toBeUndefined()
    artifact.swarm_bindings[0].bound_s = 30
    expect(parsePopulationArtifact(artifact).swarm_bindings[0].bound_s).toBe(30)
    artifact.swarm_bindings[0].bound_s = -1
    expect(() => parsePopulationArtifact(artifact)).toThrow(/bound_s/)
  })
})
