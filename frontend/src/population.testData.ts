import type { BrainAssignment, PopulationArtifact, PopulationDecisionRecord, PopulationMetrics, PopulationStatus, ResidentProfile, ResidentState, RunBundle, SimulationRun, SocietyTask } from './types'

export const claude: BrainAssignment = { model_family: 'Claude', model_id: 'claude-test', api_provider: 'openrouter', config_ref: 'claude', control_mode: 'jiuwenswarm', color: null }
export const openai: BrainAssignment = { ...claude, model_family: 'OpenAI', model_id: 'gpt-test', config_ref: 'openai' }

export function populationStatus(): PopulationStatus {
  return { available: true, reason: null, models: [claude, openai], budget: { session_limit_microdollars: null, accounted_microdollars: 0, remaining_microdollars: 40000000, request_count: 0, blocked: false }, native_proof_required: true, initial_scale_gate: 100 }
}

export function residentState(id = 'r1', extra: Partial<ResidentState> = {}): ResidentState {
  return {
    resident_id: id, role: 'courier', activity: 'idle', anchor_id: 'home', destination_id: null, mobility_mode: 'stationary', travel_class: null,
    needs: { rest: 0.2 }, commitments: [], current_task_id: null, plan: [], beliefs: [], memories: [], relationships: { r2: 0.6 }, vehicle_locations: {},
    busy_until_s: 0, next_decision_s: 0, next_need_s: 900, last_decision_s: null, fallback_reason: null, version: 0, ...extra,
  }
}

export function task(extra: Partial<SocietyTask> = {}): SocietyTask {
  return { task_id: 'job', kind: 'delivery', requester_id: 'r2', service_anchor_id: 'shop', destination_anchor_id: 'home', status: 'requested', provider_id: null,
    assignee_id: 'r1', required_capacity: 1, created_s: 10, deadline_s: 100, ready_s: null, completed_s: null, failure_reason: null, declined_by: [], version: 0, cause_id: null, ...extra }
}

export function decision(extra: Partial<PopulationDecisionRecord> = {}): PopulationDecisionRecord {
  return { decision_id: 'd1', resident_id: 'r1', t: 12, epoch: 1, source: 'jiuwenswarm', assigned_model_id: 'claude-test', actual_model_id: 'claude-resolved',
    summary: 'I will collect the request.', proposal: { action: 'travel', target_id: 'shop', travel_class: 'bicycle', request_kind: null, duration_s: 30, text: '',
      idempotency_key: 'travel-1', observation_refs: [], run_id: 'pop-run', resident_id: 'r1', epoch: 1, world_version: 1, effective_t: 12, expires_t: 42 },
    accepted: true, reason: 'validated', plan: ['collect'], beliefs: ['The shop may be open.'], outcome_event_ids: ['outcome'], fallback_reason: null, latency_ms: 12, usage: {}, ...extra }
}

export function populationArtifact(): PopulationArtifact {
  const profile = (id: string): ResidentProfile => ({ resident_id: id, name: id === 'r1' ? 'Alex' : 'Sam', persona: 'A careful local courier.', roles: ['courier'],
    preferences: { pace: 'careful' }, home_anchor_id: 'home', work_anchor_id: 'shop', contacts: [id === 'r1' ? 'r2' : 'r1'], household_id: id, organization_id: null,
    available_classes: ['pedestrian', 'bicycle', 'passenger', 'delivery', 'truck'], carrying_capacity: 2, routine: [], synthetic: true })
  const metrics: PopulationMetrics = { version: 'population-1', resident_count: 2, horizon_s: 3600, end_time_s: 60, task_status_counts: { completed: 1 },
    completed_deliveries: 1, completed_visits: 0, outstanding_needs: 0, outstanding_commitments: 0, accepted_actions: 1, rejected_actions: 0,
    decision_source_counts: { jiuwenswarm: 1, fallback: 1 }, memory_entries: 1, delivered_messages: 1, completed_trips: 1, failed_trips: 0,
    calls: 1, tokens: 10, cost_usd: 0.01, reserved_cost_usd: 0, artifact_bytes: 100, wall_time_s: 1, warnings: [] }
  return {
    version: 'population-1', run_id: 'pop-run', attempt_id: 'attempt-1',
    definition: {
      population_id: 'population', network_fingerprint: 'net',
      spec: { generator_version: 'society-v1', rules_version: 'service-ledger-v1', pack_id: 'toronto', seed: 7, count: 12, horizon_s: 3600,
        enabled_classes: ['pedestrian', 'bicycle', 'passenger', 'delivery', 'truck'], brains: [claude, openai],
        budget: { max_concurrency: 4, max_iterations: 4, decision_timeout_s: 60, max_calls: 2400, max_tokens: 2000000, max_output_tokens: 1024,
          max_cost_usd: 20, requests_per_minute: 60, tokens_per_minute: 120000 }, recurring_need_s: 900, service_duration_s: 60, decision_interval_s: 30, district_radius_m: 700 },
      anchors: ['home', 'shop'].map((id, i) => ({ anchor_id: id, name: id, purpose: i ? 'shop' : 'home', lon: i ? -79.379 : -79.38, lat: 43.64,
        access: { pedestrian: { edge_id: 'edge', position_m: 5, lane_index: 0 } }, capacity: 12, opens_s: 0, closes_s: 86400, service_duration_s: 60, synthetic: true })),
      profiles: [profile('r1'), profile('r2')], initial_states: [residentState(), residentState('r2')], initial_tasks: [], assignments: { r1: claude, r2: openai }, assumptions: ['Synthetic fixture'],
    },
    states: [
      { t: 10, state: residentState('r1', { activity: 'traveling', anchor_id: null, mobility_mode: 'cycle', travel_class: 'bicycle', commitments: ['job'], current_task_id: 'job' }) },
      { t: 30, state: residentState('r1', { activity: 'working', anchor_id: 'shop', memories: [
        { event_id: 'seen', t: 25, kind: 'observation', text: 'Reached shop.', related_residents: [] },
        { event_id: 'future-memory', t: 50, kind: 'outcome', text: 'FUTURE MEMORY', related_residents: [] },
      ] }) },
    ],
    tasks: [{ t: 10, task: task() }, { t: 50, task: task({ status: 'completed', completed_s: 50, version: 1 }) }, { t: 55, task: task({ task_id: 'future-job', created_s: 55 }) }],
    decisions: [decision(), decision({ decision_id: 'fallback', t: 35, source: 'fallback', actual_model_id: null, summary: 'Waiting after timeout.', fallback_reason: 'timeout', proposal: null, accepted: false, outcome_event_ids: [] })],
    messages: [{ message_id: 'message', sender_id: 'r1', recipient_id: 'r2', sent_s: 15, delivered_s: 20, text: 'On my way.', task_id: 'job', cause_id: 'd1' },
      { message_id: 'future-message', sender_id: 'r2', recipient_id: 'r1', sent_s: 50, delivered_s: 51, text: 'FUTURE MESSAGE', task_id: null, cause_id: null }],
    events: [{ event_id: 'outcome', t: 50, epoch: 2, kind: 'delivery', resident_ids: ['r1', 'r2'], task_id: 'job', cause_id: 'd1', text: 'Delivered.', status: 'observed' }],
    mobility_bindings: [
      { resident_id: 'r1', entity_id: null, mode: 'stationary', vehicle_class: null, anchor_id: 'home', start_s: 0, end_s: 10, ownership: 'abstract', measured: false, capacity: 1 },
      { resident_id: 'r1', entity_id: 'bike-body', mode: 'cycle', vehicle_class: 'bicycle', anchor_id: null, start_s: 10, end_s: 30, ownership: 'resident', measured: true, capacity: 1 },
      { resident_id: 'r1', entity_id: null, mode: 'stationary', vehicle_class: null, anchor_id: 'shop', start_s: 30, end_s: 40, ownership: 'abstract', measured: false, capacity: 1 },
      { resident_id: 'r1', entity_id: 'van-body', mode: 'drive', vehicle_class: 'delivery', anchor_id: null, start_s: 40, end_s: 45, ownership: 'resident', measured: true, capacity: 1 },
      { resident_id: 'r1', entity_id: 'shared-bus', mode: 'transit', vehicle_class: 'bus', anchor_id: null, start_s: 45, end_s: null, ownership: 'shared', measured: true, capacity: 60 },
      { resident_id: 'r2', entity_id: null, mode: 'stationary', vehicle_class: null, anchor_id: 'home', start_s: 0, end_s: 45, ownership: 'abstract', measured: false, capacity: 1 },
      { resident_id: 'r2', entity_id: 'shared-bus', mode: 'transit', vehicle_class: 'bus', anchor_id: null, start_s: 45, end_s: null, ownership: 'shared', measured: true, capacity: 60 },
    ],
    swarm_bindings: [{ resident_id: 'r1', run_id: 'pop-run', team_id: 'team', workflow_id: 'workflow', session_id: 'session', worker_id: 'worker', requested_model_id: 'claude-test', resolved_model_id: 'claude-resolved', generation: 0, restored: false }],
    metrics,
  }
}

export function run(extra: Partial<SimulationRun> = {}): SimulationRun {
  return { run_id: 'pop-run', scenario_id: 'scenario', plan_id: 'population', seed: 7, status: 'completed', engine_version: 'SUMO', progress: 1, run_dir: '',
    error: null, warnings: [], metrics: null, manifest_hash: 'hash', created_at: '2026-01-01', ...extra }
}

export function bundle(population: PopulationArtifact | null = populationArtifact()): RunBundle {
  return {
    run: run(population ? { run_kind: 'population', population_id: 'population' } : {}), population,
    tracks: {
      'bike-body': { entity_id: 'bike-body', kind: 'bicycle', resident_id: 'r1', vehicle_class: 'bicycle', samples: [[10, -79.38, 43.64, 90, 3], [11, -79.379, 43.64, 90, 3], [29, -79.379, 43.64, 90, 0]], breaks: [2] },
      'van-body': { entity_id: 'van-body', kind: 'delivery', resident_id: 'r1', samples: [[40, -79.379, 43.64, 90, 3]], breaks: [] },
      'shared-bus': { entity_id: 'shared-bus', kind: 'bus', samples: [[45, -79.379, 43.64, 0, 4]], breaks: [] },
      'car_r2': { entity_id: 'car_r2', kind: 'car', samples: [[10, -79.38, 43.64, 0, 4]], breaks: [] },
    }, events: [], occupancy: {}, stopQueue: {}, compile: null,
  }
}
