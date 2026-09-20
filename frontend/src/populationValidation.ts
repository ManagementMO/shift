import type { PopulationArtifact, PopulationDefinition, PopulationStatus } from './types'

type Check = (value: unknown, path: string) => void

function invalid(path: string, expected: string): never {
  throw new Error(`Invalid population data at ${path}: expected ${expected}`)
}

const text: Check = (v, p) => { if (typeof v !== 'string') invalid(p, 'string') }
const bool: Check = (v, p) => { if (typeof v !== 'boolean') invalid(p, 'boolean') }
const number = (min = -Infinity, max = Infinity, whole = false): Check => (v, p) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (whole && !Number.isInteger(v))) invalid(p, `finite ${whole ? 'integer' : 'number'} in [${min}, ${max}]`)
}
const num = number()
const uint = number(0, Infinity, true)
const positive = number(1, Infinity, true)
const nullable = (check: Check): Check => (v, p) => { if (v !== null) check(v, p) }
const optional = (check: Check): Check => (v, p) => { if (v !== undefined) check(v, p) }
const enumeration = (...values: (string | boolean)[]): Check => (v, p) => {
  if (!values.includes(v as string)) invalid(p, values.join(' | '))
}
const list = (check: Check, min = 0, max = Infinity): Check => (v, p) => {
  if (!Array.isArray(v) || v.length < min || v.length > max) invalid(p, 'array')
  v.forEach((item, i) => check(item, `${p}[${i}]`))
}
function object(v: unknown, p: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) invalid(p, 'object')
  return v as Record<string, unknown>
}
const shape = (fields: Record<string, Check>): Check => (v, p) => {
  const value = object(v, p)
  for (const key of Object.keys(value)) if (!Object.hasOwn(fields, key)) invalid(`${p}.${key}`, 'known field')
  for (const [key, check] of Object.entries(fields)) check(Object.hasOwn(value, key) ? value[key] : undefined, `${p}.${key}`)
}
const dict = (check: Check, keyCheck?: Check): Check => (v, p) => {
  for (const [key, value] of Object.entries(object(v, p))) {
    keyCheck?.(key, `${p}.key`)
    check(value, `${p}.${key}`)
  }
}
const stringOrNumber: Check = (v, p) => { if (typeof v === 'string') text(v, p); else num(v, p) }
const pattern = (re: RegExp): Check => (v, p) => { text(v, p); if (!re.test(v as string)) invalid(p, 'matching string') }
const strings = list(text)
const optionalText = nullable(text)
const travelClass = enumeration('pedestrian', 'bicycle', 'passenger', 'delivery', 'truck')
const role = enumeration('customer', 'shop_worker', 'service_worker', 'courier', 'driver')
const mode = enumeration('stationary', 'walk', 'cycle', 'drive', 'transit')
const taskKind = enumeration('delivery', 'visit')
const brain = shape({ model_family: text, model_id: text, api_provider: text, config_ref: pattern(/^[a-zA-Z0-9_.-]+$/), control_mode: enumeration('jiuwenswarm', 'rules'), color: nullable(pattern(/^#[0-9a-fA-F]{6}$/)) })
const budgetFields = {
  max_concurrency: number(1, 16, true), max_iterations: number(1, 8, true), decision_timeout_s: number(1, 180, true), max_calls: number(0, 10000, true),
  max_tokens: number(0, 20000000, true), max_output_tokens: number(128, 2048, true), max_cost_usd: number(0, 20), requests_per_minute: number(1, 120, true), tokens_per_minute: number(1, 20000000, true),
}
const spec = shape({
  generator_version: enumeration('society-v1'), rules_version: enumeration('service-ledger-v1'), pack_id: pattern(/^[a-zA-Z0-9_-]+$/), seed: number(-Infinity, Infinity, true),
  count: number(5, 300, true), horizon_s: number(60, 14400, true), enabled_classes: list(travelClass, 1), brains: list(brain, 1, 12), budget: shape(budgetFields),
  recurring_need_s: number(120, 7200, true), service_duration_s: number(10, 1800, true), decision_interval_s: number(5, 120, true), district_radius_m: number(100, 2000),
})
const anchor = shape({
  anchor_id: text, name: text, purpose: enumeration('home', 'shop', 'service', 'work', 'rest'), lon: number(-180, 180), lat: number(-90, 90),
  access: dict(shape({ edge_id: text, position_m: number(0), lane_index: uint }), travelClass), capacity: number(1, 1000, true), opens_s: uint, closes_s: positive,
  service_duration_s: number(1, 3600, true), synthetic: enumeration(true),
})
const profile = shape({
  resident_id: text, name: text, persona: text, roles: list(role, 1), preferences: dict(stringOrNumber), home_anchor_id: text, work_anchor_id: optionalText,
  contacts: strings, household_id: text, organization_id: optionalText, available_classes: list(travelClass, 1), carrying_capacity: number(1, 100, true),
  routine: list(shape({ activity: enumeration('work', 'errand', 'rest', 'home'), anchor_id: text, earliest_s: uint, duration_s: positive })), synthetic: enumeration(true),
})
const memory = shape({ event_id: text, t: uint, kind: enumeration('observation', 'outcome', 'message', 'belief'), text, related_residents: strings })
const state = shape({
  resident_id: text, role, activity: enumeration('idle', 'traveling', 'working', 'preparing', 'serving', 'waiting', 'resting'), anchor_id: optionalText, destination_id: optionalText,
  mobility_mode: mode, travel_class: nullable(travelClass), needs: dict(num), commitments: strings, current_task_id: optionalText, plan: strings, beliefs: strings,
  memories: list(memory), relationships: dict(num), vehicle_locations: dict(text, travelClass), busy_until_s: uint, next_decision_s: uint, next_need_s: positive,
  last_decision_s: nullable(number(-Infinity, Infinity, true)), fallback_reason: optionalText, version: uint,
})
const task = shape({
  task_id: text, kind: taskKind, requester_id: text, service_anchor_id: text, destination_anchor_id: text,
  status: enumeration('requested', 'accepted', 'preparing', 'ready', 'assigned', 'picked_up', 'serving', 'completed', 'declined', 'failed', 'expired'),
  provider_id: optionalText, assignee_id: optionalText, required_capacity: positive, created_s: uint, deadline_s: positive, ready_s: nullable(num), completed_s: nullable(num),
  failure_reason: optionalText, declined_by: strings, version: uint, cause_id: optionalText,
})
const definition = shape({
  population_id: text, spec, network_fingerprint: text, anchors: list(anchor), profiles: list(profile), initial_states: list(state), initial_tasks: list(task), assignments: dict(brain), assumptions: strings,
})
const intent = shape({
  action: enumeration('request_service', 'accept', 'decline', 'travel', 'prepare', 'pickup', 'deliver', 'visit', 'serve', 'report_delay', 'message', 'wait', 'rest', 'revise_commitment'),
  target_id: optionalText, travel_class: nullable(travelClass), request_kind: nullable(taskKind), duration_s: number(1, 3600, true), text,
  idempotency_key: pattern(/^[a-zA-Z0-9_.:-]+$/), observation_refs: list(text, 0, 32), run_id: text, resident_id: text, epoch: uint, world_version: uint, effective_t: uint, expires_t: uint,
})
const decision = shape({
  decision_id: text, resident_id: text, t: uint, epoch: uint, source: enumeration('jiuwenswarm', 'rules', 'fallback'), assigned_model_id: text, actual_model_id: optionalText,
  summary: text, proposal: nullable(intent), accepted: bool, reason: text, plan: strings, beliefs: strings, outcome_event_ids: strings, fallback_reason: optionalText, latency_ms: uint, usage: dict(stringOrNumber),
})
const message = shape({ message_id: text, sender_id: text, recipient_id: text, sent_s: uint, delivered_s: nullable(num), text, task_id: optionalText, cause_id: optionalText })
const event = shape({ event_id: text, t: uint, epoch: uint, kind: text, resident_ids: strings, task_id: optionalText, cause_id: optionalText, text, status: enumeration('proposed', 'committed', 'observed') })
const mobility = shape({ resident_id: text, entity_id: optionalText, mode, vehicle_class: optionalText, anchor_id: optionalText, start_s: uint, end_s: nullable(uint), ownership: enumeration('resident', 'shared', 'abstract'), measured: bool, capacity: positive })
const swarm = shape({ resident_id: text, run_id: text, team_id: text, workflow_id: text, session_id: text, worker_id: text, requested_model_id: text, resolved_model_id: text, bound_s: optional(number(0)), generation: uint, restored: bool })
const metrics = shape({
  version: enumeration('population-1'), resident_count: num, horizon_s: num, end_time_s: num, task_status_counts: dict(num), completed_deliveries: num, completed_visits: num,
  outstanding_needs: num, outstanding_commitments: num, accepted_actions: num, rejected_actions: num, decision_source_counts: dict(num), memory_entries: num, delivered_messages: num,
  completed_trips: num, failed_trips: num, calls: num, tokens: num, cost_usd: num, reserved_cost_usd: num, artifact_bytes: num, wall_time_s: num, warnings: strings,
})
const stimulus = shape({
  stimulus_id: pattern(/^[a-zA-Z0-9_.:-]+$/), kind: enumeration('incident', 'temperature', 'announcement'), text,
  lon: optional(nullable(number(-180, 180))), lat: optional(nullable(number(-90, 90))), radius_m: optional(nullable(number(1, 5000))),
  hazard: optional(nullable(enumeration('crash', 'fire', 'flood', 'tornado', 'gas_leak', 'rain', 'storm'))),
  temperature_c: optional(nullable(number(-100, 100))), duration_s: number(30, 14400, true),
})
const artifact = shape({
  version: enumeration('population-1'), run_id: text, attempt_id: text, definition, states: list(shape({ t: uint, state })), tasks: list(shape({ t: uint, task })),
  decisions: list(decision), messages: list(message), events: list(event), mobility_bindings: list(mobility), swarm_bindings: list(swarm), metrics,
  stimuli: optional(list(shape({ stimulus, applied_s: uint, resident_ids: strings }))),
})

function checkDefinition(d: PopulationDefinition): void {
  const ids = new Set(d.profiles.map((p) => p.resident_id))
  const anchors = new Set(d.anchors.map((a) => a.anchor_id))
  if (ids.size !== d.profiles.length) invalid('definition.profiles', 'unique resident IDs')
  if (anchors.size !== d.anchors.length) invalid('definition.anchors', 'unique anchor IDs')
  if (!d.spec.enabled_classes.includes('pedestrian') || new Set(d.spec.enabled_classes).size !== d.spec.enabled_classes.length) invalid('definition.spec.enabled_classes', 'unique classes with pedestrian access')
  if (new Set(d.spec.brains.map((b) => b.config_ref)).size !== d.spec.brains.length || new Set(d.spec.brains.map((b) => b.control_mode)).size !== 1) invalid('definition.spec.brains', 'unique references and one control mode')
  for (const a of d.anchors) if (!a.access.pedestrian || a.opens_s >= a.closes_s) invalid('definition.anchors', 'pedestrian access and valid availability window')
  for (const p of d.profiles) {
    if (!d.assignments[p.resident_id]) invalid('definition.assignments', `assignment for resident ${p.resident_id}`)
    if (!anchors.has(p.home_anchor_id)) invalid('definition.profiles.home_anchor_id', 'declared anchor')
  }
  for (const s of d.initial_states) if (!ids.has(s.resident_id)) invalid('definition.initial_states', 'declared resident')
}

export function parsePopulationDefinition(value: unknown): PopulationDefinition {
  definition(value, 'definition')
  const result = value as PopulationDefinition
  checkDefinition(result)
  return result
}

export function parsePopulationArtifact(value: unknown): PopulationArtifact {
  artifact(value, 'population')
  const result = value as PopulationArtifact
  checkDefinition(result.definition)
  const ids = new Set(result.definition.profiles.map((p) => p.resident_id))
  const anchors = new Set(result.definition.anchors.map((a) => a.anchor_id))
  for (const snapshot of result.states) if (!ids.has(snapshot.state.resident_id)) invalid('population.states.state.resident_id', 'declared resident')
  for (const b of result.mobility_bindings) {
    if (!ids.has(b.resident_id)) invalid('population.mobility_bindings.resident_id', 'declared resident')
    if (b.end_s !== null && b.end_s < b.start_s) invalid('population.mobility_bindings.end_s', 'end at or after start')
    if (b.mode === 'stationary' && (b.measured || !b.anchor_id || !anchors.has(b.anchor_id))) invalid('population.mobility_bindings', 'stationary abstract presence at a declared anchor')
    if (b.ownership === 'abstract' && (b.measured || b.mode !== 'stationary' || !b.anchor_id || !anchors.has(b.anchor_id))) invalid('population.mobility_bindings', 'unmeasured stationary abstract presence')
  }
  for (const b of result.swarm_bindings) {
    if (!ids.has(b.resident_id) || b.run_id !== result.run_id) invalid('population.swarm_bindings', 'matching run and declared resident')
  }
  for (const d of result.decisions) {
    if (!ids.has(d.resident_id)) invalid('population.decisions.resident_id', 'declared resident')
    if (d.proposal && (d.proposal.run_id !== result.run_id || d.proposal.resident_id !== d.resident_id || d.proposal.expires_t < d.proposal.effective_t)) invalid('population.decisions.proposal', 'matching actor/run and valid time window')
  }
  return result
}

export function parsePopulationStatus(value: unknown): PopulationStatus {
  shape({
    available: bool, reason: optionalText, models: list(brain),
    budget: shape({ session_limit_microdollars: uint, accounted_microdollars: optional(uint), remaining_microdollars: optional(uint), request_count: optional(uint), blocked: bool }),
    native_proof_required: optional(bool), initial_scale_gate: optional(positive),
    admission: optional(shape({ request_reservation_microdollars: dict(uint), max_output_tokens: positive })),
  })(value, 'population status')
  return value as PopulationStatus
}
