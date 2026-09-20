import { describe, expect, it } from 'vitest'

import { environmentAt } from './timeline'
import type { LiveSession } from './types'

const session = {
  config: { temperature_c: 20, initial_population: 1000, fleet_size: 2 },
  commands: [
    { at_s: 10, intervention: { kind: 'temperature', temperature_c: 0 } },
    { at_s: 20, intervention: { kind: 'population', count: 5000 } },
    { at_s: 30, intervention: { kind: 'close_road', edge_ids: ['a'], until_s: 50 } },
    { at_s: 35, intervention: { kind: 'close_road', edge_ids: ['a'], until_s: 70 } },
    { at_s: 40, intervention: { kind: 'add_bus_route', bus_id: 'bus_A' } },
    { at_s: 60, intervention: { kind: 'reopen_road', edge_ids: ['a'] } },
  ],
} as LiveSession

describe('Interventions at the playhead', () => {
  it('does not leak future temperature, population, or bus assignments into history', () => {
    expect(environmentAt(session, 5)).toMatchObject({ temperature: 20, population: 1000 })
    expect(environmentAt(session, 5).assignedBuses.size).toBe(0)
    expect(environmentAt(session, 25)).toMatchObject({ temperature: 0, population: 6000 })
    expect([...environmentAt(session, 45).assignedBuses]).toEqual(['bus_A'])
  })

  it('preserves overlapping closures until explicitly reopened or all windows end', () => {
    expect([...environmentAt(session, 29).closedEdges]).toEqual([])
    expect([...environmentAt(session, 55).closedEdges]).toEqual(['a'])
    expect([...environmentAt(session, 60).closedEdges]).toEqual([])
  })
})
