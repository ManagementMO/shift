// Replay indexing: every rendered position comes from a stored TraCI sample; gaps are never interpolated
// across a recorded break (teleport) or beyond MAX_GAP_S.

import type { EntityTrack, HazardTrack, PersonEvent, RunBundle, ScenarioSpec } from './types'

export const MAX_GAP_S = 3
const ACTIVITY_START_FRACTION = 0.25

export type PersonState = 'not_departed' | 'walking' | 'waiting' | 'riding' | 'arrived' | 'unroutable' | 'driving'

export type EntityAt = {
  id: string
  kind: 'bus' | 'car' | 'person'
  lon: number
  lat: number
  angle: number
  speed: number
  occupancy?: number
  state?: PersonState
}

export type TrackIndex = {
  track: EntityTrack
  times: number[]
  breakSet: Set<number>
}

export type ReplayIndex = {
  bundle: RunBundle
  tracks: Record<string, TrackIndex>
  personEvents: Record<string, PersonEvent[]>
  occupancy: Record<string, { times: number[]; values: number[] }>
  stopQueue: Record<string, { times: number[]; values: number[] }>
  tMax: number
  activityStart: number
}

function lowerBound(arr: number[], t: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] <= t) lo = mid + 1
    else hi = mid
  }
  return lo - 1 // index of last element <= t, or -1
}

export function buildIndex(bundle: RunBundle): ReplayIndex {
  const tracks: Record<string, TrackIndex> = {}
  const movingAtTime = new Map<number, number>()
  let peakMoving = 0
  let tMax = bundle.run.metrics?.horizon_s ?? 0
  for (const [id, tr] of Object.entries(bundle.tracks)) {
    const times = tr.samples.map((s) => {
      if (s[4] > 0.1) {
        const moving = (movingAtTime.get(s[0]) ?? 0) + 1
        movingAtTime.set(s[0], moving)
        peakMoving = Math.max(peakMoving, moving)
      }
      return s[0]
    })
    if (times.length) tMax = Math.max(tMax, times[times.length - 1])
    tracks[id] = { track: tr, times, breakSet: new Set(tr.breaks) }
  }
  const personEvents: Record<string, PersonEvent[]> = {}
  for (const e of bundle.events) (personEvents[e.person_id] ??= []).push(e)
  for (const list of Object.values(personEvents)) list.sort((a, b) => a.t - b.t)
  const series = (src: Record<string, [number, number][]>) => {
    const out: Record<string, { times: number[]; values: number[] }> = {}
    for (const [k, rows] of Object.entries(src)) out[k] = { times: rows.map((r) => r[0]), values: rows.map((r) => r[1]) }
    return out
  }
  const threshold = Math.max(1, Math.ceil(peakMoving * ACTIVITY_START_FRACTION))
  let activityStart = Infinity
  for (const [t, moving] of movingAtTime) if (moving >= threshold && t < tMax) activityStart = Math.min(activityStart, t)
  return { bundle, tracks, personEvents, occupancy: series(bundle.occupancy), stopQueue: series(bundle.stopQueue), tMax, activityStart: Number.isFinite(activityStart) ? activityStart : 0 }
}

export function seriesAt(s: { times: number[]; values: number[] } | undefined, t: number): number | undefined {
  if (!s || !s.times.length) return undefined
  const i = lowerBound(s.times, t)
  return i < 0 ? undefined : s.values[i]
}

export function personStateAt(events: PersonEvent[] | undefined, t: number, mode?: string): PersonState {
  if (!events || !events.length) return 'not_departed'
  let state: PersonState = 'not_departed'
  for (const e of events) {
    if (e.t > t) break
    switch (e.event) {
      case 'unroutable':
        state = 'unroutable'
        break
      case 'depart':
        state = mode === 'car' || (e.vehicle_id ?? '').startsWith('car_') ? 'driving' : 'walking'
        break
      case 'wait_start':
        state = 'waiting'
        break
      case 'board':
        state = 'riding'
        break
      case 'alight':
        state = 'walking'
        break
      case 'arrive':
        state = 'arrived'
        break
    }
  }
  return state
}

/** Position of an entity at time t, or null if there is no valid sample (not inserted, arrived, gap, or break). */
/** Latest recorded sample `[t, lon, lat, angle, speed]` at or before `t`, or null if the entity is not on the map. */
export function positionAt(ix: TrackIndex, t: number): number[] | null {
  const i = lowerBound(ix.times, t)
  if (i < 0) return null
  const s = ix.track.samples[i]
  if (t - s[0] > MAX_GAP_S) return null
  return s
}

/** Measured `[lon, lat]` of an entity at `t`, or null. */
export function lonLatAt(ix: TrackIndex, t: number): [number, number] | null {
  const s = positionAt(ix, t)
  return s ? [s[1], s[2]] : null
}

/** Trail: contiguous samples in [t-window, t], split at recorded breaks and gaps. */
export function trailAt(ix: TrackIndex, t: number, windowS: number): number[][][] {
  const end = lowerBound(ix.times, t)
  if (end < 0) return []
  const start = Math.max(0, lowerBound(ix.times, t - windowS))
  const segs: number[][][] = []
  let cur: number[][] = []
  for (let i = start; i <= end; i++) {
    const s = ix.track.samples[i]
    if (ix.breakSet.has(i) || (cur.length && s[0] - cur[cur.length - 1][0] > MAX_GAP_S)) {
      if (cur.length > 1) segs.push(cur)
      cur = []
    }
    cur.push([s[1], s[2]])
  }
  if (cur.length > 1) segs.push(cur)
  return segs
}

export function entitiesAt(rx: ReplayIndex, t: number): EntityAt[] {
  const out: EntityAt[] = []
  const modes = rx.bundle.compile?.mode_assignment ?? {}
  for (const [id, ix] of Object.entries(rx.tracks)) {
    const s = positionAt(ix, t)
    if (!s) continue
    const kind = ix.track.kind
    const e: EntityAt = { id, kind, lon: s[1], lat: s[2], angle: s[3], speed: s[4] }
    if (kind === 'bus') e.occupancy = seriesAt(rx.occupancy[id], t) ?? 0
    if (kind === 'person') {
      e.state = personStateAt(rx.personEvents[id], t, modes[id])
      if (e.state === 'riding') continue // rendered as part of the bus; the person record still exists
    }
    out.push(e)
  }
  return out
}

export function cohortSummaryAt(rx: ReplayIndex, t: number): Record<PersonState, number> {
  const out: Record<PersonState, number> = {
    not_departed: 0, walking: 0, waiting: 0, riding: 0, arrived: 0, unroutable: 0, driving: 0,
  }
  const modes = rx.bundle.compile?.mode_assignment ?? {}
  for (const [pid, evs] of Object.entries(rx.personEvents)) out[personStateAt(evs, t, modes[pid])]++
  return out
}

export const STATE_COLORS: Record<PersonState, [number, number, number]> = {
  not_departed: [120, 120, 130],
  walking: [255, 200, 60],
  waiting: [255, 90, 60],
  riding: [80, 220, 255],
  arrived: [90, 230, 120],
  unroutable: [200, 60, 200],
  driving: [180, 180, 255],
}

export function fireSpreadProgress(h: Pick<HazardTrack, 'start_s' | 'end_s'>, t: number, preview = false, fraction = 0.6): number {
  if (preview) return 1
  if (!Number.isFinite(t) || t < h.start_s || t >= h.end_s) return 0
  const progress = Math.min(1, (t - h.start_s) / Math.max(1, (h.end_s - h.start_s) * fraction))
  return 0.08 + 0.92 * (1 - (1 - progress) ** 2)
}

type HazardFootprint = { center: [number, number]; rings: [number, number][][]; span_m: number }
const hazardCache = new WeakMap<HazardTrack, HazardFootprint>()

export function hazardFootprint(h: HazardTrack, t: number, preview = false): HazardFootprint | null {
  if ((!preview && (t < h.start_s || t >= h.end_s)) || !h.footprint?.[0]?.length) return null
  let footprint = hazardCache.get(h)
  if (!footprint) {
    const lon = h.footprint[0].map((p) => p[0])
    const lat = h.footprint[0].map((p) => p[1])
    const west = Math.min(...lon), east = Math.max(...lon), south = Math.min(...lat), north = Math.max(...lat)
    const center: [number, number] = [(west + east) / 2, (south + north) / 2]
    const span_m = Math.hypot((east - west) * 111320 * Math.cos(center[1] * Math.PI / 180), (north - south) * 110574)
    footprint = { center, rings: h.footprint, span_m }
    hazardCache.set(h, footprint)
  }
  return footprint
}

export function scenarioForReplay(scenarios: ScenarioSpec[], selectedId: string | null, replay: ReplayIndex | null): ScenarioSpec | null {
  const id = replay?.bundle.run.scenario_id ?? selectedId
  return scenarios.find((s) => s.scenario_id === id) ?? null
}

export function parentForComparison(scenarios: ScenarioSpec[], selectedId: string | null): ScenarioSpec | null {
  const scenario = scenarios.find((s) => s.scenario_id === selectedId)
  if (!scenario?.parent_scenario_id) return null
  const parent = scenarios.find((s) => s.scenario_id === scenario.parent_scenario_id)
  return parent && parent.scenario_id !== scenario.scenario_id && parent.pack_id === scenario.pack_id && parent.demand_id === scenario.demand_id ? parent : null
}

export function canEditScenario(scenario: ScenarioSpec | null, selectedId: string | null, side: string): boolean {
  return (side === 'solo' || side === 'right') && !!scenario && scenario.scenario_id === selectedId
}

/** Even-odd test of a lon/lat point against a ring (closed or not). */
export function pointInRing(ring: [number, number][], point: [number, number]): boolean {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j]
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit
  }
  return hit
}

export function containsHazardPoint(h: HazardTrack, point: [number, number]): boolean {
  return !!h.footprint?.length && pointInRing(h.footprint[0], point) && !h.footprint.slice(1).some((ring) => pointInRing(ring, point))
}

