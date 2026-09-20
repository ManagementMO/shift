import { describe, expect, it } from 'vitest'
import { DEFAULT_POPULATION_BUDGET } from './populationControls'
import { populationArtifact } from './population.testData'
import { parsePopulationArtifact, parsePopulationDefinition } from './populationValidation'

describe('backend population budget compatibility', () => {
  it('loads definitions and recordings using the native default token rate', () => {
    const artifact = populationArtifact()
    artifact.definition.spec.budget = { ...DEFAULT_POPULATION_BUDGET }
    expect(parsePopulationDefinition(artifact.definition).spec.budget.tokens_per_minute).toBe(5_000_000)
    expect(parsePopulationArtifact(artifact).definition.spec.budget.tokens_per_minute).toBe(5_000_000)
  })
  it('accepts the backend rate ceiling while preserving integer and spending limits', () => {
    const definition = populationArtifact().definition
    definition.spec.budget.tokens_per_minute = 20_000_000
    expect(() => parsePopulationDefinition(definition)).not.toThrow()
    for (const rate of [0, 1.5, 20_000_001, Infinity]) {
      definition.spec.budget.tokens_per_minute = rate
      expect(() => parsePopulationDefinition(definition)).toThrow(/tokens_per_minute/)
    }
    definition.spec.budget.tokens_per_minute = 5_000_000
    definition.spec.budget.max_cost_usd = 20.01
    expect(() => parsePopulationDefinition(definition)).toThrow(/max_cost_usd/)
  })
})
