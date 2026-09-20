// TypeScript mirror of backend/cityshift/contracts.py (subset used by the UI).

export type Health = {
  ok: boolean
  schema_version: string
  sumo: string
  providers: {
    llm: { provider: string; model: string; available: boolean; sponsor: boolean }
    evidence: { provider: string; available: boolean; sponsor: boolean }
    sentry: { enabled: boolean }
    map: { mapbox_token_present: boolean }
    share: { r2_configured: boolean; mode: string }
  }
}

export type StopCandidate = {
  stop_id: string
  name: string
  edge_id: string
  lane_index: number
  start_pos: number
  end_pos: number
  lon: number
  lat: number
  allowed: boolean
}

export type DestinationZone = {
  zone_id: string
  name: string
  edge_ids: string[]
  lon: number
  lat: number
  share: number
}

export type CityPack = {
  pack_id: string
  name: string
  version: string
  bbox: [number, number, number, number]
  center: [number, number]
  venue_edge_id: string
  venue_lonlat: [number, number]
  stops: StopCandidate[]
  zones: DestinationZone[]
  limitations: string[]
  real_data: boolean
  network_fingerprint: string
}

export type Traveler = {
  person_id: string
  origin_edge: string
  dest_edge: string
  dest_zone: string
  depart_s: number
  has_car: boolean
  walk_limit_m: number
}

export type DemandSet = {
  demand_id: string
  seed: number
  travelers: Traveler[]
  synthetic: boolean
  generation_method: string
}

export type Corridor = { label: string; edge_ids: string[]; flagship_closure?: boolean }

export type Restriction = {
  restriction_id: string
  edge_ids: string[]
  start_s: number
  end_s: number
  modes: string[]
  source_claim_id: string | null
  label: string
}

export type HazardTrack = {
  track_id: string
  waypoints: [number, number][]
  radius_m: number
  start_s: number
  end_s: number
  modes: string[]
  label: string
}

export type FleetVehicle = { vehicle_id: string; capacity: number; depot_edge: string; available_from_s: number }

export type ScenarioSpec = {
  scenario_id: string
  pack_id: string
  demand_id: string
  scenario_kind?: 'transport' | 'population'
  population_id?: string | null
  evidence_bundle_id: string | null
  evidence_hash: string | null
  restrictions: Restriction[]
  hazards: HazardTrack[]
  constraints: {
    fleet: FleetVehicle[]
    horizon_s: number
    service_window_s: [number, number]
    allowed_stop_ids: string[]
    objective: string
    hard_max_fleet: number
  }
  parent_scenario_id: string | null
  change_set: string[]
  label: string
  created_at: string
}

export type Duty = { duty_id: string; vehicle_id: string; stop_sequence: string[]; depart_s: number; layover_s: number }

export type ServicePlan = {
  plan_id: string
  name: string
  family: 'none' | 'direct' | 'split' | 'heuristic' | 'custom'
  duties: Duty[]
  authored_by: string
  rationale: string
  assumptions: string[]
  parent_plan_id: string | null
}

export type ValidationIssue = { code: string; severity: 'hard' | 'soft' | 'unknown'; message: string; refs: string[] }
export type ValidationReport = { plan_id: string; valid: boolean; issues: ValidationIssue[] }

export type PlanWithValidation = { plan: ServicePlan; validation: ValidationReport | null }

export type RunStatus = 'draft' | 'validated' | 'queued' | 'running' | 'paused' | 'completed' | 'invalid' | 'failed' | 'canceled'

export type PopulationPauseResponse = { requested: true; run_id: string }

export type RunMetrics = {
  cohort_size: number
  horizon_s: number
  completed: number
  unfinished_waiting: number
  unfinished_riding: number
  unfinished_walking: number
  unfinished_not_departed: number
  unroutable: number
  waiting_person_minutes: number
  completed_duration_median_s: number | null
  completed_duration_p95_s: number | null
  boardings: number
  extra_fleet_ids: string[]
  max_occupancy: Record<string, number>
  teleports: number
  warnings: string[]
}

export type SimulationRun = {
  run_id: string
  scenario_id: string
  plan_id: string
  seed: number
  run_kind?: 'transport' | 'population'
  population_id?: string | null
  status: RunStatus
  engine_version: string
  progress: number
  run_dir: string
  error: string | null
  warnings: string[]
  metrics: RunMetrics | null
  manifest_hash: string
  created_at: string
}

export type EntityTrack = {
  entity_id: string
  kind: 'bus' | 'car' | 'person' | 'bicycle' | 'delivery' | 'truck'
  samples: number[][] // [t, lon, lat, angle, speed]
  breaks: number[]
  resident_id?: string | null
  vehicle_class?: string | null
}

export type PersonEvent = {
  t: number
  person_id: string
  event: 'depart' | 'wait_start' | 'board' | 'alight' | 'arrive' | 'unroutable'
  vehicle_id: string | null
  stop_id: string | null
}

export type CompileInfo = {
  ok: boolean
  errors: string[]
  notes: string[]
  mode_assignment: Record<string, string>
  unroutable: Record<string, string>
  line_schedule: Record<string, [number, string][]>
  duties: {
    duty_id: string
    vehicle_id: string
    line: string
    stop_sequence: string[]
    depart_s: number
    est_arrivals_s: number[]
    est_end_s: number
    edges: string[]
  }[]
}

export type RunBundle = {
  run: SimulationRun
  tracks: Record<string, EntityTrack>
  events: PersonEvent[]
  occupancy: Record<string, [number, number][]>
  stopQueue: Record<string, [number, number][]>
  compile: CompileInfo | null
  population?: PopulationArtifact | null
}

export type InterventionProposal = {
  proposal_id: string
  kind: 'close_edge' | 'reopen_edge' | 'move_stop' | 'set_fleet' | 'storm' | 'unsupported'
  text: string
  edge_ids: string[]
  stop_id: string | null
  target_stop_id: string | null
  fleet_count: number | null
  start_s: number | null
  end_s: number | null
  hazard: HazardTrack | null
  warnings: string[]
  base_scenario_id: string
  ambiguous: boolean
  reason: string
}

export type AgentDecision = {
  decision_id: string
  role: string
  action: string
  inputs_summary: string
  output_summary: string
  validation: string | null
  model: string
  provider: string
  timestamp: string
}

export type Investigation = {
  investigation_id: string
  scenario_id: string
  status: 'running' | 'completed' | 'failed'
  problem: string
  constraint: string
  decisions: AgentDecision[]
  proposed_plan_ids: string[]
  evidence_bundle_id: string | null
  error: string | null
  provider: string
  model: string
}

export type EvidenceClaim = {
  claim_id: string
  source_id: string
  claim_type: string
  text_span: string
  edge_ids: string[]
  status: string
  effective_start_s: number | null
  effective_end_s: number | null
}

export type EvidenceBundle = {
  bundle_id: string
  corpus_snapshot: string
  query_records: Record<string, unknown>[]
  source_ids: string[]
  claims: EvidenceClaim[]
  assumptions: string[]
  unresolved: string[]
  frozen_at: string
  content_hash: string
}

export type TravelClass = 'pedestrian' | 'bicycle' | 'passenger' | 'delivery' | 'truck'
export type PopulationAction = 'request_service' | 'accept' | 'decline' | 'travel' | 'prepare' | 'pickup' | 'deliver' | 'visit' | 'serve' | 'report_delay' | 'message' | 'wait' | 'rest' | 'revise_commitment'
export type ResidentRole = 'customer' | 'shop_worker' | 'service_worker' | 'courier' | 'driver'
export type MobilityMode = 'stationary' | 'walk' | 'cycle' | 'drive' | 'transit'

export type ActionProposal = {
  action: PopulationAction
  target_id: string | null
  travel_class: TravelClass | null
  request_kind: 'delivery' | 'visit' | null
  duration_s: number
  text: string
  idempotency_key: string
  observation_refs: string[]
}

export type ActionIntent = ActionProposal & {
  run_id: string
  resident_id: string
  epoch: number
  world_version: number
  effective_t: number
  expires_t: number
}

export type ResidentDecision = {
  proposal: ActionProposal
  summary: string
  plan: string[]
  beliefs: string[]
}

export type BrainAssignment = {
  model_family: string
  model_id: string
  api_provider: string
  config_ref: string
  control_mode: 'jiuwenswarm' | 'rules'
  color: string | null
}

export type PopulationBudget = {
  max_concurrency: number
  max_iterations: number
  decision_timeout_s: number
  max_calls: number
  max_tokens: number
  max_output_tokens: number
  max_cost_usd: number
  requests_per_minute: number
  tokens_per_minute: number
}

export type AnchorAccess = { edge_id: string; position_m: number; lane_index: number }

export type ActivityAnchor = {
  anchor_id: string
  name: string
  purpose: 'home' | 'shop' | 'service' | 'work' | 'rest'
  lon: number
  lat: number
  access: Partial<Record<TravelClass, AnchorAccess>>
  capacity: number
  opens_s: number
  closes_s: number
  service_duration_s: number
  synthetic: true
}

export type RoutineStep = { activity: 'work' | 'errand' | 'rest' | 'home'; anchor_id: string; earliest_s: number; duration_s: number }

export type ResidentProfile = {
  resident_id: string
  name: string
  persona: string
  roles: ResidentRole[]
  preferences: Record<string, number | string>
  home_anchor_id: string
  work_anchor_id: string | null
  contacts: string[]
  household_id: string
  organization_id: string | null
  available_classes: TravelClass[]
  carrying_capacity: number
  routine: RoutineStep[]
  synthetic: true
}

export type MemoryEntry = {
  event_id: string
  t: number
  kind: 'observation' | 'outcome' | 'message' | 'belief'
  text: string
  related_residents: string[]
}

export type ResidentState = {
  resident_id: string
  role: ResidentRole
  activity: 'idle' | 'traveling' | 'working' | 'preparing' | 'serving' | 'waiting' | 'resting'
  anchor_id: string | null
  destination_id: string | null
  mobility_mode: MobilityMode
  travel_class: TravelClass | null
  needs: Record<string, number>
  commitments: string[]
  current_task_id: string | null
  plan: string[]
  beliefs: string[]
  memories: MemoryEntry[]
  relationships: Record<string, number>
  vehicle_locations: Partial<Record<TravelClass, string>>
  busy_until_s: number
  next_decision_s: number
  next_need_s: number
  last_decision_s: number | null
  fallback_reason: string | null
  version: number
}

export type SocietyTask = {
  task_id: string
  kind: 'delivery' | 'visit'
  requester_id: string
  service_anchor_id: string
  destination_anchor_id: string
  status: 'requested' | 'accepted' | 'preparing' | 'ready' | 'assigned' | 'picked_up' | 'serving' | 'completed' | 'declined' | 'failed' | 'expired'
  provider_id: string | null
  assignee_id: string | null
  required_capacity: number
  created_s: number
  deadline_s: number
  ready_s: number | null
  completed_s: number | null
  failure_reason: string | null
  declined_by: string[]
  version: number
  cause_id: string | null
}

export type PopulationSpec = {
  generator_version: 'society-v1'
  rules_version: 'service-ledger-v1'
  pack_id: string
  seed: number
  count: number
  horizon_s: number
  enabled_classes: TravelClass[]
  brains: BrainAssignment[]
  budget: PopulationBudget
  recurring_need_s: number
  service_duration_s: number
  decision_interval_s: number
  district_radius_m: number
}

export type PopulationDefinition = {
  population_id: string
  spec: PopulationSpec
  network_fingerprint: string
  anchors: ActivityAnchor[]
  profiles: ResidentProfile[]
  initial_states: ResidentState[]
  initial_tasks: SocietyTask[]
  assignments: Record<string, BrainAssignment>
  assumptions: string[]
}

export type MobilityBinding = {
  resident_id: string
  entity_id: string | null
  mode: MobilityMode
  vehicle_class: string | null
  anchor_id: string | null
  start_s: number
  end_s: number | null
  ownership: 'resident' | 'shared' | 'abstract'
  measured: boolean
  capacity: number
}

export type SwarmBinding = {
  resident_id: string
  run_id: string
  team_id: string
  workflow_id: string
  session_id: string
  worker_id: string
  requested_model_id: string
  resolved_model_id: string
  bound_s?: number
  generation: number
  restored: boolean
}

export type PopulationEvent = {
  event_id: string
  t: number
  epoch: number
  kind: string
  resident_ids: string[]
  task_id: string | null
  cause_id: string | null
  text: string
  status: 'proposed' | 'committed' | 'observed'
}

export type SocialMessage = {
  message_id: string
  sender_id: string
  recipient_id: string
  sent_s: number
  delivered_s: number | null
  text: string
  task_id: string | null
  cause_id: string | null
}

export type PopulationDecisionRecord = {
  decision_id: string
  resident_id: string
  t: number
  epoch: number
  source: 'jiuwenswarm' | 'rules' | 'fallback'
  assigned_model_id: string
  actual_model_id: string | null
  summary: string
  proposal: ActionIntent | null
  accepted: boolean
  reason: string
  plan: string[]
  beliefs: string[]
  outcome_event_ids: string[]
  fallback_reason: string | null
  latency_ms: number
  usage: Record<string, number | string>
}

export type ResidentSnapshot = { t: number; state: ResidentState }
export type TaskSnapshot = { t: number; task: SocietyTask }

export type PopulationMetrics = {
  version: 'population-1'
  resident_count: number
  horizon_s: number
  end_time_s: number
  task_status_counts: Record<string, number>
  completed_deliveries: number
  completed_visits: number
  outstanding_needs: number
  outstanding_commitments: number
  accepted_actions: number
  rejected_actions: number
  decision_source_counts: Record<string, number>
  memory_entries: number
  delivered_messages: number
  completed_trips: number
  failed_trips: number
  calls: number
  tokens: number
  cost_usd: number
  reserved_cost_usd: number
  artifact_bytes: number
  wall_time_s: number
  warnings: string[]
}

export type PopulationArtifact = {
  version: 'population-1'
  run_id: string
  attempt_id: string
  definition: PopulationDefinition
  states: ResidentSnapshot[]
  tasks: TaskSnapshot[]
  decisions: PopulationDecisionRecord[]
  messages: SocialMessage[]
  events: PopulationEvent[]
  mobility_bindings: MobilityBinding[]
  swarm_bindings: SwarmBinding[]
  metrics: PopulationMetrics
}

export type PopulationSessionBudget = {
  session_limit_microdollars: number
  accounted_microdollars?: number
  remaining_microdollars?: number
  request_count?: number
  blocked: boolean
}

export type PopulationStatus = {
  available: boolean
  reason: string | null
  models: BrainAssignment[]
  budget: PopulationSessionBudget
  native_proof_required?: boolean
  initial_scale_gate?: number
}
