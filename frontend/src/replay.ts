// Replay indexing: every rendered position comes from a stored TraCI sample; gaps are never interpolated
// across a recorded break (teleport) or beyond MAX_GAP_S.

import type { EntityTrack, HazardTrack, PersonEvent, RunBundle } from './types'

export const MAX_GAP_S = 3

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
  let tMax = bundle.run.metrics?.horizon_s ?? 0
  for (const [id, tr] of Object.entries(bundle.tracks)) {
    const times = tr.samples.map((s) => s[0])
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
  return { bundle, tracks, personEvents, occupancy: series(bundle.occupancy), stopQueue: series(bundle.stopQueue), tMax }
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

function circle(lon: number, lat: number, radiusM: number, n = 32): number[][] {
  const out: number[][] = []
  const dLat = radiusM / 111320
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180))
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2
    out.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)])
  }
  return out
}

export function hazardFootprint(h: HazardTrack, t: number): { center: [number, number]; ring: number[][] } | null {
  if (t < h.start_s || t > h.end_s || h.waypoints.length === 0) return null
  const f = h.waypoints.length === 1 ? 0 : ((t - h.start_s) / Math.max(1, h.end_s - h.start_s)) * (h.waypoints.length - 1)
  const i = Math.min(h.waypoints.length - 2, Math.floor(f))
  const a = h.waypoints[i]
  const b = h.waypoints[Math.min(h.waypoints.length - 1, i + 1)]
  const k = f - i
  const c: [number, number] = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]
  return { center: c, ring: circle(c[0], c[1], h.radius_m) }
}

