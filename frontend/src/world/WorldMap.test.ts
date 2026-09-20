import { afterEach, describe, expect, it, vi } from 'vitest'

const mockedModules = ['react', 'maplibre-gl', 'mapbox-gl', '@deck.gl/mapbox', '@deck.gl/core', '../store', './playback', './registry', './layers']

afterEach(() => {
  for (const name of mockedModules) vi.doUnmock(name)
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function mountMap(token = '', constructorError?: Error) {
  vi.stubEnv('VITE_MAPBOX_TOKEN', token)
  const effects: (() => void | (() => void))[] = []
  const frames: FrameRequestCallback[] = []
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const order: string[] = []
  const setError = vi.fn()
  const select = vi.fn()
  const replay = { marker: 'recorded replay' }
  const state = { pack: null, roads: null, scenarios: [], scenarioId: null, replays: { recorded: replay }, selection: { kind: 'resident', id: 'r1' }, ghost: null, select, setError }
  const map = {
    addControl: vi.fn(), remove: vi.fn(), getZoom: () => 15,
    getCanvas: () => ({ style: {} }), isStyleLoaded: () => false,
    getLayer: () => undefined, addLayer: vi.fn(),
    on: vi.fn((name: string, callback: (event: unknown) => void) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name)!.add(callback)
    }),
    off: vi.fn((name: string, callback: (event: unknown) => void) => { listeners.get(name)?.delete(callback) }),
  }
  const worker = vi.fn((url: string) => { order.push(`worker:${url}`) })
  const maplibreMap = vi.fn(function () {
    order.push('maplibre-map')
    if (constructorError) throw constructorError
    return map
  })
  const mapboxMap = vi.fn(function () { order.push('mapbox-map'); return map })
  const overlay = { setProps: vi.fn() }
  const overlayConstructor = vi.fn(function (_props: unknown) { return overlay })
  const layers = [{ id: 'recorded-layer' }]
  const buildWorldLayers = vi.fn((_props: unknown) => layers)
  let ref = 0
  vi.doMock('react', () => ({
    useEffect: (effect: () => void | (() => void)) => { effects.push(effect) },
    useRef: (value: unknown) => ({ current: ref++ === 0 ? {} : value }),
  }))
  vi.doMock('maplibre-gl', () => ({ Map: maplibreMap, setWorkerUrl: worker }))
  vi.doMock('mapbox-gl', () => ({ default: { Map: mapboxMap, AttributionControl: class {}, accessToken: '' } }))
  vi.doMock('@deck.gl/mapbox', () => ({ MapboxOverlay: overlayConstructor }))
  vi.doMock('@deck.gl/core', () => ({ AmbientLight: class {}, DirectionalLight: class {}, LightingEffect: class {} }))
  vi.doMock('../store', () => ({ useStore: { getState: () => state, subscribe: () => () => {} } }))
  vi.doMock('./playback', () => ({ clock: { t: 12, onFrame: () => () => {} } }))
  vi.doMock('./registry', () => ({ registerMap: () => () => {}, renderStats: { layerRebuilds: 0 } }))
  vi.doMock('./layers', () => ({ buildWorldLayers, SLOT_NAMES: ['bottom', 'middle', 'top'], slotAnchorId: (slot: string) => `anchor-${slot}` }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('WebGL2RenderingContext', class { pixelStorei() {} texImage3D() {} })
  const module = await import('./WorldMap')
  module.default({ runId: 'recorded', side: 'solo' })
  const cleanups = effects.map((effect) => effect()).filter((cleanup) => typeof cleanup === 'function')
  await vi.waitFor(() => expect(maplibreMap.mock.calls.length + mapboxMap.mock.calls.length).toBe(1))
  return {
    module, map, worker, maplibreMap, mapboxMap, overlay, overlayConstructor, buildWorldLayers, replay, select, setError, order,
    emit: (name: string, event: unknown = {}) => { for (const callback of listeners.get(name) ?? []) callback(event) },
    frame: () => frames.shift()?.(0),
    cleanup: () => { for (const cleanup of cleanups) cleanup() },
  }
}

describe('basemap overlay compatibility', () => {
  it('does not use Mapbox private transform APIs for the MapLibre fallback', async () => {
    vi.stubEnv('VITE_MAPBOX_TOKEN', '')
    const { USE_INTERLEAVED_MAPBOX_LAYERS } = await import('./mapConfig')
    expect(USE_INTERLEAVED_MAPBOX_LAYERS).toBe(false)
  })

  it('preserves interleaved layers for configured Mapbox maps', async () => {
    vi.stubEnv('VITE_MAPBOX_TOKEN', 'public-map-token-fixture')
    const { USE_INTERLEAVED_MAPBOX_LAYERS } = await import('./mapConfig')
    expect(USE_INTERLEAVED_MAPBOX_LAYERS).toBe(true)
  })

  it('configures the Vite-bundled MapLibre worker before construction and exports only the component from TSX', async () => {
    const view = await mountMap()
    try {
      expect(Object.keys(view.module)).toEqual(['default'])
      expect(view.worker).toHaveBeenCalledOnce()
      const workerUrl = view.worker.mock.calls[0][0]
      expect(workerUrl).toContain('maplibre-gl-worker')
      expect(workerUrl).not.toContain('/.vite/deps/')
      expect(view.order).toEqual([`worker:${workerUrl}`, 'maplibre-map'])
      expect(view.overlayConstructor).toHaveBeenCalledWith(expect.objectContaining({ interleaved: false }))
      expect(view.mapboxMap).not.toHaveBeenCalled()
    } finally { view.cleanup() }
  })

  it('leaves Mapbox construction interleaved and does not configure a MapLibre worker for it', async () => {
    const view = await mountMap('public-map-token-fixture')
    try {
      expect(view.mapboxMap).toHaveBeenCalledOnce()
      expect(view.maplibreMap).not.toHaveBeenCalled()
      expect(view.worker).not.toHaveBeenCalled()
      expect(view.overlayConstructor).toHaveBeenCalledWith(expect.objectContaining({ interleaved: true }))
    } finally { view.cleanup() }
  })

  it('passes recorded replay, simulated time, and selection through to overlaid deck layers unchanged', async () => {
    const view = await mountMap()
    try {
      view.emit('style.load')
      view.frame()
      expect(view.buildWorldLayers).toHaveBeenCalledWith(expect.objectContaining({ replay: view.replay, t: 12, select: view.select, selection: { kind: 'resident', id: 'r1' } }))
      expect(view.overlay.setProps).toHaveBeenCalledWith({ layers: [{ id: 'recorded-layer' }] })
    } finally { view.cleanup() }
  })

  it('surfaces map source errors once, without retrying or updating an unmounted map', async () => {
    const view = await mountMap()
    view.emit('error', { error: new Error('Tile request failed'), sourceId: 'openmaptiles' })
    view.emit('error', { error: new Error('Tile request failed'), sourceId: 'openmaptiles' })
    expect(view.setError).toHaveBeenCalledOnce()
    expect(view.setError).toHaveBeenCalledWith(expect.stringMatching(/MapLibre.*openmaptiles.*Tile request failed/))
    expect(view.maplibreMap).toHaveBeenCalledOnce()
    view.cleanup()
    view.emit('error', { error: new Error('Late error') })
    expect(view.setError).toHaveBeenCalledOnce()
    expect(view.map.remove).toHaveBeenCalledOnce()
    expect(view.map.off).toHaveBeenCalledWith('error', expect.any(Function))
  })

  it('surfaces initialization failures instead of leaving an unhandled promise rejection', async () => {
    const view = await mountMap('', new Error('WebGL2 initialization failed'))
    try {
      await vi.waitFor(() => expect(view.setError).toHaveBeenCalledWith(expect.stringContaining('WebGL2 initialization failed')))
      expect(view.maplibreMap).toHaveBeenCalledOnce()
    } finally { view.cleanup() }
  })
})
