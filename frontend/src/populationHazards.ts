import type { PopulationArtifact } from './types'
import type { WorldFrame } from './babylon/coords'
import type { TornadoTrack } from './babylon/tornadoPlacement'
import { circleRing, WEATHER_VISUALS, type HazardTrack } from './weather'

/** Only applied, time-visible observations get effects; sending a draft is not execution. */
export function populationHazards(artifact: PopulationArtifact | null | undefined, frame: WorldFrame, t: number): { weather: HazardTrack[]; tornadoes: TornadoTrack[] } {
  const weather: HazardTrack[] = [], tornadoes: TornadoTrack[] = []
  for (const { stimulus: s, applied_s: start } of artifact?.stimuli ?? []) {
    if (s.kind !== 'incident' || s.lon == null || s.lat == null || s.radius_m == null || !s.hazard || t < start || t >= start + s.duration_s) continue
    const [x, z] = frame.lonLatToWorld(s.lon, s.lat)
    if (s.hazard === 'tornado') {
      tornadoes.push({ track_id: s.stimulus_id, waypoints: [[s.lon, s.lat]], radius_m: s.radius_m,
        start_s: start, end_s: start + s.duration_s, modes: [], label: s.text, power: 3 })
    } else {
      const kind = WEATHER_VISUALS[s.hazard]
      if (kind) weather.push({ track_id: s.stimulus_id, kind, label: s.text, modes: [], radius_m: s.radius_m, start_s: start, end_s: start + s.duration_s,
        waypoints: [[s.lon, s.lat]], footprint: [circleRing(frame, x, z, s.radius_m)] })
    }
  }
  return { weather, tornadoes }
}
