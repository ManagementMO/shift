import type { PopulationArtifact } from './types'
import type { WorldFrame } from './babylon/coords'
import type { TornadoTrack } from './babylon/tornadoPlacement'
import { circleRing, WEATHER_VISUALS, type HazardTrack } from './weather'

/** The native observation window is half-open, matching the authoritative society observation. */
function activePopulationStimuli(artifact: PopulationArtifact | null | undefined, t: number) {
  return (artifact?.stimuli ?? []).filter(row => t >= row.applied_s && t < row.applied_s + row.stimulus.duration_s)
}

/** Header conditions come from the same applied records as the map, never from queued drafts or street sessions. */
export function populationEnvironmentAt(artifact: PopulationArtifact | null | undefined, t: number): { weatherLabel: string; temperature: number | null } {
  const active = activePopulationStimuli(artifact, t).sort((a, b) => a.applied_s - b.applied_s)
  const incident = active.filter(row => row.stimulus.kind === 'incident' && row.stimulus.hazard).at(-1)?.stimulus
  const temperature = active.filter(row => row.stimulus.kind === 'temperature' && row.stimulus.temperature_c != null).at(-1)?.stimulus.temperature_c ?? null
  const labels = { rain: 'Rain', storm: 'Storm', flood: 'Flood', fire: 'Wildfire', tornado: 'Tornado', crash: 'Crash', gas_leak: 'Gas leak' }
  return { weatherLabel: incident?.hazard ? labels[incident.hazard] : artifact ? 'Clear' : 'No record', temperature }
}

/** Only applied, time-visible observations get effects; sending a draft is not execution. */
export function populationHazards(artifact: PopulationArtifact | null | undefined, frame: WorldFrame, t: number): { weather: HazardTrack[]; tornadoes: TornadoTrack[] } {
  const weather: HazardTrack[] = [], tornadoes: TornadoTrack[] = []
  for (const { stimulus: s, applied_s: start } of activePopulationStimuli(artifact, t)) {
    if (s.kind !== 'incident' || s.lon == null || s.lat == null || s.radius_m == null || !s.hazard) continue
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
