import { describe, expect, it } from 'vitest'
import { canEditScenario, containsHazardPoint, hazardFootprint, parentForComparison, scenarioForReplay } from './replay'
import type { ReplayIndex } from './replay'
import type { HazardTrack, ScenarioSpec } from './types'

const hazard: HazardTrack = {
  track_id: 'h', waypoints: [[-79.39, 43.64]], radius_m: 100, start_s: 100, end_s: 300,
  modes: ['passenger', 'bus'], kind: 'flood', label: 'Declared exclusion',
  footprint: [[[-79.391, 43.639], [-79.389, 43.639], [-79.389, 43.641], [-79.391, 43.641], [-79.391, 43.639]]],
}

describe('Static hazard replay', () => {
  it('uses the server footprint for a single point without inventing movement', () => {
    const first = hazardFootprint(hazard, 100)
    expect(first?.rings).toEqual(hazard.footprint)
    expect(first?.center[0]).toBeCloseTo(-79.39)
    expect(first?.center[1]).toBeCloseTo(43.64)
    expect(hazardFootprint(hazard, 299)).toEqual(first)
  })

  it('shows the entire corridor for the full active window', () => {
    const corridor = { ...hazard, waypoints: [[-79.391, 43.64], [-79.389, 43.64]] as [number, number][] }
    expect(hazardFootprint(corridor, 100)).toEqual(hazardFootprint(corridor, 299))
    expect(hazardFootprint(corridor, 200)?.rings).toEqual(hazard.footprint)
  })

  it('matches start-inclusive, end-exclusive restriction timing', () => {
    expect(hazardFootprint(hazard, 99)).toBeNull()
    expect(hazardFootprint(hazard, 100)).not.toBeNull()
    expect(hazardFootprint(hazard, 300)).toBeNull()
  })

  it('always shows an explicit preview even outside the active window', () => {
    expect(hazardFootprint(hazard, 0, true)?.rings).toEqual(hazard.footprint)
    expect(hazardFootprint(hazard, 1000, true)?.rings).toEqual(hazard.footprint)
  })

  it('never guesses a buffer when the authoritative footprint is absent', () => {
    expect(hazardFootprint({ ...hazard, footprint: [] }, 100)).toBeNull()
  })

  it('selects only points inside the authoritative polygon and outside its holes', () => {
    expect(containsHazardPoint(hazard, [-79.39, 43.64])).toBe(true)
    expect(containsHazardPoint(hazard, [-79.38, 43.64])).toBe(false)
    const hole: [number, number][] = [[-79.3905, 43.6395], [-79.3895, 43.6395], [-79.3895, 43.6405], [-79.3905, 43.6405]]
    expect(containsHazardPoint({ ...hazard, footprint: [...hazard.footprint, hole] }, [-79.39, 43.64])).toBe(false)
  })
})

describe('Scenario ownership in replay and comparison', () => {
  const parent = { scenario_id: 'parent', hazards: [] } as unknown as ScenarioSpec
  const child = { scenario_id: 'child', hazards: [hazard] } as unknown as ScenarioSpec
  const replay = { bundle: { run: { scenario_id: 'parent' } } } as ReplayIndex

  it('does not paint child hazards over a recorded parent run', () => {
    expect(scenarioForReplay([parent, child], 'child', replay)).toBe(parent)
  })

  it('shows the selected scenario before any run exists', () => {
    expect(scenarioForReplay([parent, child], 'child', null)).toBe(child)
  })

  it('does not guess scenario restrictions for an unknown recorded run', () => {
    expect(scenarioForReplay([child], 'child', replay)).toBeNull()
  })

  it('offers a parent baseline only for the same city and declared cohort', () => {
    const base = { ...parent, pack_id: 'pack', demand_id: 'cohort' }
    const branch = { ...child, pack_id: 'pack', demand_id: 'cohort', parent_scenario_id: 'parent' }
    expect(parentForComparison([base, branch], 'child')).toBe(base)
    expect(parentForComparison([base, { ...branch, demand_id: 'other' }], 'child')).toBeNull()
    expect(parentForComparison([base, { ...branch, pack_id: 'other' }], 'child')).toBeNull()
    expect(parentForComparison([branch], 'child')).toBeNull()
    expect(parentForComparison([base, branch], 'parent')).toBeNull()
  })

  it('allows drawing only on the selected candidate, never the left baseline', () => {
    expect(canEditScenario(child, 'child', 'solo')).toBe(true)
    expect(canEditScenario(child, 'child', 'right')).toBe(true)
    expect(canEditScenario(child, 'child', 'left')).toBe(false)
    expect(canEditScenario(parent, 'child', 'right')).toBe(false)
    expect(canEditScenario(null, 'child', 'solo')).toBe(false)
  })
})
