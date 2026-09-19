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
  authored_by: 'baseline' | 'heuristic' | 'agent' | 'user' | 'revision'
  rationale: string
  assumptions: string[]
  parent_plan_id: string | null
}

export type ValidationIssue = { code: string; severity: 'hard' | 'soft' | 'unknown'; message: string; refs: string[] }
export type ValidationReport = { plan_id: string; valid: boolean; issues: ValidationIssue[] }

export type PlanWithValidation = { plan: ServicePlan; validation: ValidationReport | null }

export type RunStatus = 'draft' | 'validated' | 'queued' | 'running' | 'completed' | 'invalid' | 'failed' | 'canceled'

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
  kind: 'bus' | 'car' | 'person'
  samples: number[][] // [t, lon, lat, angle, speed]
  breaks: number[]
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
  status: 'queued' | 'running' | 'completed' | 'failed'
  engine: string
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

export type Renderer = 'babylon' | 'mapbox'
