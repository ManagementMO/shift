import type { CityPack, RunBundle, ScenarioSpec, Traveler } from './types'

export const fixturePack: CityPack = {
  pack_id: 'test-city', name: 'Synthetic test city', version: '1', network_fingerprint: 'fixture',
  bbox: [-79.4, 43.63, -79.37, 43.66], center: [-79.389, 43.644], venue_lonlat: [-79.389, 43.644], venue_edge_id: 'origin',
  stops: [], zones: [{ zone_id: 'east', name: 'East', edge_ids: ['destination'], lon: -79.38, lat: 43.644, share: 1 }],
  limitations: [], real_data: false,
}

export function fixtureScenario(id = 'parent', parent: string | null = null): ScenarioSpec {
  return {
    scenario_id: id, parent_scenario_id: parent, pack_id: fixturePack.pack_id, demand_id: `demand-${id}`,
    evidence_bundle_id: null, evidence_hash: null, restrictions: [], hazards: [], developments: [],
    constraints: { fleet: [], horizon_s: 1800, service_window_s: [0, 1500], allowed_stop_ids: [], objective: 'completion_by_horizon', hard_max_fleet: 2 },
    change_set: [], label: id, created_at: '2026-09-19T00:00:00Z',
  }
}

export function fixtureTraveler(id = 'incumbent', changes: Partial<Traveler> = {}): Traveler {
  return { person_id: id, origin_edge: 'origin', dest_edge: 'destination', dest_zone: 'east', depart_s: 0, has_car: false, walk_limit_m: 1000, ...changes }
}

export function fixtureBundle(scenario: ScenarioSpec, travelers: Traveler[], arrived: Record<string, number> = {}): RunBundle {
  const horizon = scenario.constraints.horizon_s
  return {
    scenario, demand: { demand_id: scenario.demand_id, travelers, seed: 7, synthetic: true, generation_method: 'test fixture' },
    cohort: { cohort: travelers.map((t) => t.person_id), desired_depart: Object.fromEntries(travelers.map((t) => [t.person_id, t.depart_s])), arrived, final_state: {}, waiting_seconds: {} },
    run: { run_id: `run-${scenario.scenario_id}`, scenario_id: scenario.scenario_id, plan_id: 'baseline', seed: 1, status: 'completed',
      engine_version: 'fixture', progress: 1, run_dir: '', error: null, warnings: [], manifest_hash: '', created_at: scenario.created_at,
      metrics: { cohort_size: travelers.length, horizon_s: horizon, completed: Object.keys(arrived).length,
        unfinished_waiting: 0, unfinished_walking: 0, unfinished_riding: 0, unfinished_not_departed: travelers.length - Object.keys(arrived).length,
        unroutable: 0, waiting_person_minutes: 0, completed_duration_median_s: null, completed_duration_p95_s: null,
        boardings: 0, extra_fleet_ids: [], max_occupancy: {}, teleports: 0, warnings: [] },
    },
    tracks: {}, events: Object.entries(arrived).map(([person_id, t]) => ({ person_id, t, event: 'arrive', stop_id: null, vehicle_id: null })),
    occupancy: {}, stopQueue: {}, compile: null,
  }
}
