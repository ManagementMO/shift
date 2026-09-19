// Crowd presentation rules: pedestrian level of detail and venue "release" pulses.  Pure functions over the
// replay record — a pulse marks the recorded second a traveller left the venue, at the position SUMO put them.

import type { ReplayIndex } from '../replay'
import type { WorldFrame } from './coords'

export type Lod = 'figure' | 'marker'

/** Full figure within this camera distance (m); beyond it a pedestrian is a ground marker. */
export const LOD_FIGURE_M = 420
/** Orbit radius (m) beyond which the whole crowd is drawn as markers, whatever the per-person distance. */
export const LOD_CITY_RADIUS_M = 900

export function lodFor(distToCamera: number, camRadius: number): Lod {
  if (camRadius >= LOD_CITY_RADIUS_M) return 'marker'
  return distToCamera <= LOD_FIGURE_M ? 'figure' : 'marker'
}

export interface Release {
  t: number
  id: string
  x: number
  z: number
}

/** One entry per recorded `depart` event, placed at the person's first sampled position; sorted by time. */
export function releasesFrom(rx: ReplayIndex, frame: WorldFrame): Release[] {
  const out: Release[] = []
  for (const [id, evs] of Object.entries(rx.personEvents)) {
    const dep = evs.find((e) => e.event === 'depart')
    const first = rx.tracks[id]?.track.samples[0]
    if (!dep || !first) continue
    const [x, z] = frame.lonLatToWorld(first[1], first[2])
    out.push({ t: dep.t, id, x, z })
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

/** Pulse lifetime in sim seconds. */
export const PULSE_S = 2.5
export const PULSE_RADIUS_M = 14

/** Ring radius (m) and remaining intensity in [0,1] for a pulse of the given age; null once it has finished. */
export function pulse(age: number): { radius: number; fade: number } | null {
  if (age < 0 || age > PULSE_S) return null
  const k = age / PULSE_S
  const e = 1 - (1 - k) * (1 - k)
  return { radius: 1 + (PULSE_RADIUS_M - 1) * e, fade: 1 - k }
}

/** Releases whose pulse is alive at sim time `t` (releases must be sorted by `t`). */
export function activeReleases(releases: Release[], t: number): Release[] {
  let lo = 0
  let hi = releases.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (releases[mid].t < t - PULSE_S) lo = mid + 1
    else hi = mid
  }
  const out: Release[] = []
  for (let i = lo; i < releases.length && releases[i].t <= t; i++) out.push(releases[i])
  return out
}
