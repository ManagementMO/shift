import type { Kind } from '../babylon/traffic'
import type { Development, DevelopmentSpec } from '../types'
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

export type Hazard = 'crash' | 'fire' | 'flood' | 'tornado' | 'gas_leak' | 'rain' | 'storm'
export const HAZARDS: { id: Hazard; label: string; blocks: string; detail: string }[] = [
  { id: 'crash', label: 'Vehicle collision', blocks: 'Cars and buses', detail: 'Streets inside the footprint close to traffic. Sidewalks stay open.' },
  { id: 'fire', label: 'Building fire', blocks: 'Everyone', detail: 'People inside leave for the nearest street outside; informed walkers detour.' },
  { id: 'flood', label: 'Flash flood', blocks: 'Everyone', detail: 'Streets and sidewalks stay impassable until the water recedes.' },
  { id: 'tornado', label: 'Tornado', blocks: 'Everyone', detail: 'A wide warning radius: many witnesses, fast word of mouth.' },
  { id: 'gas_leak', label: 'Gas leak', blocks: 'Everyone', detail: 'The footprint is evacuated and closed to all traffic.' },
  { id: 'rain', label: 'Heavy rain', blocks: 'Nothing', detail: 'Streets stay open under the downpour; people inside see it and pass it on.' },
  { id: 'storm', label: 'Storm', blocks: 'Cars and buses', detail: 'Streets inside the footprint close to traffic until the storm passes. Sidewalks stay open.' },
]

export type Intervention =
  | { kind: 'close_road' | 'reopen_road'; edge_ids: string[]; until_s?: number | null }
  | { kind: 'add_bus_route'; bus_id: string; stop_ids: string[] }
  | { kind: 'temperature'; temperature_c: number }
  | { kind: 'population'; count: number; destination_zone_id: string; origin_zone_id?: string | null; release_window_s: number }
  | { kind: 'incident'; hazard: Hazard; lon: number; lat: number; radius_m: number; duration_s?: number | null; label?: string | null }
  /** A building placed in the running city: its trips are generated from the placement and inserted live. */
  | { kind: 'development'; spec: DevelopmentSpec }
  /** Demolish a placed development: its travelers that have not set off yet are dropped, the rest finish their trips. */
  | { kind: 'remove_development'; development_id: string }

export interface LiveIncident {
  event_id: string
  command_id: string
  hazard: Hazard
  label: string
  x: number
  z: number
  radius_m: number
  alarm_radius_m: number
  start_s: number
  end_s: number
  blocks: string[]
  edge_ids: string[]
  active: boolean
}

export interface SwarmMetrics {
  events: { event_id: string; hazard: Hazard; label: string; radius_m: number; ended: boolean; aware: number; edges: number; start_s: number }[]
  witnessed: number
  messages: number
  aware_total: number
  by_hop: Record<string, number>
  responded: number
  in_zone: number
  broadcasts_last_step: number
  feed: { t: number; hop: number; text: string }[]
}

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
  swarm?: SwarmMetrics
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
  incidents?: LiveIncident[]
  /** Developments standing in the city (placed by `development` commands and not removed). */
  developments?: Development[]
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
  edges?: number
  alarm_radius_m?: number
  duration_s?: number
  blocks?: string[]
  mobility?: { walk_speed_factor: number; walk_tolerance_factor: number; road_speed_factor: number; model_version: string }
  /** development previews: the trips the building will add and how it reaches the street */
  added_trips?: number
  inbound_trips?: number
  outbound_trips?: number
  access?: Development['access']
}
