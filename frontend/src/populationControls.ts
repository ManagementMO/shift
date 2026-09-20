import type { PopulationBudget, PopulationSpec, PopulationStatus } from './types'

export const DEFAULT_POPULATION_BUDGET: PopulationBudget = {
  max_concurrency: 4,
  max_iterations: 4,
  decision_timeout_s: 60,
  max_calls: 2400,
  max_tokens: 20_000_000,
  max_output_tokens: 1024,
  max_cost_usd: 20,
  requests_per_minute: 60,
  tokens_per_minute: 5_000_000,
}

export function populationCostLimit(status: PopulationStatus | null): number {
  if (!status || status.budget.blocked || status.budget.remaining_microdollars === undefined) return 0
  return Math.max(0, Math.min(20, status.budget.session_limit_microdollars / 1_000_000, status.budget.remaining_microdollars / 1_000_000))
}

export function populationScaleReason(status: PopulationStatus | null, count: number): string | null {
  return status?.initial_scale_gate !== undefined && count > status.initial_scale_gate
    ? `Native execution is limited to ${status.initial_scale_gate} residents until the integration proof passes and the backend raises the scale gate. This definition can still be saved.`
    : null
}

export function populationUnavailableReason(status: PopulationStatus | null, error: string | null = null): string | null {
  if (error) return `JiuwenSwarm status unavailable: ${error}`
  if (!status) return 'Checking native JiuwenSwarm availability…'
  if (!status.available) return status.reason ?? 'Native JiuwenSwarm is unavailable. No mock or rules run will be substituted.'
  if (populationCostLimit(status) <= 0) return 'The persistent inference budget is blocked, exhausted, or unavailable.'
  if (!status.models.length) return 'No resident brain models are configured.'
  if (status.models.some((brain) => brain.control_mode !== 'jiuwenswarm')) return 'Configured rules fixtures are not native JiuwenSwarm execution. Native population runs are disabled.'
  return null
}

export function defaultPopulationSpec(status: PopulationStatus, options: { count?: number; seed?: number; horizon?: number; packId?: string; maxCostUsd?: number } = {}): PopulationSpec {
  const unavailable = populationUnavailableReason(status)
  if (unavailable) throw new Error(unavailable)
  const cost = options.maxCostUsd ?? populationCostLimit(status)
  if (!Number.isFinite(cost) || cost < 0) throw new Error('Population budget must be a finite non-negative amount.')
  const count = options.count ?? 12
  const horizon = options.horizon ?? 3600
  const seed = options.seed ?? 7
  if (!Number.isInteger(count) || count < 5 || count > 300) throw new Error('Population count must be 5–300.')
  if (!Number.isInteger(horizon) || horizon < 60 || horizon > 14400) throw new Error('Population horizon must be 60–14400 seconds.')
  if (!Number.isSafeInteger(seed)) throw new Error('Population seed must be an integer.')
  return {
    generator_version: 'society-v1', rules_version: 'service-ledger-v1', pack_id: options.packId ?? 'toronto', seed, count, horizon_s: horizon,
    enabled_classes: ['pedestrian', 'bicycle', 'passenger', 'delivery', 'truck'], brains: status.models.map((brain) => ({ ...brain })),
    budget: { ...DEFAULT_POPULATION_BUDGET, max_cost_usd: Math.min(populationCostLimit(status), cost) },
    recurring_need_s: 900, service_duration_s: 60, decision_interval_s: 30, district_radius_m: 700,
  }
}
