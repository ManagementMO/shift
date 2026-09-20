import { describe, expect, it, vi } from 'vitest'
import type { HazardTrack, ScenarioSpec } from '../types'
import { buildWorldLayers, type WorldInputs } from './layers'

const hazard: HazardTrack = {
  track_id: 'zone', waypoints: [[-79.39, 43.64], [-79.38, 43.64]], radius_m: 100, start_s: 100, end_s: 300,
  modes: ['passenger'], kind: 'storm', label: 'Static corridor',
  footprint: [[[-79.391, 43.639], [-79.379, 43.639], [-79.379, 43.641], [-79.391, 43.641]]],
}
const scenario = {
  scenario_id: 's', hazards: [hazard], restrictions: [{ restriction_id: 'r', edge_ids: ['B'], start_s: 100, end_s: 300, modes: ['passenger'], source_claim_id: 'hazard:zone' }],
} as ScenarioSpec
const inputs = (patch: Partial<WorldInputs> = {}): WorldInputs => ({
  pack: null, roads: null, scenario, replay: null, t: 100, zoom: 16, selection: null, select: vi.fn(), ...patch,
})

const zone = (w: WorldInputs) => buildWorldLayers(w).find((layer) => layer.id === 'hazard-zone-zone')

describe('Mapbox hazard layers', () => {
  it('draws the same server polygon for the whole window, without a moving column', () => {
    const first = zone(inputs())
    const later = zone(inputs({ t: 299 }))
    expect(first).toBeDefined()
    expect(first?.props.data).toEqual(later?.props.data)
    expect((first?.props.data as { rings: number[][][] }[])[0].rings).toEqual(hazard.footprint)
    expect(buildWorldLayers(inputs()).some((l) => /column|debris/.test(l.id))).toBe(false)
  })

  it('keeps exact preview geometry visible outside the active window but not persisted closures', () => {
    expect(zone(inputs({ t: 0 }))).toBeUndefined()
    expect(zone(inputs({ t: 300 }))).toBeUndefined()
    expect(zone(inputs({ t: 0, ghostHazard: hazard }))).toBeDefined()
  })

  it('draws only backend-specified affected edges and does not infer neighbors', () => {
    const roads: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection', features: ['A', 'B', 'C'].map((id) => ({
        type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [[-79.39, 43.64], [-79.38, 43.64]] },
      })),
    }
    const marked = buildWorldLayers(inputs({ roads, t: 0, ghostEdges: ['B'], ghostHazard: hazard })).find((l) => l.id === 'edges-marked')
    expect((marked?.props.data as GeoJSON.FeatureCollection).features.map((f) => f.properties?.id)).toEqual(['B'])
    expect(buildWorldLayers(inputs({ roads, t: 300 })).find((l) => l.id === 'edges-marked')).toBeUndefined()
  })

  it('draws kind-specific decoration only inside the active footprint and never for floods', () => {
    const storm = buildWorldLayers(inputs()).find((l) => l.id === 'hazard-storm-marks-zone')
    expect(storm).toBeDefined()
    const marks = storm?.props.data as { p: [number, number] }[]
    expect(marks.length).toBeGreaterThan(10)
    for (const m of marks) {
      expect(m.p[0]).toBeGreaterThanOrEqual(-79.391)
      expect(m.p[0]).toBeLessThanOrEqual(-79.379)
      expect(m.p[1]).toBeGreaterThanOrEqual(43.639)
      expect(m.p[1]).toBeLessThanOrEqual(43.641)
    }
    expect(buildWorldLayers(inputs({ t: 300 })).some((l) => l.id.includes('-marks-'))).toBe(false)
    const flood = { ...scenario, hazards: [{ ...hazard, kind: 'flood' as const }] } as ScenarioSpec
    expect(buildWorldLayers(inputs({ scenario: flood })).some((l) => l.id.includes('-marks-'))).toBe(false)
    expect(zone(inputs({ scenario: flood }))).toBeDefined()
  })

  it('spreads fire marks with replay time without changing the authoritative zone', () => {
    const fire: HazardTrack = { ...hazard, kind: 'fire', waypoints: [[-79.385, 43.64]] }
    const fireScenario = { ...scenario, hazards: [fire] }
    const data = (t: number) => buildWorldLayers(inputs({ scenario: fireScenario, t })).find((l) => l.id === 'hazard-fire-marks-zone')!.props.data as { p: [number, number]; r: number }[]
    const first = data(100), later = data(180), full = data(240)
    expect(first.length).toBeGreaterThan(0)
    expect(later.length).toBeGreaterThan(first.length)
    expect(full.length).toBeGreaterThan(later.length)
    expect(data(100)).toEqual(first)
    expect(zone(inputs({ scenario: fireScenario, t: 100 }))!.props.data).toEqual(zone(inputs({ scenario: fireScenario, t: 240 }))!.props.data)
    expect(buildWorldLayers(inputs({ scenario: fireScenario, t: 300 })).some((l) => l.id.includes('fire'))).toBe(false)
  })

  it('hides a pending removal without clearing other overlapping restrictions', () => {
    const roads: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection', features: ['A', 'B'].map((id) => ({
        type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: [[-79.39, 43.64], [-79.38, 43.64]] },
      })),
    }
    const own = { ...scenario.restrictions[0], edge_ids: ['A', 'B'] }
    const manual = { ...own, restriction_id: 'manual', source_claim_id: null, edge_ids: ['B'] }
    const layers = buildWorldLayers(inputs({ roads, scenario: { ...scenario, restrictions: [own, manual] }, hiddenHazardId: 'zone' }))
    expect(layers.some((l) => l.id.startsWith('hazard-'))).toBe(false)
    const marked = layers.find((l) => l.id === 'edges-marked')!
    expect((marked.props.data as GeoJSON.FeatureCollection).features.map((f) => f.properties?.id)).toEqual(['B'])
    expect(scenario.hazards).toEqual([hazard])
  })

  it('draws placement guides without inventing an exact road preview', () => {
    const layers = buildWorldLayers(inputs({ scenario: null, t: 0, hazardSketch: hazard }))
    expect(layers.some((l) => l.id === 'hazard-sketch-corridor')).toBe(true)
    expect(layers.some((l) => l.id === 'edges-marked')).toBe(false)
    const area = buildWorldLayers(inputs({ scenario: null, t: 0, hazardSketch: { ...hazard, shape: 'polygon', radius_m: 0, waypoints: [[-79.39, 43.64], [-79.38, 43.64], [-79.38, 43.641]] } }))
    const outline = area.find((l) => l.id === 'hazard-sketch-area')!
    expect((outline.props.data as [number, number][][])[0]).toHaveLength(4)
    expect(area.some((l) => l.id === 'hazard-sketch-corridor')).toBe(false)
  })
})
