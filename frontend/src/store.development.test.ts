import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { developmentCounts } from './development'
import { fixtureBundle, fixturePack, fixtureScenario, fixtureTraveler } from './development.fixtures'
import { useStore } from './store'
import type { DevelopmentPreview, DevelopmentSpec } from './types'
import { registerMap, type SyncMap } from './world/registry'

function fakeMap(): SyncMap & { moves: { center: [number, number]; zoom: number }[] } {
  const moves: { center: [number, number]; zoom: number }[] = []
  let center: [number, number] = [-79.38, 43.65]
  let zoom = 15
  const move = (o: { center: [number, number]; zoom: number }) => { moves.push({ center: o.center, zoom: o.zoom }); center = o.center; zoom = o.zoom }
  return {
    moves, easeTo: move, flyTo: move, jumpTo: (o) => move({ center: o.center, zoom: o.zoom }),
    getCenter: () => ({ lng: center[0], lat: center[1] }), getZoom: () => zoom, getPitch: () => 60, getBearing: () => 0,
    project: () => ({ x: 0, y: 0 }), isMoving: () => false, on: () => {}, off: () => {},
  }
}

function proposal(spec: DevelopmentSpec): DevelopmentPreview {
  const counts = developmentCounts(spec)
  return { preview_id: 'preview', base_scenario_id: 'parent', development: { development_id: 'development', spec, access: [] },
    participants: counts.participants, incumbent_trips: 1, added_trips: counts.trips, inbound_trips: 0,
    outbound_trips: counts.trips, car_trips: counts.cars, warnings: [] }
}

beforeEach(() => {
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  useStore.setState({ ...useStore.getInitialState(), pack: fixturePack, scenarios: [fixtureScenario()], scenarioId: 'parent' })
  useStore.getState().setTool('development')
  useStore.getState().placeDevelopment([-79.389, 43.644])
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('development preview lifecycle', () => {
  it('cancels without persisting and ignores an in-flight preview response', async () => {
    let finish!: (value: DevelopmentPreview) => void
    const spec = useStore.getState().developmentDraft!
    vi.spyOn(api, 'previewDevelopment').mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const apply = vi.spyOn(api, 'applyDevelopment')
    const pending = useStore.getState().previewDevelopment()
    useStore.getState().setTool(null)
    finish(proposal(spec))
    await pending
    expect(useStore.getState().developmentDraft).toBeNull()
    expect(useStore.getState().developmentPreview).toBeNull()
    expect(useStore.getState().developmentPreviewing).toBe(false)
    expect(apply).not.toHaveBeenCalled()
  })

  it('invalidates a preview whenever an assumption or placement changes', async () => {
    const spec = useStore.getState().developmentDraft!
    vi.spyOn(api, 'previewDevelopment').mockResolvedValue(proposal(spec))
    await useStore.getState().previewDevelopment()
    expect(useStore.getState().developmentPreview).not.toBeNull()
    useStore.getState().setDevelopmentDraft({ ...spec, capacity: 501 })
    expect(useStore.getState().developmentPreview).toBeNull()
    expect(await useStore.getState().applyDevelopment()).toBeNull()
    useStore.getState().placeDevelopment([-79.387, 43.644])
    expect(useStore.getState().developmentDraft?.position).toEqual([-79.387, 43.644])
  })

  it('loads the confirmed branch without opening a parent run as the child', async () => {
    const parent = fixtureScenario()
    const child = fixtureScenario('child', 'parent')
    const spec = useStore.getState().developmentDraft!
    const preview = proposal(spec)
    child.developments = [preview.development]
    const parentRun = fixtureBundle(parent, [fixtureTraveler()], { incumbent: 100 }).run
    vi.spyOn(api, 'previewDevelopment').mockResolvedValue(preview)
    vi.spyOn(api, 'applyDevelopment').mockResolvedValue(child)
    vi.spyOn(api, 'scenarios').mockResolvedValue([parent, child])
    vi.spyOn(api, 'plans').mockResolvedValue([])
    vi.spyOn(api, 'runs').mockResolvedValue([parentRun])
    vi.spyOn(api, 'demand').mockResolvedValue(fixtureBundle(child, [fixtureTraveler()]).demand!)
    await useStore.getState().previewDevelopment()
    expect(await useStore.getState().applyDevelopment()).toEqual(child)
    expect(useStore.getState().scenarioId).toBe('child')
    expect(useStore.getState().primaryRunId).toBeNull()
    expect(useStore.getState().runs).toEqual([parentRun])
    expect(useStore.getState().developmentDraft).toBeNull()
  })

  it('flies to the newest saved building when a development branch loads', async () => {
    const parent = fixtureScenario()
    const child = fixtureScenario('child', 'parent')
    const first = { ...useStore.getState().developmentDraft!, position: [-79.395, 43.64] as [number, number], name: 'Older' }
    const newest = { ...useStore.getState().developmentDraft!, position: [-79.372, 43.655] as [number, number], name: 'Newest' }
    child.developments = [{ development_id: 'older', spec: first, access: [] }, { development_id: 'newest', spec: newest, access: [] }]
    const map = fakeMap()
    const unregister = registerMap('solo', map)
    vi.spyOn(api, 'plans').mockResolvedValue([])
    vi.spyOn(api, 'runs').mockResolvedValue([])
    vi.spyOn(api, 'demand').mockResolvedValue(fixtureBundle(child, [fixtureTraveler()]).demand!)
    useStore.setState({ scenarios: [parent, child] })
    await useStore.getState().selectScenario('child')
    const last = map.moves.at(-1)!
    expect(last.center).toEqual(newest.position)
    expect(last.zoom).toBeGreaterThan(16)
    expect(useStore.getState().cameraMode).toBe('development')
    expect(useStore.getState().selection).toEqual({ kind: 'development', id: 'newest' })
    expect(useStore.getState().tool).toBe('development')
    expect(useStore.getState().developmentDraft).toBeNull()
    expect(useStore.getState().focusDevelopment('older')).toBe(true)
    expect(map.moves.at(-1)!.center).toEqual(first.position)
    unregister()
  })

  it('defers the fly-to until a renderer registers after a cold reload', async () => {
    const child = fixtureScenario('child', 'parent')
    const spec = { ...useStore.getState().developmentDraft!, position: [-79.372, 43.655] as [number, number] }
    child.developments = [{ development_id: 'saved', spec, access: [] }]
    vi.spyOn(api, 'plans').mockResolvedValue([])
    vi.spyOn(api, 'runs').mockResolvedValue([])
    vi.spyOn(api, 'demand').mockResolvedValue(fixtureBundle(child, [fixtureTraveler()]).demand!)
    useStore.setState({ scenarios: [fixtureScenario(), child] })
    await useStore.getState().selectScenario('child')
    expect(useStore.getState().pendingDevelopmentFocus).toBe('saved')
    expect(useStore.getState().selection).toEqual({ kind: 'development', id: 'saved' })
    const map = fakeMap()
    const unregister = registerMap('solo', map)
    expect(useStore.getState().focusDevelopment(useStore.getState().pendingDevelopmentFocus!)).toBe(true)
    expect(map.moves.at(-1)!.center).toEqual(spec.position)
    expect(useStore.getState().pendingDevelopmentFocus).toBeNull()
    unregister()
  })

  it('does not fly anywhere for scenarios without developments', async () => {
    const map = fakeMap()
    const unregister = registerMap('solo', map)
    vi.spyOn(api, 'plans').mockResolvedValue([])
    vi.spyOn(api, 'runs').mockResolvedValue([])
    vi.spyOn(api, 'demand').mockResolvedValue(fixtureBundle(fixtureScenario(), [fixtureTraveler()]).demand!)
    await useStore.getState().selectScenario('parent')
    expect(map.moves).toEqual([])
    expect(useStore.getState().focusDevelopment()).toBe(false)
    unregister()
  })

  it('does not let a late parent replay replace the newly selected branch', async () => {
    const bundle = fixtureBundle(fixtureScenario(), [fixtureTraveler()])
    let finish!: (value: typeof bundle) => void
    useStore.setState({ runs: [bundle.run] })
    vi.spyOn(api, 'bundle').mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const pending = useStore.getState().openRun(bundle.run.run_id)
    useStore.setState({ scenarioId: 'child' })
    finish(bundle)
    await pending
    expect(useStore.getState().primaryRunId).toBeNull()
  })

  it('keeps the current scenario and draft when confirmation fails', async () => {
    const spec = useStore.getState().developmentDraft!
    vi.spyOn(api, 'previewDevelopment').mockResolvedValue(proposal(spec))
    vi.spyOn(api, 'applyDevelopment').mockRejectedValue(new Error('access changed'))
    await useStore.getState().previewDevelopment()
    expect(await useStore.getState().applyDevelopment()).toBeNull()
    expect(useStore.getState().scenarioId).toBe('parent')
    expect(useStore.getState().developmentDraft).toEqual(spec)
    expect(useStore.getState().building).toBeNull()
    expect(useStore.getState().developmentError).toContain('access changed')
  })
})
