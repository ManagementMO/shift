import { describe, expect, it } from 'vitest'
import { defaultPopulationSpec, populationCountLimit, populationDefinitionReason, populationScaleReason, populationUnavailableReason } from './populationControls'
import { claude, openai, populationStatus as status } from './population.testData'
import { parsePopulationStatus } from './populationValidation'

describe('explicit native population controls', () => {
  it('uses the default city, seed, horizon, all five classes and public configured brains', () => {
    const spec = defaultPopulationSpec(status())
    expect(spec).toMatchObject({ pack_id: 'toronto', seed: 7, count: 12, horizon_s: 600, enabled_classes: ['pedestrian', 'bicycle', 'passenger', 'delivery', 'truck'], brains: [claude, openai] })
    expect(spec.budget.max_cost_usd).toBe(20)
    expect(() => defaultPopulationSpec(status(), { count: 240 })).toThrow(/20 residents/)
    expect(defaultPopulationSpec({ ...status(), initial_scale_gate: 300 }, { count: 240 }).count).toBe(240)
  })

  it('never turns unavailable native cognition or rules fixtures into a successful native spec', () => {
    const unavailable = { ...status(), available: false, reason: 'JiuwenSwarm not installed' }
    expect(populationUnavailableReason(unavailable)).toContain('JiuwenSwarm not installed')
    expect(defaultPopulationSpec(unavailable).brains).toEqual([claude, openai])
    const rules = { ...status(), models: [{ ...claude, control_mode: 'rules' as const }] }
    expect(populationUnavailableReason(rules)).toMatch(/rules/i)
    expect(() => defaultPopulationSpec(rules)).toThrow(/rules/i)
    expect(() => defaultPopulationSpec({ ...status(), models: [] })).toThrow(/model|brain/i)
  })

  it('does not exceed the advertised or approved $20 budget and does not mutate public settings', () => {
    const available = status()
    available.budget.remaining_microdollars = 2_000_000
    expect(defaultPopulationSpec(available, { maxCostUsd: 20 }).budget.max_cost_usd).toBe(2)
    expect(defaultPopulationSpec(status(), { maxCostUsd: 50 }).budget.max_cost_usd).toBe(20)
    expect(available.budget.remaining_microdollars).toBe(2_000_000)
    expect(() => defaultPopulationSpec(status(), { maxCostUsd: NaN })).toThrow(/budget/i)
  })

  it('reads the public session ledger, including a blocked partial response, and enforces the native scale gate', () => {
    const parsed = parsePopulationStatus(status())
    expect(parsed.budget.remaining_microdollars).toBe(20_000_000)
    expect(populationScaleReason(parsed, 12)).toBeNull()
    expect(populationScaleReason(parsed, 240)).toMatch(/20 residents.*proof/)
    expect(populationScaleReason({ ...parsed, initial_scale_gate: 300 }, 240)).toBeNull()
    const blocked = parsePopulationStatus({ ...status(), available: false, reason: 'Budget ledger unavailable', budget: { session_limit_microdollars: 20_000_000, blocked: true } })
    expect(populationUnavailableReason(blocked)).toMatch(/ledger unavailable/)
    expect(defaultPopulationSpec(blocked).budget.max_cost_usd).toBe(0)
  })

  it('saves deterministic definitions with selected reviewed brains even after the inference budget is exhausted', () => {
    const blocked = { ...status(), available: false, reason: 'Budget exhausted', budget: { ...status().budget, blocked: true, remaining_microdollars: 0 } }
    expect(populationDefinitionReason(blocked)).toBeNull()
    expect(populationUnavailableReason(blocked)).toContain('Budget exhausted')
    const spec = defaultPopulationSpec(blocked, { modelIds: [openai.model_id] })
    expect(spec.brains).toEqual([openai])
    expect(spec.budget.max_cost_usd).toBe(0)
    expect(() => defaultPopulationSpec(status(), { modelIds: [] })).toThrow(/at least one/)
    expect(() => defaultPopulationSpec(status(), { modelIds: ['unconfigured-model'] })).toThrow(/configured/)
    expect(populationCountLimit(null)).toBe(20)
    expect(populationCountLimit({ ...status(), initial_scale_gate: 1000 })).toBe(300)
  })
})
