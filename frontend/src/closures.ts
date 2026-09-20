// Street closures: which restrictions are in force and which of them carry a real time window.
// A street closure has no time window — it stays closed until the user removes it. Only hazard footprints
// (restrictions derived from a moving hazard track) keep a start/end window.

import type { Restriction, ScenarioSpec } from './types'

export function isHazardRestriction(r: Restriction): boolean {
  return r.source_claim_id?.startsWith('hazard:') === true || r.restriction_id.startsWith('hazard-')
}

/** True when a restriction covers the whole scenario, i.e. it has no meaningful time window to show. */
export function spansScenario(r: Restriction, horizon: number): boolean {
  return r.start_s <= 0 && r.end_s >= horizon
}

/** Restrictions in force at sim time `t`. */
export function activeRestrictions(scenario: Pick<ScenarioSpec, 'restrictions'> | null | undefined, t: number): Restriction[] {
  return scenario?.restrictions.filter((r) => t >= r.start_s && t <= r.end_s) ?? []
}
