import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { newHazardSketch, sketchForKind, useStore, WEATHER_DURATION_S, weatherWindow } from './store'
import { clock } from './world/playback'
import { ghostFromProposal, proposalTitle } from './shell/ghost'
import type { CityPack, HazardTrack, Health, InterventionProposal, RunBundle, ScenarioSpec } from './types'

const pack: CityPack = {
  pack_id: 'pack', name: 'Synthetic pack', version: '1', bbox: [-79.4, 43.63, -79.3, 43.65],
  center: [-79.39, 43.64], venue_edge_id: 'A', venue_lonlat: [-79.39, 43.64],
  stops: [], zones: [], limitations: [], real_data: false, network_fingerprint: 'n',
}
const parent: ScenarioSpec = {
  scenario_id: 'parent', pack_id: 'pack', demand_id: 'cohort', evidence_bundle_id: null, evidence_hash: null,
  restrictions: [], hazards: [], parent_scenario_id: null, change_set: [], label: 'Parent', created_at: '2026-09-19',
  constraints: { fleet: [], horizon_s: 600, service_window_s: [0, 600], allowed_stop_ids: [], objective: 'completion_by_horizon', hard_max_fleet: 2 },
}
const hazard: HazardTrack = {
  track_id: 'zone', waypoints: [[-79.39, 43.64]], radius_m: 100, start_s: 100, end_s: 300,
  modes: ['passenger', 'bus'], kind: 'flood', label: 'Static exclusion',
  footprint: [[[-79.391, 43.639], [-79.389, 43.639], [-79.389, 43.641], [-79.391, 43.641]]],
}
const proposal: InterventionProposal = {
  proposal_id: 'ip-zone', kind: 'storm', text: 'Hazard zone', edge_ids: ['B'], stop_id: null, target_stop_id: null,
  fleet_count: null, start_s: 100, end_s: 300, hazard, network_fingerprint: 'n', warnings: [],
  base_scenario_id: 'parent', ambiguous: false, reason: 'Declared static exclusion',
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  clock.pause()
  clock.setHorizon(600)
  clock.seek(0)
  clock.setSpeed(1)
  useStore.setState({ ...useStore.getInitialState(), pack, scenarios: [parent], scenarioId: 'parent', tool: 'weather', hazardSketch: newHazardSketch(600) }, true)
})
afterEach(() => {
  clock.pause()
  clock.seek(0)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Storage availability', () => {
  it('keeps safe health diagnostics available when MongoDB metadata requests fail', async () => {
    const health = { ok: false, storage: { backend: 'mongodb', configured: false, available: false, message: 'Set MONGODB_URI' } } as Health
    vi.spyOn(api, 'health').mockResolvedValue(health)
    vi.spyOn(api, 'scenarios').mockRejectedValue(new Error('MongoDB is not configured'))
    vi.spyOn(api, 'packs').mockRejectedValue(new Error('MongoDB is not configured'))
    await useStore.getState().boot()
    expect(useStore.getState().health).toBe(health)
    expect(useStore.getState().error).toContain('MongoDB is not configured')
  })
})

describe('Hazard map authoring', () => {
  it('places and replaces a point without mutating any scenario', () => {
    const before = JSON.stringify(parent)
    useStore.getState().placeHazardPoint([-79.39, 43.64])
    useStore.getState().placeHazardPoint([-79.38, 43.64])
    expect(useStore.getState().hazardSketch?.draft.waypoints).toEqual([[-79.38, 43.64]])
    expect(JSON.stringify(parent)).toBe(before)
  })

  it('appends corridor points and rejects non-finite or out-of-pack placement', () => {
    useStore.getState().setHazardSketch({ ...newHazardSketch(600), shape: 'corridor' })
    useStore.getState().placeHazardPoint([-79.39, 43.64])
    useStore.getState().placeHazardPoint([-79.38, 43.64])
    useStore.getState().placeHazardPoint([NaN, 43.64])
    useStore.getState().placeHazardPoint([-80, 43.64])
    expect(useStore.getState().hazardSketch?.draft.waypoints).toHaveLength(2)
    expect(useStore.getState().error).toContain('supported area')
  })

  it('stops accepting clicks after placement is finished', () => {
    useStore.getState().setHazardSketch({ ...newHazardSketch(600), placing: false })
    useStore.getState().placeHazardPoint([-79.39, 43.64])
    expect(useStore.getState().hazardSketch?.draft.waypoints).toEqual([])
  })

  it('invalidates the old exact-road preview when geometry changes', () => {
    useStore.getState().setGhost(ghostFromProposal(proposal, pack))
    useStore.getState().placeHazardPoint([-79.38, 43.64])
    expect(useStore.getState().ghost).toBeNull()
  })

  it('discarding clears all draft map marks without storing a child', () => {
    const apply = vi.spyOn(api, 'applyEdit')
    useStore.getState().setGhost(ghostFromProposal(proposal, pack))
    useStore.getState().setTool(null)
    expect(useStore.getState().ghost).toBeNull()
    expect(useStore.getState().hazardSketch).toBeNull()
    expect(useStore.getState().scenarios).toEqual([parent])
    expect(apply).not.toHaveBeenCalled()
  })

  it('clears hazard placement and preview when switching districts', async () => {
    vi.spyOn(api, 'pack').mockResolvedValue({ ...pack, pack_id: 'other' })
    vi.spyOn(api, 'roads').mockResolvedValue({ type: 'FeatureCollection', features: [] })
    useStore.getState().setGhost(ghostFromProposal(proposal, pack))
    await useStore.getState().selectPack('other')
    expect(useStore.getState().pack?.pack_id).toBe('other')
    expect(useStore.getState().hazardSketch).toBeNull()
    expect(useStore.getState().ghost).toBeNull()
    expect(useStore.getState().tool).toBeNull()
    expect(useStore.getState().scenarios).toEqual([parent])
  })

  it('places rain with one click, resizes its radius, and moves it without requiring roads', () => {
    useStore.getState().setHazardSketch(newHazardSketch(600, 'rain', 0))
    expect(useStore.getState().hazardSketch).toMatchObject({ shape: 'point', draft: { shape: 'buffer', radius_m: 150, kind: 'rain', waypoints: [] } })
    useStore.getState().placeHazardPoint([-79.39, 43.64])
    let sketch = useStore.getState().hazardSketch!
    expect(sketch.draft.waypoints).toEqual([[-79.39, 43.64]])
    // The chosen radius declares the maximum area, independent of the visual spread.
    useStore.getState().setHazardSketch({ ...sketch, draft: { ...sketch.draft, radius_m: 180 } })
    expect(useStore.getState().hazardSketch?.draft.radius_m).toBe(180)
    // A second click re-centres rather than adding corners.
    useStore.getState().placeHazardPoint([-79.388, 43.641])
    sketch = useStore.getState().hazardSketch!
    expect(sketch.draft.waypoints).toEqual([[-79.388, 43.641]])
    useStore.getState().translateHazardSketch(0.001, -0.0005)
    sketch = useStore.getState().hazardSketch!
    expect(sketch.draft.waypoints[0][0]).toBeCloseTo(-79.387, 9)
    expect(sketch.draft.waypoints[0][1]).toBeCloseTo(43.6405, 9)
    useStore.getState().translateHazardSketch(1, 0)
    expect(useStore.getState().error).toContain('supported area')
    expect(useStore.getState().hazardSketch).toBe(sketch)
    // Type switches keep the placement and radius rather than altering the geometry.
    const storm = sketchForKind(sketch, 'storm')
    expect(storm.draft).toMatchObject({ kind: 'storm', shape: 'buffer', radius_m: 180, waypoints: sketch.draft.waypoints })
    expect(sketchForKind(storm, 'rain').draft).toMatchObject({ kind: 'rain', radius_m: 180, waypoints: sketch.draft.waypoints })
    expect(newHazardSketch(600, 'flood').draft.kind).not.toBe('flood')
  })

  it('retires Fire authoring without deleting saved Fire history', () => {
    expect(newHazardSketch(600, 'fire', 120).draft.kind).toBe('storm')
    const legacy = { ...hazard, kind: 'fire' as const }
    const saved = { ...parent, hazards: [legacy] }
    useStore.setState({ scenarios: [saved], scenarioId: saved.scenario_id })
    expect(useStore.getState().beginHazardMove(legacy.track_id)).toBe(false)
    expect(useStore.getState().scenarios[0].hazards).toEqual([legacy])
  })

  it('keeps a saved polygon unchanged when picking it up for a move', () => {
    const corners: [number, number][] = [[-79.391, 43.639], [-79.389, 43.639], [-79.389, 43.641], [-79.391, 43.641]]
    const area: HazardTrack = { ...hazard, track_id: 'area', kind: 'flood', shape: 'polygon', radius_m: 0, waypoints: corners }
    const child: ScenarioSpec = { ...parent, scenario_id: 'child', hazards: [area] }
    useStore.setState({ scenarios: [child], scenarioId: 'child', tool: null, hazardSketch: null })
    expect(useStore.getState().beginHazardMove('area')).toBe(true)
    const sketch = useStore.getState().hazardSketch!
    expect(sketch.replaces).toBe('area')
    expect(sketch.draft.shape).toBe('polygon')
    expect(sketch.draft.waypoints).toEqual(corners)
    expect(sketch.draft.radius_m).toBe(0)
    expect(area.waypoints).toEqual(corners)
  })

  it('gives every new event a fixed window starting at the current sim time, kept inside the horizon', () => {
    expect(weatherWindow(0, 2700)).toEqual({ start_s: 0, end_s: WEATHER_DURATION_S })
    expect(weatherWindow(1234.6, 2700)).toEqual({ start_s: 1234, end_s: 1234 + WEATHER_DURATION_S })
    expect(weatherWindow(2650, 2700)).toEqual({ start_s: 2650, end_s: 2700 })
    expect(weatherWindow(50, 300)).toEqual({ start_s: 50, end_s: 300 })
    expect(weatherWindow(Number.NaN, 2700)).toEqual({ start_s: 0, end_s: WEATHER_DURATION_S })
    // Placing anchors the window to the clock at that moment; moving an existing event keeps its own window.
    // The test scenario's horizon is 600 s, so an event placed at +400 uses the remaining window: [400, 600).
    clock.seek(400)
    useStore.getState().setHazardSketch(newHazardSketch(600, 'storm', 0))
    useStore.getState().placeHazardPoint([-79.39, 43.64])
    expect(useStore.getState().hazardSketch?.draft).toMatchObject(weatherWindow(400, 600))
    expect(useStore.getState().hazardSketch?.draft.end_s).toBe(600)
    useStore.getState().setHazardSketch({ ...newHazardSketch(1000, 'storm', 0), replaces: 'zone', draft: { ...newHazardSketch(1000, 'storm', 0).draft, start_s: 100, end_s: 300 } })
    useStore.getState().placeHazardPoint([-79.39, 43.64])
    expect(useStore.getState().hazardSketch?.draft).toMatchObject({ start_s: 100, end_s: 300 })
    clock.seek(0)
  })

  it('ignores a delayed preview belonging to another scenario', () => {
    useStore.getState().setGhost(ghostFromProposal({ ...proposal, base_scenario_id: 'old-parent' }, pack))
    expect(useStore.getState().ghost).toBeNull()
  })
})

describe('Weather edit playback handoff', () => {
  const rain: HazardTrack = { ...hazard, kind: 'rain' }
  const child: ScenarioSpec = { ...parent, scenario_id: 'child', parent_scenario_id: 'parent', hazards: [rain] }
  const replay = (activityStart: number): RunBundle => ({
    run: { run_id: 'child-run', scenario_id: 'child', plan_id: 'baseline', seed: 1, status: 'completed', engine_version: '', progress: 1, run_dir: '', error: null, warnings: [], metrics: null, manifest_hash: '', created_at: '' },
    tracks: { car: { entity_id: 'car', kind: 'car', samples: [[activityStart, -79.39, 43.64, 90, 4], [activityStart + 1, -79.3899, 43.64, 90, 4]], breaks: [] } },
    events: [], occupancy: {}, stopQueue: {}, compile: null,
  })
  const arrange = (activityStart: number, queued = false) => {
    const bundle = replay(activityStart)
    const apply = vi.spyOn(api, 'applyEdit').mockResolvedValue(child)
    vi.spyOn(api, 'scenarios').mockResolvedValue([parent, child])
    vi.spyOn(api, 'plans').mockResolvedValue([])
    const runs = vi.spyOn(api, 'runs').mockResolvedValue([{ ...bundle.run, status: queued ? 'queued' : 'completed' }])
    vi.spyOn(api, 'bundle').mockResolvedValue(bundle)
    vi.spyOn(api, 'demand').mockResolvedValue({ demand_id: 'cohort', seed: 1, travelers: [], synthetic: true, generation_method: 'test' })
    useStore.getState().setGhost(ghostFromProposal({ ...proposal, hazard: rain }, pack))
    clock.seek(150)
    clock.setSpeed(4)
    return { bundle, apply, runs }
  }

  it.each([0, 400])('keeps applied weather visible instead of jumping to child activity at %s seconds', async (activityStart) => {
    arrange(activityStart)
    expect(await useStore.getState().applyGhost()).toBe(child)
    expect(clock.t).toBe(150)
    expect(clock.playing).toBe(false)
    expect(clock.speed).toBe(4)
    expect(useStore.getState().primaryRunId).toBe('child-run')
    expect(useStore.getState().replays['child-run'].bundle.run.scenario_id).toBe('child')
    expect(child.hazards[0]).toBe(rain)
    expect(clock.t >= rain.start_s && clock.t < rain.end_s).toBe(true)
  })

  it('holds the edit position while waiting for SUMO, then resumes the original play state', async () => {
    const { bundle, apply, runs } = arrange(0, true)
    let saved!: (scenario: ScenarioSpec) => void
    apply.mockReturnValueOnce(new Promise((resolve) => { saved = resolve }))
    clock.play()
    const applying = useStore.getState().applyGhost()
    expect(clock.t).toBe(150)
    expect(clock.playing).toBe(false)
    saved(child)
    expect(await applying).toBe(child)
    expect(clock.t).toBe(150)
    expect(clock.playing).toBe(false)
    expect(useStore.getState().primaryRunId).toBeNull()
    runs.mockResolvedValue([bundle.run])
    await useStore.getState().refreshRuns()
    expect(clock.t).toBe(150)
    expect(clock.playing).toBe(true)
    expect(clock.speed).toBe(4)
    expect(useStore.getState().primaryRunId).toBe('child-run')
  })

  it('keeps the queued resume intent when another weather edit is applied before replay is ready', async () => {
    const { bundle, runs } = arrange(0, true)
    useStore.setState({ pendingPlayback: { scenarioId: 'parent', t: 150, playing: true, speed: 4 } })
    expect(clock.playing).toBe(false)
    await useStore.getState().applyGhost()
    expect(clock.t).toBe(150)
    expect(clock.playing).toBe(false)
    runs.mockResolvedValue([bundle.run])
    await useStore.getState().refreshRuns()
    expect(clock.t).toBe(150)
    expect(clock.playing).toBe(true)
    expect(clock.speed).toBe(4)
  })

  it('retains the edit position when loading its replay fails and is retried', async () => {
    arrange(0)
    vi.mocked(api.bundle).mockRejectedValueOnce(new Error('Replay unavailable'))
    await useStore.getState().applyGhost()
    expect(clock.t).toBe(150)
    expect(clock.playing).toBe(false)
    expect(useStore.getState().primaryRunId).toBeNull()
    expect(useStore.getState().pendingPlayback?.t).toBe(150)
    await useStore.getState().openRun('child-run')
    expect(clock.t).toBe(150)
    expect(clock.playing).toBe(false)
    expect(clock.speed).toBe(4)
    expect(useStore.getState().pendingPlayback).toBeNull()
  })

  it('does not carry the edit position into a later manual scenario selection', async () => {
    const { bundle, runs } = arrange(10, true)
    await useStore.getState().applyGhost()
    runs.mockResolvedValueOnce([])
    await useStore.getState().selectScenario('parent')
    expect(clock.t).toBe(0)
    runs.mockResolvedValueOnce([bundle.run])
    await useStore.getState().selectScenario('child')
    expect(clock.t).toBe(10)
    expect(clock.playing).toBe(true)
  })

  it('restores the parent playback state if saving the edit fails', async () => {
    const { apply } = arrange(0)
    apply.mockRejectedValueOnce(new Error('Save failed'))
    clock.play()
    expect(await useStore.getState().applyGhost()).toBeNull()
    expect(clock.t).toBe(150)
    expect(clock.playing).toBe(true)
    expect(clock.speed).toBe(4)
    expect(useStore.getState().scenarioId).toBe('parent')
    expect(useStore.getState().ghost?.hazard).toBe(rain)
    expect(useStore.getState().error).toContain('Save failed')
  })

  it('does not rewind other timed events when deleting one event', async () => {
    arrange(0)
    const removed = { ...rain, track_id: 'remove-me' }
    const source = { ...parent, hazards: [rain, removed] }
    useStore.setState({ scenarios: [source], ghost: null })
    vi.spyOn(api, 'previewHazardRemoval').mockResolvedValue({ ...proposal, kind: 'remove_hazard', hazard: removed })
    expect(await useStore.getState().deleteHazard('remove-me')).toBe(child)
    expect(clock.t).toBe(150)
    expect(clock.playing).toBe(false)
    expect(clock.speed).toBe(4)
    expect(useStore.getState().scenarios.find((s) => s.scenario_id === 'child')?.hazards).toEqual([rain])
    expect(source.hazards).toEqual([rain, removed])
  })
})

describe('Hazard confirmation and removal', () => {
  it('keeps a failed confirmation on its parent and reports failure to the caller', async () => {
    vi.spyOn(api, 'applyEdit').mockRejectedValue(new Error('Network changed; preview again'))
    useStore.getState().setGhost(ghostFromProposal(proposal, pack))
    expect(await useStore.getState().applyGhost()).toBeNull()
    expect(useStore.getState().scenarioId).toBe('parent')
    expect(useStore.getState().ghost?.proposal).toBe(proposal)
    expect(useStore.getState().error).toContain('preview again')
    expect(useStore.getState().building).toBeNull()
  })

  it('confirms into a child and clears the preview while preserving the parent', async () => {
    const child: ScenarioSpec = { ...parent, scenario_id: 'child', parent_scenario_id: 'parent', hazards: [hazard] }
    vi.spyOn(api, 'applyEdit').mockResolvedValue(child)
    vi.spyOn(api, 'scenarios').mockResolvedValue([parent, child])
    vi.spyOn(api, 'plans').mockResolvedValue([])
    vi.spyOn(api, 'runs').mockResolvedValue([])
    vi.spyOn(api, 'demand').mockResolvedValue({ demand_id: 'cohort', seed: 1, travelers: [], synthetic: true, generation_method: 'test' })
    useStore.getState().setGhost(ghostFromProposal(proposal, pack))
    expect(await useStore.getState().applyGhost()).toBe(child)
    expect(useStore.getState().scenarioId).toBe('child')
    expect(useStore.getState().ghost).toBeNull()
    expect(useStore.getState().hazardSketch).toBeNull()
    expect(parent.hazards).toEqual([])
  })

  it('picks up an existing event as a move draft that previews one replace edit', () => {
    const child: ScenarioSpec = { ...parent, scenario_id: 'child', hazards: [hazard], restrictions: [{ restriction_id: 'r', edge_ids: ['B'], start_s: 100, end_s: 300, modes: ['passenger', 'bus'], source_claim_id: 'hazard:zone', label: 'zone' }] }
    useStore.setState({ scenarios: [child], scenarioId: 'child', tool: null, hazardSketch: null })
    expect(useStore.getState().beginHazardMove('missing')).toBe(false)
    expect(useStore.getState().beginHazardMove('zone')).toBe(true)
    const sketch = useStore.getState().hazardSketch!
    expect(useStore.getState().tool).toBe('weather')
    expect(sketch.replaces).toBe('zone')
    expect(sketch.draft.kind).toBe('flood')
    expect(sketch.draft.radius_m).toBe(100)
    expect(sketch.draft.waypoints[0][0]).toBeCloseTo(-79.39, 3)
    expect(sketch.draft.waypoints[0][1]).toBeCloseTo(43.64, 3)
    useStore.getState().placeHazardPoint([-79.38, 43.64])
    expect(useStore.getState().hazardSketch?.replaces).toBe('zone')
    expect(useStore.getState().hazardSketch?.draft.waypoints).toEqual([[-79.38, 43.64]])
    const move = { ...proposal, kind: 'replace_hazard' as const, replaces_track_id: 'zone', base_scenario_id: 'child' }
    expect(ghostFromProposal(move, pack).replaces).toBe('zone')
    expect(proposalTitle(move)).toContain('Move')
    expect(child.hazards).toEqual([hazard])
  })

  it('deletes an event in one step by previewing and applying a removal', async () => {
    const child: ScenarioSpec = { ...parent, scenario_id: 'child', hazards: [hazard] }
    const removed: ScenarioSpec = { ...child, scenario_id: 'grandchild', parent_scenario_id: 'child', hazards: [] }
    useStore.setState({ scenarios: [child], scenarioId: 'child', hazardInfoId: 'zone' })
    vi.spyOn(api, 'previewHazardRemoval').mockResolvedValue({ ...proposal, kind: 'remove_hazard', base_scenario_id: 'child' })
    vi.spyOn(api, 'applyEdit').mockResolvedValue(removed)
    vi.spyOn(api, 'scenarios').mockResolvedValue([child, removed])
    vi.spyOn(api, 'plans').mockResolvedValue([])
    vi.spyOn(api, 'runs').mockResolvedValue([])
    vi.spyOn(api, 'demand').mockResolvedValue({ demand_id: 'cohort', seed: 1, travelers: [], synthetic: true, generation_method: 'test' })
    expect(await useStore.getState().deleteHazard('zone')).toBe(removed)
    expect(api.previewHazardRemoval).toHaveBeenCalledWith('child', 'zone')
    expect(useStore.getState().scenarioId).toBe('grandchild')
    expect(useStore.getState().hazardInfoId).toBeNull()
    expect(useStore.getState().building).toBeNull()
    expect(child.hazards).toEqual([hazard])
  })

  it('hides a fire immediately while its removal saves and ignores duplicate clicks', async () => {
    const fire: HazardTrack = { ...hazard, kind: 'fire' }
    const child: ScenarioSpec = { ...parent, scenario_id: 'child', hazards: [fire] }
    const removed: ScenarioSpec = { ...child, scenario_id: 'removed', parent_scenario_id: 'child', hazards: [] }
    const removal = { ...proposal, kind: 'remove_hazard' as const, base_scenario_id: 'child', hazard: fire }
    let resolvePreview!: (p: InterventionProposal) => void
    let resolveApply!: (p: ScenarioSpec) => void
    useStore.setState({ scenarios: [child], scenarioId: 'child', hazardInfoId: 'zone' })
    vi.spyOn(api, 'previewHazardRemoval').mockReturnValue(new Promise((resolve) => { resolvePreview = resolve }))
    vi.spyOn(api, 'applyEdit').mockReturnValue(new Promise((resolve) => { resolveApply = resolve }))
    vi.spyOn(api, 'plans').mockResolvedValue([])
    vi.spyOn(api, 'runs').mockResolvedValue([])
    vi.spyOn(api, 'demand').mockResolvedValue({ demand_id: 'cohort', seed: 1, travelers: [], synthetic: true, generation_method: 'test' })
    const pending = useStore.getState().deleteHazard('zone')
    expect(useStore.getState().pendingHazardRemoval).toEqual({ scenarioId: 'child', trackId: 'zone' })
    expect(useStore.getState().hazardInfoId).toBeNull()
    expect(useStore.getState().scenarios[0]).toBe(child)
    expect(child.hazards).toEqual([fire])
    expect(await useStore.getState().deleteHazard('zone')).toBeNull()
    expect(api.previewHazardRemoval).toHaveBeenCalledTimes(1)
    resolvePreview(removal)
    await vi.waitFor(() => expect(api.applyEdit).toHaveBeenCalledWith('child', removal))
    expect(useStore.getState().pendingHazardRemoval?.trackId).toBe('zone')
    expect(useStore.getState().ghost).toBeNull()
    resolveApply(removed)
    expect(await pending).toBe(removed)
    expect(useStore.getState().pendingHazardRemoval).toBeNull()
    expect(useStore.getState().scenarioId).toBe('removed')
    expect(child.hazards).toEqual([fire])
  })

  it('restores a hidden fire when saving the deletion fails', async () => {
    const child: ScenarioSpec = { ...parent, scenario_id: 'child', hazards: [{ ...hazard, kind: 'fire' }] }
    useStore.setState({ scenarios: [child], scenarioId: 'child' })
    vi.spyOn(api, 'previewHazardRemoval').mockResolvedValue({ ...proposal, kind: 'remove_hazard', base_scenario_id: 'child' })
    vi.spyOn(api, 'applyEdit').mockRejectedValue(new Error('Offline'))
    const pending = useStore.getState().deleteHazard('zone')
    expect(useStore.getState().pendingHazardRemoval?.trackId).toBe('zone')
    expect(await pending).toBeNull()
    expect(useStore.getState().pendingHazardRemoval).toBeNull()
    expect(useStore.getState().scenarios).toEqual([child])
    expect(useStore.getState().ghost).toBeNull()
    expect(useStore.getState().building).toBeNull()
    expect(useStore.getState().error).toContain('Offline')
  })

  it('does not apply a deletion preview after navigating to another scenario', async () => {
    const child: ScenarioSpec = { ...parent, scenario_id: 'child', hazards: [{ ...hazard, kind: 'fire' }] }
    let resolve!: (p: InterventionProposal) => void
    useStore.setState({ scenarios: [child, parent], scenarioId: 'child' })
    vi.spyOn(api, 'previewHazardRemoval').mockReturnValue(new Promise((done) => { resolve = done }))
    vi.spyOn(api, 'applyEdit')
    vi.spyOn(api, 'plans').mockResolvedValue([])
    vi.spyOn(api, 'runs').mockResolvedValue([])
    vi.spyOn(api, 'demand').mockResolvedValue({ demand_id: 'cohort', seed: 1, travelers: [], synthetic: true, generation_method: 'test' })
    const pending = useStore.getState().deleteHazard('zone')
    await useStore.getState().selectScenario('parent')
    resolve({ ...proposal, kind: 'remove_hazard', base_scenario_id: 'child' })
    expect(await pending).toBeNull()
    expect(api.applyEdit).not.toHaveBeenCalled()
    expect(useStore.getState().scenarioId).toBe('parent')
    expect(useStore.getState().pendingHazardRemoval).toBeNull()
    expect(useStore.getState().building).toBeNull()
  })

  it('reports a failed one-step delete without leaving the app stuck building', async () => {
    const child: ScenarioSpec = { ...parent, scenario_id: 'child', hazards: [hazard] }
    useStore.setState({ scenarios: [child], scenarioId: 'child' })
    vi.spyOn(api, 'previewHazardRemoval').mockRejectedValue(new Error('hazard does not exist'))
    expect(await useStore.getState().deleteHazard('zone')).toBeNull()
    expect(useStore.getState().error).toContain('does not exist')
    expect(useStore.getState().building).toBeNull()
    expect(useStore.getState().scenarioId).toBe('child')
  })

  it('does not draw removal as another road closure', () => {
    const removal = { ...proposal, kind: 'remove_hazard' as const }
    expect(ghostFromProposal(removal, pack).edges).toEqual([])
    expect(ghostFromProposal(removal, pack).hazard).toBe(hazard)
    expect(proposalTitle(removal)).toContain('Remove')
    expect(proposalTitle(proposal)).toContain('Weather event')
  })
})
