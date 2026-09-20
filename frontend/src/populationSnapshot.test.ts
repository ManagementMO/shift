import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bundle, populationArtifact, run } from './population.testData'
import { useStore } from './store'
import { usePopulationPlayback } from './populationLifecycle'
import { clock } from './world/playback'

const initial = useStore.getState()
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  useStore.setState({ ...initial, populationActive: true, scenarioId: 'scenario', populationDefinition: populationArtifact().definition, primaryRunId: 'pop-run' }, true)
  clock.pause(); clock.setHorizon(3600); clock.setFrontier(null); clock.seek(0)
  usePopulationPlayback.getState().setFollowLive(true)
})
afterEach(() => { clock.pause(); useStore.setState(initial, true); vi.unstubAllGlobals() })

it('shows an atomic active snapshot and preserves inspection time when follow-latest is off', async () => {
  let end = 30
  const active = run({ run_kind: 'population', population_id: 'population', status: 'running', progress: 0.01 })
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    if (String(input).startsWith('/api/runs?')) return Response.json([active])
    expect(String(input)).toBe('/api/population/runs/pop-run/snapshot')
    const population = populationArtifact()
    population.metrics.end_time_s = end
    return Response.json({ ...bundle(population), run: active, tracks: {} })
  })
  vi.stubGlobal('fetch', fetcher)
  useStore.setState({ runs: [active] })
  await useStore.getState().refreshRuns()
  expect(useStore.getState().replays['pop-run'].population?.artifact?.metrics.end_time_s).toBe(30)
  expect(clock.t).toBe(30)
  usePopulationPlayback.getState().setFollowLive(false)
  clock.seek(12)
  end = 60
  await useStore.getState().refreshRuns()
  expect(clock.t).toBe(12)
  expect(useStore.getState().replays['pop-run'].tMax).toBe(60)
  expect(useStore.getState().error).toBeNull()
})

it('waits for the first publication without falling back to street traffic or reporting failure', async () => {
  const active = run({ run_kind: 'population', population_id: 'population', status: 'running' })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
  useStore.setState({ runs: [active] })
  expect(await useStore.getState().loadReplay(active)).toBeNull()
  expect(useStore.getState().populationActive).toBe(true)
  expect(useStore.getState().error).toBeNull()
})
