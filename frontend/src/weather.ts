/**
 * Weather-event footprints for the Babylon effects (`babylon/hazardEffects.ts`), ported from the scenario-based
 * weather tool onto the live city.  A live incident is a circle on the ground (`LiveIncident`: world x/z, radius,
 * window); the effects want lon/lat rings, so `weatherTrackFor` projects it once.  The draft under the cursor while
 * an event is being placed is the same shape with the id `weather-guide`.
 */

import type { WorldFrame } from './babylon/coords'
import type { LiveIncident } from './live/types'

export type HazardKind = 'rain' | 'fire' | 'storm' | 'flood'
export type HazardMode = 'passenger' | 'bus' | 'pedestrian'
/** buffer: waypoints widened by radius_m (point or corridor); polygon: waypoints are the corners of the area. */
export type HazardShape = 'buffer' | 'polygon'

export type HazardDraft = {
  waypoints: [number, number][]
  radius_m: number
  start_s: number
  end_s: number
  modes: HazardMode[]
  /** Illustrative visual style only; what SUMO blocks comes from the live hazard profile. */
  kind: HazardKind
  shape?: HazardShape
  label: string
}

export type HazardTrack = HazardDraft & {
  track_id: string
  footprint: [number, number][][]
}

/** Live hazards that have a weather / fire visual; the rest (crash, gas leak, tornado) are drawn elsewhere. */
export const WEATHER_VISUALS: Partial<Record<LiveIncident['hazard'], HazardKind>> = { rain: 'rain', storm: 'storm', fire: 'fire', flood: 'flood' }

export function circleRing(frame: WorldFrame, x: number, z: number, radius: number, segments = 40): [number, number][] {
  const ring: [number, number][] = []
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2
    ring.push(frame.worldToLonLat(x + Math.cos(a) * radius, z + Math.sin(a) * radius))
  }
  return ring
}

const trackCache = new WeakMap<LiveIncident, HazardTrack>()

/** The effects' view of a live incident; cached per incident object so the effect key stays stable between frames. */
export function weatherTrackFor(incident: LiveIncident, frame: WorldFrame): HazardTrack | null {
  const kind = WEATHER_VISUALS[incident.hazard]
  if (!kind) return null
  let track = trackCache.get(incident)
  if (!track) {
    const modes = incident.blocks.filter((m): m is HazardMode => m === 'passenger' || m === 'bus' || m === 'pedestrian')
    track = {
      track_id: incident.event_id, kind, label: incident.label, modes, radius_m: incident.radius_m, start_s: incident.start_s, end_s: incident.end_s,
      waypoints: [frame.worldToLonLat(incident.x, incident.z)], footprint: [circleRing(frame, incident.x, incident.z, incident.radius_m)],
    }
    trackCache.set(incident, track)
  }
  return track
}

/** How far a fire has spread across its footprint at sim time `t`: 0 before it starts, reaching the edge after `fraction` of its window. */
export function fireSpreadProgress(h: Pick<HazardTrack, 'start_s' | 'end_s'>, t: number, preview = false, fraction = 0.6): number {
  if (preview) return 1
  if (!Number.isFinite(t) || t < h.start_s || t >= h.end_s) return 0
  const progress = Math.min(1, (t - h.start_s) / Math.max(1, (h.end_s - h.start_s) * fraction))
  return 0.08 + 0.92 * (1 - (1 - progress) ** 2)
}
