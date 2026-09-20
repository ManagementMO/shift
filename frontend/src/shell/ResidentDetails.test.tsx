import { describe, expect, it } from 'vitest'
import { buildDefinitionIndex } from '../population'
import { bundle, populationArtifact } from '../population.testData'
import { buildIndex } from '../replay'
import { residentDetailsSource } from './residentDetailsSource'

const initial = buildDefinitionIndex(populationArtifact().definition)
const replay = buildIndex(bundle())

describe('resident details source', () => {
  it('resolves clicks on an owned textured vehicle to its persistent resident', () => {
    const source = residentDetailsSource('pop-run', replay, initial, { kind: 'bicycle', id: 'bike-body' }, 12)
    expect(source.residentId).toBe('r1')
    expect(source.population).toBe(replay.population)
    expect(source.time).toBe(12)
  })

  it('keeps initial definitions explicit at time zero, independent of the street clock', () => {
    const source = residentDetailsSource(null, null, initial, { kind: 'resident', id: 'r1' }, 500)
    expect(source).toEqual({ population: initial, residentId: 'r1', time: 0 })
    expect(source.population?.artifact).toBeNull()
  })

  it('never substitutes initial state while a selected recording refreshes or lacks population data', () => {
    const refreshing = residentDetailsSource('pop-run', null, initial, { kind: 'resident', id: 'r1' }, 30)
    expect(refreshing.population).toBeNull()
    expect(refreshing.residentId).toBe('r1')
    const missing = residentDetailsSource('pop-run', buildIndex(bundle(null)), initial, { kind: 'resident', id: 'r1' }, 30)
    expect(missing.population).toBeNull()
  })

  it('does not assign a shared bus to an arbitrary passenger or show details for a stop', () => {
    expect(residentDetailsSource('pop-run', replay, initial, { kind: 'bus', id: 'shared-bus' }, 45).residentId).toBeNull()
    expect(residentDetailsSource('pop-run', replay, initial, { kind: 'stop', id: 'home' }, 12).residentId).toBeNull()
    expect(residentDetailsSource(null, null, initial, null, 0).residentId).toBeNull()
  })
})
