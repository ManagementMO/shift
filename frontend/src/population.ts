import type { ActivityAnchor, BrainAssignment, EntityTrack, MobilityBinding, PopulationArtifact, PopulationDecisionRecord, PopulationDefinition, PopulationEvent, ResidentProfile, ResidentState, SocialMessage, SocietyTask, SwarmBinding } from './types'

export type BrainColor = [number, number, number]
export const NEUTRAL_BRAIN_COLOR: BrainColor = [154, 160, 168]

export function brainColor(assignment: BrainAssignment | null | undefined): BrainColor {
  if (!assignment) return NEUTRAL_BRAIN_COLOR
  const family = assignment.model_family.toLowerCase()
  if (family.includes('claude') || family === 'anthropic') return [232, 139, 73]
  if (family.includes('openai') || family === 'gpt') return [48, 166, 115]
  if (assignment.color && /^#[0-9a-fA-F]{6}$/.test(assignment.color)) return [1, 3, 5].map((i) => parseInt(assignment.color!.slice(i, i + 2), 16)) as BrainColor
  return [131, 118, 195]
}

type Timed<T> = { t: number; value: T }
export type Timeline<T> = { times: number[]; values: T[] }

function timeline<T>(items: Timed<T>[]): Timeline<T> {
  const ordered = [...items].sort((a, b) => a.t - b.t)
  return { times: ordered.map((v) => v.t), values: ordered.map((v) => v.value) }
}

function lastIndex(times: number[], t: number): number {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (times[mid] <= t) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

function at<T>(series: Timeline<T> | undefined, t: number): T | null {
  return series ? series.values[lastIndex(series.times, t)] ?? null : null
}

function through<T>(series: Timeline<T> | undefined, t: number, limit = Infinity): T[] {
  if (!series) return []
  const end = lastIndex(series.times, t) + 1
  return series.values.slice(Math.max(0, end - limit), end)
}

function grouped<T>(items: T[], key: (v: T) => string[], time: (v: T) => number): Record<string, Timeline<T>> {
  const groups = new Map<string, Timed<T>[]>()
  for (const value of items) for (const id of new Set(key(value))) {
    const rows = groups.get(id) ?? []
    rows.push({ t: time(value), value })
    groups.set(id, rows)
  }
  return Object.fromEntries([...groups].map(([id, rows]) => [id, timeline(rows)]))
}

export const abstractEntityId = (residentId: string): string => `abstract:${residentId}`

function intervalGroups(bindings: MobilityBinding[], key: (b: MobilityBinding) => string | null): Record<string, Timeline<MobilityBinding[]>> {
  const groups = new Map<string, Map<number, { add: MobilityBinding[]; remove: MobilityBinding[] }>>()
  for (const b of bindings) {
    const id = key(b)
    if (!id || b.end_s === b.start_s) continue
    const changes = groups.get(id) ?? new Map()
    const start = changes.get(b.start_s) ?? { add: [], remove: [] }
    start.add.push(b)
    changes.set(b.start_s, start)
    if (b.end_s !== null) {
      const end = changes.get(b.end_s) ?? { add: [], remove: [] }
      end.remove.push(b)
      changes.set(b.end_s, end)
    }
    groups.set(id, changes)
  }
  return Object.fromEntries([...groups].map(([id, changes]) => {
    const active = new Set<MobilityBinding>()
    const rows: Timed<MobilityBinding[]>[] = []
    for (const [t, change] of [...changes].sort(([a], [b]) => a - b)) {
      change.remove.forEach((b) => active.delete(b))
      change.add.forEach((b) => active.add(b))
      rows.push({ t, value: [...active] })
    }
    return [id, timeline(rows)]
  }))
}

export type PopulationIndex = {
  artifact: PopulationArtifact | null
  definition: PopulationDefinition
  profiles: Record<string, ResidentProfile>
  anchors: Record<string, ActivityAnchor>
  assignments: Record<string, BrainAssignment>
  states: Record<string, Timeline<ResidentState>>
  tasks: Record<string, Timeline<SocietyTask>>
  taskIdsByResident: Record<string, Set<string>>
  taskIdsByAnchor: Record<string, Set<string>>
  deliveryTaskIds: Set<string>
  decisions: Record<string, Timeline<PopulationDecisionRecord>>
  sentMessages: Record<string, Timeline<SocialMessage>>
  receivedMessages: Record<string, Timeline<SocialMessage>>
  events: Record<string, Timeline<PopulationEvent>>
  eventById: Record<string, PopulationEvent>
  residentBindings: Record<string, Timeline<MobilityBinding[]>>
  entityBindings: Record<string, Timeline<MobilityBinding[]>>
  swarmBindings: Record<string, Timeline<SwarmBinding>>
  legacySwarmBindings: Record<string, SwarmBinding[]>
}

export function buildDefinitionIndex(definition: PopulationDefinition, artifact: PopulationArtifact | null = null): PopulationIndex {
  const stateRows = [
    ...definition.initial_states.map((state) => ({ t: 0, state })),
    ...(artifact?.states ?? []),
  ]
  const taskRows = [
    ...definition.initial_tasks.map((task) => ({ t: task.created_s, task })),
    ...(artifact?.tasks ?? []),
  ]
  const taskIds = new Map<string, Set<string>>()
  const anchorTaskIds = new Map<string, Set<string>>()
  const deliveryTaskIds = new Set<string>()
  for (const { task } of taskRows) {
    for (const id of [task.requester_id, task.provider_id, task.assignee_id]) {
      if (!id) continue
      const ids = taskIds.get(id) ?? new Set<string>()
      ids.add(task.task_id)
      taskIds.set(id, ids)
    }
    const ids = anchorTaskIds.get(task.service_anchor_id) ?? new Set<string>()
    ids.add(task.task_id)
    anchorTaskIds.set(task.service_anchor_id, ids)
    if (task.kind === 'delivery') deliveryTaskIds.add(task.task_id)
  }
  const states = grouped(stateRows, (v) => [v.state.resident_id], (v) => v.t)
  const tasks = grouped(taskRows, (v) => [v.task.task_id], (v) => Math.max(v.t, v.task.created_s))
  const bindings = artifact?.mobility_bindings ?? []
  const legacySwarmBindings: Record<string, SwarmBinding[]> = Object.create(null)
  const timedSwarmBindings: SwarmBinding[] = []
  for (const b of artifact?.swarm_bindings ?? []) {
    if (b.bound_s === undefined) (legacySwarmBindings[b.resident_id] ??= []).push(b)
    else timedSwarmBindings.push(b)
  }
  timedSwarmBindings.sort((a, b) => a.bound_s! - b.bound_s! || a.generation - b.generation)
  return {
    artifact, definition, profiles: Object.fromEntries(definition.profiles.map((p) => [p.resident_id, p])), anchors: Object.fromEntries(definition.anchors.map((a) => [a.anchor_id, a])),
    assignments: definition.assignments,
    states: Object.fromEntries(Object.entries(states).map(([id, s]) => [id, { times: s.times, values: s.values.map((v) => v.state) }])),
    tasks: Object.fromEntries(Object.entries(tasks).map(([id, s]) => [id, { times: s.times, values: s.values.map((v) => v.task) }])),
    taskIdsByResident: Object.fromEntries(taskIds), taskIdsByAnchor: Object.fromEntries(anchorTaskIds), deliveryTaskIds,
    decisions: grouped(artifact?.decisions ?? [], (d) => [d.resident_id], (d) => d.t),
    sentMessages: grouped(artifact?.messages ?? [], (m) => [m.sender_id], (m) => m.sent_s),
    receivedMessages: grouped((artifact?.messages ?? []).filter((m) => m.delivered_s !== null), (m) => [m.recipient_id], (m) => Math.max(m.sent_s, m.delivered_s!)),
    events: grouped(artifact?.events ?? [], (e) => e.resident_ids, (e) => e.t),
    eventById: Object.fromEntries((artifact?.events ?? []).map((e) => [e.event_id, e])),
    residentBindings: intervalGroups(bindings, (b) => b.resident_id),
    entityBindings: intervalGroups(bindings, (b) => b.ownership === 'abstract' ? abstractEntityId(b.resident_id) : b.entity_id),
    swarmBindings: grouped(timedSwarmBindings, (b) => [b.resident_id], (b) => b.bound_s!),
    legacySwarmBindings,
  }
}

export function buildPopulationIndex(artifact: PopulationArtifact): PopulationIndex {
  return buildDefinitionIndex(artifact.definition, artifact)
}

export function residentStateAt(p: PopulationIndex, id: string, t: number): ResidentState | null {
  const state = at(p.states[id], t)
  if (!state) return null
  return {
    ...state,
    memories: state.memories.filter((m) => m.t <= t),
    commitments: state.commitments.filter((taskId) => taskAt(p, taskId, t) !== null),
    current_task_id: state.current_task_id && taskAt(p, state.current_task_id, t) ? state.current_task_id : null,
    last_decision_s: state.last_decision_s !== null && state.last_decision_s <= t ? state.last_decision_s : null,
  }
}

export function taskAt(p: PopulationIndex, id: string, t: number): SocietyTask | null {
  const task = at(p.tasks[id], t)
  if (!task || task.created_s > t) return null
  return { ...task, ready_s: task.ready_s !== null && task.ready_s <= t ? task.ready_s : null, completed_s: task.completed_s !== null && task.completed_s <= t ? task.completed_s : null }
}

export function visibleTasksAt(p: PopulationIndex, residentId: string, t: number): SocietyTask[] {
  const profile = p.profiles[residentId]
  if (!profile) return []
  const courier = profile.roles.some((role) => role === 'courier' || role === 'driver')
  const service = profile.roles.some((role) => role === 'shop_worker' || role === 'service_worker')
  const candidates = new Set([
    ...(p.taskIdsByResident[residentId] ?? []),
    ...(service && profile.work_anchor_id ? p.taskIdsByAnchor[profile.work_anchor_id] ?? [] : []),
    ...(courier ? p.deliveryTaskIds : []),
  ])
  const visible: SocietyTask[] = []
  for (const id of candidates) {
    const task = taskAt(p, id, t)
    if (!task) continue
    const own = [task.requester_id, task.provider_id, task.assignee_id].includes(residentId)
    const publicTask = !['completed', 'declined', 'failed', 'expired'].includes(task.status) && (
      (profile.work_anchor_id === task.service_anchor_id && ((task.kind === 'delivery' && profile.roles.includes('shop_worker')) || (task.kind === 'visit' && profile.roles.includes('service_worker')))) ||
      (courier && task.kind === 'delivery' && task.status === 'ready')
    )
    if (own || publicTask) visible.push(task)
  }
  return visible.sort((a, b) => a.created_s - b.created_s || a.task_id.localeCompare(b.task_id)).slice(-32)
}

export function bindingAt(p: PopulationIndex, residentId: string, t: number): MobilityBinding | null {
  const active = at(p.residentBindings[residentId], t)
  return active?.length === 1 ? active[0] : null
}

export function bindingsForEntityAt(p: PopulationIndex, entityId: string, t: number): MobilityBinding[] {
  return at(p.entityBindings[entityId], t) ?? []
}

export function residentForEntityAt(p: PopulationIndex, entityId: string, t: number): string | null {
  const active = bindingsForEntityAt(p, entityId, t)
  if (active.length !== 1 || active[0].ownership === 'shared') return null
  const b = active[0]
  return bindingAt(p, b.resident_id, t) === b ? b.resident_id : null
}

export function populationColorAt(p: PopulationIndex, entityId: string, t: number): BrainColor {
  const id = residentForEntityAt(p, entityId, t)
  return id ? brainColor(p.assignments[id]) : NEUTRAL_BRAIN_COLOR
}

export function populationTrackVisible(p: PopulationIndex, track: EntityTrack, t: number): boolean {
  const bindings = p.entityBindings[track.entity_id]
  if (!bindings) return !track.resident_id
  return (at(bindings, t) ?? []).some((b) => b.measured && b.ownership !== 'abstract' && bindingAt(p, b.resident_id, t) === b)
}

export type AbstractPresence = {
  id: string
  kind: 'person'
  residentId: string
  anchorId: string
  lon: number
  lat: number
  angle: number
  speed: number
  ownership: 'abstract'
  measured: false
}

export function stationaryPresenceAt(p: PopulationIndex, t: number): AbstractPresence[] {
  const out: AbstractPresence[] = []
  for (const id of Object.keys(p.profiles)) {
    const binding = bindingAt(p, id, t)
    if (!binding || binding.ownership !== 'abstract' || binding.mode !== 'stationary' || binding.measured || !binding.anchor_id) continue
    const anchor = p.anchors[binding.anchor_id]
    if (!anchor) continue
    out.push({ id: abstractEntityId(id), kind: 'person', residentId: id, anchorId: anchor.anchor_id, lon: anchor.lon, lat: anchor.lat, angle: 0, speed: 0, ownership: 'abstract', measured: false })
  }
  return out
}

export function swarmBindingAt(p: PopulationIndex, residentId: string, t: number): SwarmBinding | null {
  return at(p.swarmBindings[residentId], t)
}

export function decisionProvenance(assignment: BrainAssignment | undefined, decision: PopulationDecisionRecord | null) {
  return {
    assignedModel: assignment?.model_id ?? decision?.assigned_model_id ?? null,
    assignedFamily: assignment?.model_family ?? null,
    controlMode: assignment?.control_mode ?? null,
    apiProvider: assignment?.api_provider ?? null,
    source: decision?.source ?? 'none',
    actualModel: decision?.actual_model_id ?? null,
    fallbackReason: decision?.fallback_reason ?? null,
  }
}

export function residentViewAt(p: PopulationIndex, id: string, t: number, historyLimit = 30) {
  const profile = p.profiles[id]
  if (!profile) return null
  const state = residentStateAt(p, id, t)
  const tasks = visibleTasksAt(p, id, t)
  const decisions = through(p.decisions[id], t, historyLimit).map((d) => ({ ...d, outcome_event_ids: d.outcome_event_ids.filter((eid) => p.eventById[eid]?.t <= t) }))
  const decision = decisions.at(-1) ?? null
  const events = through(p.events[id], t, historyLimit)
  const outcomes = events.filter((e) => e.status === 'observed')
  const visibleMessage = (m: SocialMessage): SocialMessage => ({ ...m, delivered_s: m.delivered_s !== null && m.delivered_s <= t ? m.delivered_s : null })
  return {
    profile, assignment: p.assignments[id], state, tasks, decisions, decision, events, outcomes,
    binding: bindingAt(p, id, t),
    sentMessages: through(p.sentMessages[id], t, historyLimit).map(visibleMessage),
    receivedMessages: through(p.receivedMessages[id], t, historyLimit).map(visibleMessage),
    swarmBinding: swarmBindingAt(p, id, t),
    swarmBindings: through(p.swarmBindings[id], t, historyLimit),
    legacySwarmBindings: p.legacySwarmBindings[id] ?? [],
    provenance: decisionProvenance(p.assignments[id], decision),
  }
}

export function populationSummaryAt(p: PopulationIndex, t: number) {
  let moving = 0
  let working = 0
  let stationary = 0
  let commitments = 0
  for (const id of Object.keys(p.profiles)) {
    const s = at(p.states[id], t)
    if (!s) continue
    if (s.mobility_mode !== 'stationary') moving++
    else stationary++
    if (['working', 'preparing', 'serving'].includes(s.activity)) working++
    commitments += s.commitments.length
  }
  const tasks = Object.keys(p.tasks).map((id) => taskAt(p, id, t)).filter((task): task is SocietyTask => task !== null)
  return { residents: p.definition.profiles.length, moving, working, stationary, commitments, tasks: tasks.length, completed: tasks.filter((task) => task.status === 'completed').length }
}
