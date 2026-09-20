import { describe, expect, it } from 'vitest'
import { WorldFrame } from './babylon/coords'
import { populationEnvironmentAt, populationHazards } from './populationHazards'
import { populationArtifact } from './population.testData'
import type { PopulationArtifact, PopulationStimulus } from './types'

function record(stimulus: Partial<PopulationStimulus>, applied_s: number): NonNullable<PopulationArtifact['stimuli']>[number] {
  return { applied_s, resident_ids: ['r1'], stimulus: { stimulus_id: `input-${applied_s}`, kind: 'incident', hazard: 'rain', lon: -79.38, lat: 43.64, radius_m: 100, text: 'Rain warning', duration_s: 20, ...stimulus } }
}

describe('recorded native weather', () => {
  it('shows rain only during its applied interval and agrees with the map effects while scrubbing', () => {
    const artifact = { ...populationArtifact(), stimuli: [record({}, 10)] }
    const frame = new WorldFrame({ utm_zone: 17, net_offset: [0, 0], origin_net: [0, 0], origin_lonlat: [-79.38, 43.64], bounds_world: [0, 0, 100, 100] })
    for (const [t, visible] of [[9, false], [10, true], [29, true], [30, false], [12, true], [0, false]] as const) {
      expect(populationEnvironmentAt(artifact, t).weatherLabel).toBe(visible ? 'Rain' : 'Clear')
      expect(populationHazards(artifact, frame, t).weather).toHaveLength(visible ? 1 : 0)
    }
  })

  it('uses the latest applied active temperature and incident without leaking future conditions', () => {
    const artifact = { ...populationArtifact(), stimuli: [
      record({ kind: 'temperature', temperature_c: 0, hazard: null, duration_s: 100 }, 5),
      record({ hazard: 'storm', duration_s: 5 }, 20),
      record({ kind: 'temperature', temperature_c: 35, hazard: null, duration_s: 10 }, 15),
      record({ hazard: 'rain', duration_s: 100 }, 10),
    ] }
    expect(populationEnvironmentAt(artifact, 14)).toEqual({ weatherLabel: 'Rain', temperature: 0 })
    expect(populationEnvironmentAt(artifact, 20)).toEqual({ weatherLabel: 'Storm', temperature: 35 })
    expect(populationEnvironmentAt(artifact, 25)).toEqual({ weatherLabel: 'Rain', temperature: 0 })
    expect(populationEnvironmentAt(artifact, 110)).toEqual({ weatherLabel: 'Clear', temperature: null })
    expect(populationEnvironmentAt(artifact, 4)).toEqual({ weatherLabel: 'Clear', temperature: null })
  })

  it('does not invent weather or temperature when no native recording exists', () => {
    expect(populationEnvironmentAt(null, 100)).toEqual({ weatherLabel: 'No record', temperature: null })
    expect(populationEnvironmentAt(populationArtifact(), 100)).toEqual({ weatherLabel: 'Clear', temperature: null })
  })
})
