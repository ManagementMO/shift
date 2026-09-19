import type { RunBundle, ScenarioSpec, Traveler } from './types'

export type PopulationSummary = {
  size: number
  completed: number
  unfinished: number
  unroutable: number
  waitingPersonMinutes: number | null
  durationMedianS: number | null
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function tripKey(trip: Traveler): string {
  return JSON.stringify(Object.entries({ ...trip, development_id: trip.development_id ?? null, trip_direction: trip.trip_direction ?? null }).sort(([a], [b]) => a.localeCompare(b)))
}

function horizon(bundle: RunBundle): number {
  return bundle.run.metrics?.horizon_s ?? bundle.scenario?.constraints.horizon_s ?? 0
}

function arrivals(bundle: RunBundle): Record<string, number> {
  const recorded = bundle.cohort?.arrived ?? Object.fromEntries(bundle.events.filter((e) => e.event === 'arrive').map((e) => [e.person_id, e.t]))
  return Object.fromEntries(Object.entries(recorded).filter(([, t]) => Number.isFinite(t) && t <= horizon(bundle)))
}

function summarize(bundle: RunBundle, ids: string[], arrived: Record<string, number>): PopulationSummary {
  const inputs = new Map(bundle.demand?.travelers.map((t) => [t.person_id, t]))
  const unroutableIds = new Set(bundle.events.filter((e) => e.event === 'unroutable').map((e) => e.person_id))
  let completed = 0, unroutable = 0
  const durations: number[] = []
  for (const id of ids) {
    if (Object.hasOwn(arrived, id)) {
      completed++
      const depart = bundle.cohort?.desired_depart[id] ?? inputs.get(id)?.depart_s
      if (depart !== undefined) durations.push(arrived[id] - depart)
    } else if (bundle.cohort?.final_state?.[id] === 'unroutable' || Object.hasOwn(bundle.compile?.unroutable ?? {}, id) || unroutableIds.has(id)) {
      unroutable++
    }
  }
  const waiting = bundle.cohort?.waiting_seconds
  const waitingKnown = ids.every((id) => waiting && Object.hasOwn(waiting, id))
  return { size: ids.length, completed, unroutable, unfinished: ids.length - completed - unroutable,
    waitingPersonMinutes: waitingKnown ? ids.reduce((sum, id) => sum + (waiting?.[id] ?? 0), 0) / 60 : null,
    durationMedianS: median(durations) }
}

export function comparePopulations(view: RunBundle, compare: RunBundle, scenarios: ScenarioSpec[]) {
  if (!view.demand || !compare.demand) return null
  const known = new Map(scenarios.map((s) => [s.scenario_id, s]))
  for (const bundle of [view, compare]) if (bundle.scenario) known.set(bundle.scenario.scenario_id, bundle.scenario)
  const ancestry = (id: string): Set<string> => {
    const ids = new Set<string>()
    let current: string | null = id
    while (current && !ids.has(current)) {
      ids.add(current)
      current = known.get(current)?.parent_scenario_id ?? null
    }
    return ids
  }
  const inputsA = new Map(view.demand.travelers.map((t) => [t.person_id, t]))
  const inputsB = new Map(compare.demand.travelers.map((t) => [t.person_id, t]))
  const idsA = [...new Set(view.cohort?.cohort ?? inputsA.keys())]
  const idsB = [...new Set(compare.cohort?.cohort ?? inputsB.keys())]
  const setB = new Set(idsB)
  const unchanged = (id: string) => inputsA.has(id) && inputsB.has(id) && tripKey(inputsA.get(id)!) === tripKey(inputsB.get(id)!)
  const ancestorsB = ancestry(compare.run.scenario_id)
  const samePack = known.get(view.run.scenario_id)?.pack_id === known.get(compare.run.scenario_id)?.pack_id
    && !!known.get(view.run.scenario_id)?.pack_id
  const identicalDemand = view.demand.demand_id === compare.demand.demand_id && view.demand.seed === compare.demand.seed
    && idsA.length === idsB.length && idsA.every((id) => setB.has(id) && unchanged(id))
  const related = samePack && (identicalDemand || [...ancestry(view.run.scenario_id)].some((id) => ancestorsB.has(id)))
  const sharedIds = related ? idsA.filter((id) => setB.has(id) && unchanged(id)) : []
  const shared = new Set(sharedIds)
  const changedInputs = related ? idsA.filter((id) => setB.has(id) && !unchanged(id)).length : 0
  const arrA = arrivals(view), arrB = arrivals(compare)
  const both: { pid: string; a: number; b: number }[] = []
  let onlyView = 0, onlyCompare = 0, neither = 0
  for (const pid of sharedIds) {
    if (Object.hasOwn(arrA, pid) && Object.hasOwn(arrB, pid)) {
      const depart = inputsA.get(pid)!.depart_s
      both.push({ pid, a: arrA[pid] - depart, b: arrB[pid] - depart })
    } else if (Object.hasOwn(arrA, pid)) onlyView++
    else if (Object.hasOwn(arrB, pid)) onlyCompare++
    else neither++
  }
  const comparableHorizon = horizon(view) === horizon(compare)
  const samePopulation = related && sharedIds.length === idsA.length && sharedIds.length === idsB.length
    && idsA.length === view.run.metrics?.cohort_size && idsB.length === compare.run.metrics?.cohort_size
  return {
    related, comparableHorizon, samePopulation, sameSeed: view.run.seed === compare.run.seed, sharedIds, changedInputs,
    matchedView: summarize(view, sharedIds, arrA), matchedCompare: summarize(compare, sharedIds, arrB),
    viewOnly: summarize(view, idsA.filter((id) => !shared.has(id)), arrA),
    compareOnly: summarize(compare, idsB.filter((id) => !shared.has(id)), arrB),
    bothArrived: both.length, onlyView, onlyCompare, neither,
    medianSavedS: comparableHorizon ? median(both.map((r) => r.b - r.a)) : null,
    biggest: comparableHorizon ? [...both].sort((a, b) => Math.abs(b.b - b.a) - Math.abs(a.b - a.a)).slice(0, 5) : [],
  }
}
