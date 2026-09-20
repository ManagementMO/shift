import type { Kind } from '../babylon/traffic'
import type { LiveCounts } from './frames'

export interface LiveConfig {
  pack_id: string
  seed: number
  horizon_s: number
  initial_population: number
  fleet_size: number
  temperature_c: number
  car_share: number
}

export type Intervention =
  | { kind: 'close_road' | 'reopen_road'; edge_ids: string[]; until_s?: number | null }
  | { kind: 'add_bus_route'; bus_id: string; stop_ids: string[] }
  | { kind: 'temperature'; temperature_c: number }
  | { kind: 'population'; count: number; destination_zone_id: string; origin_zone_id?: string | null; release_window_s: number }

export interface LiveCommand {
  command_id: string
  at_s: number
  expected_revision: number
  intervention: Intervention
}

export interface FleetEntry { id: string; capacity: number; assigned: boolean }
export interface LiveEntity {
  index: number
  id: string
  kind: Kind
  person_id?: string
  origin_edge?: string
  destination_edge?: string
  destination_zone_id?: string
  depart_s: number
  walk_limit_m?: number
  capacity?: number
  line?: string
}
export interface LiveRoute { bus_id: string; line: string; stop_ids: string[]; path: [number, number][] }
export interface LiveMetadata { entities: LiveEntity[]; routes: LiveRoute[]; fleet: FleetEntry[] }
export interface LiveMetrics {
  boardings: number
  waiting_person_minutes: number
  max_occupancy: Record<string, number>
  observed_agents: number
  peak_observed_agents: number
  stop_queues: Record<string, number>
  rerouted: number
  warnings: string[]
}

export interface LiveSession {
  session_id: string
  pack_id: string
  network_fingerprint: string
  config: LiveConfig
  parent_session_id: string | null
  fork_s: number | null
  time_s: number
  available_until_s: number
  horizon_s: number
  status: 'starting' | 'restoring' | 'paused' | 'running' | 'completed' | 'closed' | 'failed'
  revision: number
  temperature_c: number
  counts: LiveCounts
  commands: LiveCommand[]
  entity_count: number
  engine_version: string
  metrics?: LiveMetrics
  fleet?: FleetEntry[]
  closed_edge_ids?: string[]
  error: string | null
}

export interface LivePreview {
  title: string
  detail: string
  assumption: string
  at_s: number
  branches_history: boolean
  intervention: Intervention
  cohort_after?: number
  stop_names?: string[]
  mobility?: { walk_speed_factor: number; walk_tolerance_factor: number; road_speed_factor: number; model_version: string }
}
