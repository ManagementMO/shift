import type { SimulationRun } from './types'

export type PopulationRunAction =
  | { action: 'pause' | 'resume' | 'stop'; phase: 'submitting' | 'requested' }
  | { action: 'pause' | 'resume' | 'stop'; phase: 'error'; message: string }

export function runIsActive(run: SimulationRun): boolean {
  return run.status === 'running' || run.status === 'queued'
}

export function shouldPollRuns(runs: SimulationRun[]): boolean {
  return runs.some(runIsActive)
}

export function canPausePopulationRun(run: SimulationRun): boolean {
  return run.run_kind === 'population' && runIsActive(run)
}

export function canResumePopulationRun(run: SimulationRun): boolean {
  return run.run_kind === 'population' && (run.status === 'paused' || run.status === 'failed')
}

export function populationReplayReady(run: SimulationRun): boolean {
  return run.run_kind === 'population' && ['paused', 'completed', 'failed', 'canceled'].includes(run.status)
}

export function populationRunRevision(run: SimulationRun): string {
  return JSON.stringify([run.run_id, run.status, run.progress, run.manifest_hash, run.population_id, run.error])
}

export function needsPopulationReplayRefresh(cached: SimulationRun | undefined, run: SimulationRun, dirty: boolean): boolean {
  return populationReplayReady(run) && (dirty || !cached || populationRunRevision(cached) !== populationRunRevision(run))
}
