import { describe, expect, it } from 'vitest'
import { defaultPopulationModelIds, defaultPopulationSpec, populationBudgetPolicy, populationCostLimit, populationCountLimit, populationDefinitionReason, populationScaleReason, populationUnavailableReason } from './populationControls'
import { claude, openai, populationStatus as status } from './population.testData'
import { parsePopulationStatus } from './populationValidation'

describe('explicit native population controls', () => {
  it('uses a short default run, all five classes and one reviewed model within a $5 cap', () => {
    const spec = defaultPopulationSpec(status())
    expect(spec).toMatchObject({ pack_id: 'toronto', seed: 7, count: 100, horizon_s: 600, enabled_classes: ['pedestrian', 'bicycle', 'passenger', 'delivery', 'truck'], brains: [claude] })
    expect(spec.budget.max_cost_usd).toBe(5)
    expect(defaultPopulationSpec(status(), { modelIds: [claude.model_id, openai.model_id] }).brains).toEqual([claude, openai])
    expect(defaultPopulationModelIds({ ...status(), models: [openai] })).toEqual([openai.model_id])
    expect(() => defaultPopulationSpec(status(), { count: 240 })).toThrow(/100 residents/)
    expect(defaultPopulationSpec({ ...status(), initial_scale_gate: 20 }).count).toBe(20)
    expect(defaultPopulationSpec({ ...status(), initial_scale_gate: 300 }, { count: 240 }).count).toBe(240)
  })

  it('never turns unavailable native cognition or rules fixtures into a successful native spec', () => {
    const unavailable = { ...status(), available: false, reason: 'JiuwenSwarm not installed' }
    expect(populationUnavailableReason(unavailable)).toContain('JiuwenSwarm not installed')
    expect(defaultPopulationSpec(unavailable).brains).toEqual([claude])
    const rules = { ...status(), models: [{ ...claude, control_mode: 'rules' as const }] }
    expect(populationUnavailableReason(rules)).toMatch(/rules/i)
    expect(() => defaultPopulationSpec(rules)).toThrow(/rules/i)
    expect(() => defaultPopulationSpec({ ...status(), models: [] })).toThrow(/model|brain/i)
  })

  it('preserves a reusable run ceiling within $20 without changing remaining session authority', () => {
    const available = status()
    available.budget.remaining_microdollars = 2_000_000
    expect(defaultPopulationSpec(available, { maxCostUsd: 20 }).budget.max_cost_usd).toBe(20)
    expect(defaultPopulationSpec(status(), { maxCostUsd: 50 }).budget.max_cost_usd).toBe(20)
    expect(available.budget.remaining_microdollars).toBe(2_000_000)
    expect(() => defaultPopulationSpec(status(), { maxCostUsd: NaN })).toThrow(/budget/i)
  })

  it('reads provider-capped status and enforces the configurable native resident limit', () => {
    const parsed = parsePopulationStatus(status())
    expect(parsed.budget.session_limit_microdollars).toBeNull()
    expect(parsed.budget.remaining_microdollars).toBe(40_000_000)
    expect(populationScaleReason(parsed, 100)).toBeNull()
    expect(populationScaleReason(parsed, 240)).toMatch(/100 residents.*runtime limit/)
    expect(populationScaleReason({ ...parsed, initial_scale_gate: 300 }, 240)).toBeNull()
    const blocked = parsePopulationStatus({ ...status(), available: false, reason: 'Budget ledger unavailable', budget: { session_limit_microdollars: 20_000_000, blocked: true } })
    expect(populationUnavailableReason(blocked)).toMatch(/ledger unavailable/)
    expect(defaultPopulationSpec(blocked).budget.max_cost_usd).toBe(5)
  })

  it('saves deterministic definitions with selected reviewed brains even after the inference budget is exhausted', () => {
    const blocked = { ...status(), available: false, reason: 'Budget exhausted', budget: { ...status().budget, blocked: true, remaining_microdollars: 0 } }
    expect(populationDefinitionReason(blocked)).toBeNull()
    expect(populationUnavailableReason(blocked)).toContain('Budget exhausted')
    const spec = defaultPopulationSpec(blocked, { modelIds: [openai.model_id] })
    expect(spec.brains).toEqual([openai])
    expect(spec.budget.max_cost_usd).toBe(5)
    expect(() => defaultPopulationSpec(status(), { modelIds: [] })).toThrow(/at least one/)
    expect(() => defaultPopulationSpec(status(), { modelIds: ['unconfigured-model'] })).toThrow(/configured/)
    expect(populationCountLimit(null)).toBe(100)
    expect(populationCountLimit({ ...status(), initial_scale_gate: 1000 })).toBe(300)
  })

  it('shows provider funds above $20 without changing the independent per-run ceiling', () => {
    const provider = parsePopulationStatus(status())
    expect(populationCostLimit(provider)).toBe(40)
    expect(populationBudgetPolicy(provider)).toContain('No application session cap')
    expect(defaultPopulationSpec(provider, { maxCostUsd: 50 }).budget.max_cost_usd).toBe(20)
    const legacy = parsePopulationStatus({ ...provider, budget: { ...provider.budget, session_limit_microdollars: 20_000_000 } })
    expect(populationCostLimit(legacy)).toBe(20)
    expect(populationBudgetPolicy(legacy)).toContain('Application session cap: $20.00')
    expect(populationCostLimit({ ...provider, budget: { ...provider.budget, remaining_microdollars: 826_000 } })).toBe(0.826)
    expect(populationCostLimit({ ...provider, budget: { ...provider.budget, blocked: true } })).toBe(0)
    expect(populationCostLimit(parsePopulationStatus({ ...provider, budget: { session_limit_microdollars: null, blocked: false } }))).toBe(0)
    expect(() => parsePopulationStatus({ ...provider, budget: { ...provider.budget, session_limit_microdollars: 'unlimited' } })).toThrow(/session_limit_microdollars/)
    expect(() => parsePopulationStatus({ ...provider, budget: { ...provider.budget, session_limit_microdollars: -1 } })).toThrow(/session_limit_microdollars/)
  })
})
