import { describe, expect, it } from 'vitest'
import { latestRun, recentItems, relativeTime, runSummary, scenarioTitle } from './recentItems'
import { locationForPack } from './flight'
import type { ScenarioSpec, SimulationRun } from '../types'

const scenario = (id: string, pack_id: string, created_at: string, label = `Event egress (Toronto, ON (Downtown)) during the Front St W closure; two extra buses`): ScenarioSpec =>
  ({ scenario_id: id, pack_id, created_at, label }) as ScenarioSpec
const run = (scenario_id: string, status: SimulationRun['status'], created_at: string, extra: Partial<SimulationRun> = {}): SimulationRun =>
  ({ run_id: `${scenario_id}-${status}-${created_at}`, scenario_id, status, created_at, progress: 0, metrics: null, ...extra }) as SimulationRun

describe('Recent work on the globe', () => {
  it('reads scenario labels into a short title and the latest branch reason', () => {
    expect(scenarioTitle('Event egress (Toronto, ON (Downtown / Waterfront)) during the Front St W closure; two extra buses for 35 minutes'))
      .toEqual({ title: 'Event egress during the Front St W closure', branch: null })
    expect(scenarioTitle('Base · edit: close Union (auto) · edit: reopen Front St (auto)').branch).toBe('reopen Front St')
    expect(scenarioTitle('').title).toBe('Scenario')
  })

  it('prefers active runs, then the newest measured result, and summarises them honestly', () => {
    const runs = [
      run('s', 'completed', '2026-09-19T10:00:00Z', { metrics: { cohort_size: 240, completed: 194 } as SimulationRun['metrics'] }),
      run('s', 'completed', '2026-09-19T12:00:00Z', { metrics: { cohort_size: 240, completed: 201 } as SimulationRun['metrics'] }),
      run('s', 'failed', '2026-09-19T13:00:00Z'),
    ]
    expect(runSummary(latestRun(runs))).toEqual({ status: 'Measured · 201 of 240 arrived', measured: true })
    expect(runSummary(latestRun([...runs, run('s', 'running', '2026-09-19T14:00:00Z', { progress: 0.42 })]))).toEqual({ status: 'Simulating 42%', measured: false })
    expect(runSummary(null)).toEqual({ status: 'No run yet', measured: false })
    expect(runSummary(run('s', 'canceled', '2026-09-19T14:00:00Z')).status).toBe('Canceled')
  })

  it('lists only scenarios that can be entered from orbit, newest activity first', () => {
    const scenarios = [
      scenario('old', 'toronto', '2026-09-18T10:00:00Z'),
      scenario('campus', 'waterloo_e7', '2026-09-19T10:00:00Z'),
      scenario('new', 'toronto', '2026-09-19T09:00:00Z'),
    ]
    const items = recentItems(scenarios, [run('old', 'completed', '2026-09-19T11:00:00Z')])
    expect(items.map((i) => i.scenario.scenario_id)).toEqual(['old', 'new'])
    expect(items[0].location.id).toBe('toronto')
    expect(items[0].measured).toBe(true)
    expect(locationForPack('waterloo_e7')).toBeNull()
    expect(recentItems(Array.from({ length: 12 }, (_, i) => scenario(`s${i}`, 'toronto', `2026-09-0${(i % 9) + 1}T00:00:00Z`)), [])).toHaveLength(8)
  })

  it('formats relative times without negative or over-precise values', () => {
    const now = Date.parse('2026-09-19T12:00:00Z')
    expect(relativeTime(now + 5000, now)).toBe('just now')
    expect(relativeTime(now - 90_000, now)).toBe('1 min ago')
    expect(relativeTime(now - 3 * 3600_000, now)).toBe('3 h ago')
    expect(relativeTime(now - 49 * 3600_000, now)).toBe('2 d ago')
  })
})
