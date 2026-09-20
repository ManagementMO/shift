import { describe, expect, it } from 'vitest'

import { activeRestrictions, isHazardRestriction, spansScenario } from './closures'
import type { Restriction } from './types'

const restriction = (over: Partial<Restriction>): Restriction => ({
  restriction_id: 'closure-front-west', edge_ids: ['f1', 'f2'], start_s: 0, end_s: 2700, modes: ['passenger', 'bus'],
  source_claim_id: null, label: 'Front St W — closed both directions (fixture notice)', ...over,
})

describe('Street closures have no time window', () => {
  it('tells hazard footprints apart from street closures', () => {
    expect(isHazardRestriction(restriction({}))).toBe(false)
    expect(isHazardRestriction(restriction({ restriction_id: 'hazard-storm-1', source_claim_id: 'hazard:storm-1' }))).toBe(true)
    expect(isHazardRestriction(restriction({ restriction_id: 'hazard-legacy' }))).toBe(true)
  })

  it('treats a whole-horizon restriction as untimed and a partial one as windowed', () => {
    expect(spansScenario(restriction({}), 2700)).toBe(true)
    expect(spansScenario(restriction({ end_s: 5000 }), 2700)).toBe(true)
    expect(spansScenario(restriction({ start_s: 600, end_s: 1200 }), 2700)).toBe(false)
  })

  it('keeps every street closure in force while hazard windows come and go', () => {
    const closure = restriction({})
    const hazard = restriction({ restriction_id: 'hazard-storm-1', source_claim_id: 'hazard:storm-1', edge_ids: ['h1'], start_s: 600, end_s: 1200 })
    const scenario = { restrictions: [closure, hazard] }
    expect(activeRestrictions(scenario, 0)).toEqual([closure])
    expect(activeRestrictions(scenario, 900)).toEqual([closure, hazard])
    expect(activeRestrictions(scenario, 2700)).toEqual([closure])
    expect(activeRestrictions(null, 0)).toEqual([])
  })
})
