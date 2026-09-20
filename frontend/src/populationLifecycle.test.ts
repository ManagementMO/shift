import { describe, expect, it } from 'vitest'
import { canPausePopulationRun, canResumePopulationRun, needsPopulationReplayRefresh, runIsActive, shouldPollRuns } from './populationLifecycle'
import { run } from './population.testData'
import type { RunStatus } from './types'

const populationRun = (status: RunStatus) => run({ run_kind: 'population', population_id: 'population', status })

describe('population lifecycle gates', () => {
  it('polls active execution, stops at paused, and polls again after explicit resume acknowledgement', () => {
    expect(shouldPollRuns([populationRun('running')])).toBe(true)
    expect(shouldPollRuns([populationRun('queued')])).toBe(true)
    expect(shouldPollRuns([populationRun('paused')])).toBe(false)
    expect(shouldPollRuns([populationRun('failed')])).toBe(false)
    expect(shouldPollRuns([run({ status: 'running' }), populationRun('paused')])).toBe(true)
    expect(runIsActive(populationRun('paused'))).toBe(false)
  })

  it('keeps stop, pause, and conditional checkpoint resume distinct and never offers lifecycle actions for transport', () => {
    expect(canPausePopulationRun(populationRun('running'))).toBe(true)
    expect(canPausePopulationRun(populationRun('queued'))).toBe(true)
    expect(canPausePopulationRun(populationRun('paused'))).toBe(false)
    expect(canResumePopulationRun(populationRun('paused'))).toBe(true)
    expect(canResumePopulationRun(populationRun('failed'))).toBe(true)
    expect(canResumePopulationRun(populationRun('canceled'))).toBe(false)
    expect(canResumePopulationRun(populationRun('completed'))).toBe(false)
    expect(canResumePopulationRun(populationRun('running'))).toBe(false)
    expect(canPausePopulationRun(run({ status: 'running' }))).toBe(false)
    expect(canResumePopulationRun(run({ status: 'failed' }))).toBe(false)
  })

  it('invalidates a same-ID population snapshot at recorded boundaries, not on each physical progress tick', () => {
    const paused = populationRun('paused')
    expect(needsPopulationReplayRefresh(paused, paused, false)).toBe(false)
    expect(needsPopulationReplayRefresh(paused, paused, true)).toBe(true)
    expect(needsPopulationReplayRefresh(paused, { ...paused, manifest_hash: 'new-checkpoint' }, false)).toBe(true)
    expect(needsPopulationReplayRefresh(paused, populationRun('completed'), false)).toBe(true)
    expect(needsPopulationReplayRefresh(undefined, paused, false)).toBe(true)
    expect(needsPopulationReplayRefresh(paused, populationRun('running'), true)).toBe(false)
    expect(needsPopulationReplayRefresh(undefined, run(), true)).toBe(false)
  })
})
