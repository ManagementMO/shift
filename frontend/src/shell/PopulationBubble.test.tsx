import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { State } from '../store'
import { buildIndex } from '../replay'
import { bundle, populationArtifact } from '../population.testData'
import AgentBubble from './AgentBubble'
import PopulationDock from './PopulationDock'

const mock = vi.hoisted(() => ({ state: {} as State }))
vi.mock('../store', () => ({ useStore: Object.assign((selector: (s: State) => unknown) => selector(mock.state), { getState: () => mock.state }) }))
vi.mock('../live/session', () => ({ useLive: () => ({ primary: null, draft: null, busy: null, error: null }), liveClosuresAt: () => [], live: {} }))

beforeEach(() => {
  mock.state = { populationActive: true, primaryRunId: 'pop-run', replays: { 'pop-run': buildIndex(bundle()) }, populationDefinition: populationArtifact().definition,
    selection: { kind: 'resident', id: 'r1' }, t: 12, cameraMode: 'city', select: vi.fn(), corridors: {}, speed: 1, playing: false } as unknown as State
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Inspection must not submit inference') }))
})
afterEach(() => vi.unstubAllGlobals())
const render = () => renderToStaticMarkup(<AgentBubble />)

describe('population selection in the current city shell', () => {
  it('opens recorded persona, actual model, summary and follow controls from a mapped resident', () => {
    const html = render()
    expect(html).toContain('Alex, recorded resident')
    expect(html).toContain('A careful local courier.')
    expect(html).toContain('I will collect the request.')
    expect(html).toContain('claude-resolved')
    expect(html).toContain('Inspect brain')
    expect(html).toContain('Follow')
    expect(html).toContain('completion is recorded separately')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('resolves an owned vehicle to its resident without reading live traffic metadata', () => {
    mock.state.selection = { kind: 'bicycle', id: 'bike-body' }
    expect(render()).toContain('Alex, recorded resident')
    mock.state.t = 40
    mock.state.selection = { kind: 'delivery', id: 'van-body' }
    expect(render()).toContain('Alex, recorded resident')
  })
  it('scrubs backwards without revealing future summaries or assigning a model to a fallback', () => {
    mock.state.t = 35
    expect(render()).toContain('Fallback: timeout')
    expect(render()).not.toContain('claude-resolved')
    mock.state.t = 11
    expect(render()).not.toContain('I will collect the request.')
    expect(render()).not.toContain('Waiting after timeout.')
  })
  it('exposes all recorded shared-bus passengers only after boarding', () => {
    mock.state.selection = { kind: 'bus', id: 'shared-bus' }
    mock.state.t = 45
    expect(render()).toContain('2 recorded residents aboard')
    expect(render()).toContain('Alex')
    expect(render()).toContain('Sam')
    mock.state.t = 44
    expect(render()).toContain('0 recorded residents aboard')
    expect(render()).not.toContain('Alex')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('labels abstract presence and initial definitions honestly', () => {
    mock.state.t = 0
    expect(render()).toContain('Abstract presence')
    expect(render()).not.toContain('Measured SUMO movement')
    mock.state.primaryRunId = null
    expect(render()).toContain('Initial definition, not executed')
  })
  it('does not substitute initial state or live stop/closure cards for a missing recorded artifact', () => {
    mock.state.replays = {}
    expect(render()).not.toContain('A careful local courier.')
    for (const kind of ['stop', 'restriction', 'development'] as const) {
      mock.state.selection = { kind, id: 'same-id' }
      expect(render()).toBe('')
    }
  })
  it('keeps street simulation selection on the live bubble despite cached resident records', () => {
    mock.state.populationActive = false
    mock.state.selection = { kind: 'car', id: 'van-body' }
    expect(render()).not.toContain('Alex')
    expect(render()).not.toContain('Recorded summary')
  })
  it('keeps recorded time scrubbing available outside the setup panel', () => {
    const html = renderToStaticMarkup(<PopulationDock />)
    expect(html).toContain('Resident history playhead')
    expect(html).toContain('aria-valuetext="00:12 of 01:00 recorded"')
    expect(html).toContain('max="60"')
  })
})
