import { describe, expect, it } from 'vitest'
import { comparePopulations } from './comparison'
import { fixtureBundle, fixtureScenario, fixtureTraveler } from './development.fixtures'
import { buildIndex, cohortSummaryAt } from './replay'

describe('population-aware comparisons', () => {
  it('separates added trips and includes incumbent trips without events', () => {
    const parent = fixtureScenario()
    const child = fixtureScenario('child', 'parent')
    const incumbents = [fixtureTraveler('p1'), fixtureTraveler('not-departed')]
    const b = fixtureBundle(parent, incumbents, { p1: 400 })
    const a = fixtureBundle(child, [...incumbents, fixtureTraveler('development-trip', { development_id: 'development' })], { p1: 450, 'development-trip': 200 })
    const comparison = comparePopulations(a, b, [parent, child])!
    expect(comparison.sharedIds).toEqual(['p1', 'not-departed'])
    expect(comparison.viewOnly.size).toBe(1)
    expect(comparison.viewOnly.completed).toBe(1)
    expect(comparison.matchedView.size).toBe(2)
    expect(comparison.neither).toBe(1)
    expect(comparison.onlyView).toBe(0)
    expect(comparison.medianSavedS).toBe(-50)
    expect(comparison.samePopulation).toBe(false)
    expect(cohortSummaryAt(buildIndex(a), 0).not_departed).toBe(3)
  })

  it('does not match identical IDs in independently generated scenarios', () => {
    const a = fixtureBundle(fixtureScenario('unrelated-a'), [fixtureTraveler('p0000')], { p0000: 100 })
    const b = fixtureBundle(fixtureScenario('unrelated-b'), [fixtureTraveler('p0000')], { p0000: 200 })
    const comparison = comparePopulations(a, b, [a.scenario!, b.scenario!])!
    expect(comparison.sharedIds).toEqual([])
    expect(comparison.related).toBe(false)
    expect(comparison.medianSavedS).toBeNull()
  })

  it('excludes modified trip inputs even when IDs and ancestry match', () => {
    const parent = fixtureScenario()
    const child = fixtureScenario('child', 'parent')
    const b = fixtureBundle(parent, [fixtureTraveler('same-id')], { 'same-id': 100 })
    const a = fixtureBundle(child, [fixtureTraveler('same-id', { origin_edge: 'new-origin' })], { 'same-id': 200 })
    const comparison = comparePopulations(a, b, [parent, child])!
    expect(comparison.related).toBe(true)
    expect(comparison.sharedIds).toEqual([])
    expect(comparison.changedInputs).toBe(1)
    expect(comparison.viewOnly.size).toBe(1)
    expect(comparison.compareOnly.size).toBe(1)
  })

  it('accounts for waiting and unroutable new trips separately', () => {
    const parent = fixtureScenario()
    const child = fixtureScenario('child', 'parent')
    const b = fixtureBundle(parent, [fixtureTraveler()])
    const a = fixtureBundle(child, [fixtureTraveler(), fixtureTraveler('waiting'), fixtureTraveler('unroutable')])
    a.cohort!.final_state = { waiting: 'waiting', unroutable: 'unroutable' }
    a.cohort!.waiting_seconds = { waiting: 120, unroutable: 0, incumbent: 0 }
    const comparison = comparePopulations(a, b, [parent, child])!
    expect(comparison.viewOnly).toMatchObject({ size: 2, completed: 0, unfinished: 1, unroutable: 1, waitingPersonMinutes: 2 })
  })

  it('requires demand metadata and equal horizons for duration comparisons', () => {
    const parent = fixtureScenario()
    const a = fixtureBundle(parent, [fixtureTraveler()], { incumbent: 100 })
    const b = fixtureBundle(parent, [fixtureTraveler()], { incumbent: 200 })
    delete a.demand
    expect(comparePopulations(a, b, [parent])).toBeNull()
    a.demand = b.demand
    a.run.metrics!.horizon_s = 3000
    const comparison = comparePopulations(a, b, [parent])!
    expect(comparison.comparableHorizon).toBe(false)
    expect(comparison.medianSavedS).toBeNull()
  })
})
