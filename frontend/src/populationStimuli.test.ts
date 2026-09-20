import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { populationArtifact, run } from './population.testData'
import { sendPopulationStimulus, stimulusFromPrompt, usePopulationStimuli } from './populationStimuli'
import { useStore } from './store'

const initial = useStore.getState()
beforeEach(() => {
  useStore.setState({ ...initial, populationActive: true, populationDefinition: populationArtifact().definition }, true)
  usePopulationStimuli.setState({ populationId: null, pending: [], notice: null, busy: false })
})
afterEach(() => { useStore.setState(initial, true); vi.unstubAllGlobals() })

it('queues an event for a new run without modifying an archived recording or starting models', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  useStore.setState({ primaryRunId: 'pop-run', runs: [run({ status: 'completed' })] })
  expect(await sendPopulationStimulus({ kind: 'announcement', text: 'Please check on your neighbours.', duration_s: 600 })).toBe(true)
  expect(fetcher).not.toHaveBeenCalled()
  expect(usePopulationStimuli.getState().pending).toHaveLength(1)
  expect(useStore.getState().runs[0].status).toBe('completed')
})

it('sends a paused native run an event without resuming cognition or touching the street simulation', async () => {
  const fetcher = vi.fn(async (_input: string | URL | Request) => Response.json({ status: 'queued' }))
  vi.stubGlobal('fetch', fetcher)
  useStore.setState({ primaryRunId: 'pop-run', runs: [run({ status: 'paused', checkpoint_available: true })] })
  expect(await sendPopulationStimulus({ kind: 'temperature', text: 'It is now 35°C.', temperature_c: 35, duration_s: 600 })).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0][0]).toBe('/api/population/runs/pop-run/stimuli')
  expect(usePopulationStimuli.getState().notice).toMatch(/Resume/)
})

it('does not claim an event reached residents when the server rejects it', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Run already completed', { status: 409 })))
  useStore.setState({ primaryRunId: 'pop-run', runs: [run({ status: 'running' })] })
  expect(await sendPopulationStimulus({ kind: 'announcement', text: 'Hello.', duration_s: 600 })).toBe(false)
  expect(usePopulationStimuli.getState().pending).toHaveLength(0)
  expect(usePopulationStimuli.getState().notice).toBeNull()
  expect(useStore.getState().error).toContain('409')
})

it('parses explicit temperatures and preserves other text as messages, without fabricating tax policy', () => {
  expect(stimulusFromPrompt('Set the temperature to 35°C')).toMatchObject({ kind: 'temperature', temperature_c: 35 })
  expect(stimulusFromPrompt('Increase temperature by 5 degrees')).toMatchObject({ kind: 'announcement' })
  expect(stimulusFromPrompt('What do you think about higher taxes?')).toMatchObject({ kind: 'announcement' })
})
