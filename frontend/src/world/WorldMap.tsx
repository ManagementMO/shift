import { useEffect, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { AmbientLight, DirectionalLight, LightingEffect } from '@deck.gl/core'
import { useStore } from '../store'
import { clock } from './playback'
import { buildWorldLayers, SLOT_NAMES, slotAnchorId } from './layers'
import { cityPose, TORONTO_CITY, type CameraPose } from './camera'
import { registerMap, renderStats } from './registry'
import { MAPBOX_TOKEN, MAPLIBRE_WORKER_URL, OPENFREEMAP_STYLE, USE_INTERLEAVED_MAPBOX_LAYERS } from './mapConfig'

type MapLike = {
  addControl: (c: maplibregl.IControl, pos?: string) => unknown
  remove: () => void
  getZoom: () => number
  on: (ev: string, cb: (e: never) => void) => unknown
  off: (ev: string, cb: (e: never) => void) => unknown
  once: (ev: string, cb: () => void) => unknown
  isStyleLoaded: () => boolean
  getLayer: (id: string) => unknown
  addLayer: (layer: { id: string; type: 'background'; slot?: string; paint: Record<string, unknown> }) => unknown
  getCanvas: () => HTMLCanvasElement
  setConfigProperty?: (imp: string, key: string, value: unknown) => unknown
  jumpTo: (o: Partial<CameraPose>) => unknown
} & Parameters<typeof registerMap>[1]

// Mapbox Standard, art-directed: no POI/transit/road-label clutter, faded palette, warm daylight.
const STANDARD_CONFIG: Record<string, unknown> = {
  lightPreset: 'day',
  theme: 'faded',
  show3dObjects: true,
  showPlaceLabels: false,
  showRoadLabels: false,
  showPointOfInterestLabels: false,
  showTransitLabels: false,
  showPedestrianRoads: true,
  showLandmarkIcons: false,
  showLandmarkIconLabels: false,
  showAdminBoundaries: false,
  colorWater: 'rgb(84, 121, 150)',
  colorGreenspace: 'rgb(178, 190, 150)',
  colorRoads: 'rgb(120, 116, 112)',
  colorMotorways: 'rgb(140, 128, 118)',
  colorTrunks: 'rgb(132, 124, 116)',
  colorBuildingHighlight: 'rgb(210, 198, 184)',
}

// Sharing one WebGL2 context between Mapbox and luma.gl means two independent GL-state caches. luma leaves
// UNPACK_FLIP_Y / PREMULTIPLY_ALPHA set after uploading 2D textures and also patches the context instance's
// pixelStorei/getParameter to serve cached values, so Mapbox's own cache never re-applies them. Mapbox Standard
// then fails its texImage3D colour-grading LUT upload (INVALID_OPERATION) and 3D buildings/landmarks render
// black. Clear the flags through the *native* prototype methods before any 3D texture upload.
const patchTexImage3D = () => {
  const proto = WebGL2RenderingContext.prototype as WebGL2RenderingContext & { __cityshiftPatched?: boolean }
  if (proto.__cityshiftPatched) return
  proto.__cityshiftPatched = true
  const nativePixelStorei = proto.pixelStorei
  const orig = proto.texImage3D
  proto.texImage3D = function (this: WebGL2RenderingContext, ...args: unknown[]) {
    nativePixelStorei.call(this, this.UNPACK_FLIP_Y_WEBGL, false)
    nativePixelStorei.call(this, this.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    const r = (orig as (...a: unknown[]) => void).apply(this, args)
    // let both caches re-apply whatever they believe on the next 2D upload
    this.pixelStorei(this.UNPACK_FLIP_Y_WEBGL, false)
    this.pixelStorei(this.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    return r
  } as typeof proto.texImage3D
}

const LIGHTING = new LightingEffect({
  ambient: new AmbientLight({ color: [255, 248, 236], intensity: 1.55 }),
  sun: new DirectionalLight({ color: [255, 240, 220], intensity: 1.6, direction: [-1.2, -2.2, -3] }),
  fill: new DirectionalLight({ color: [200, 216, 240], intensity: 0.5, direction: [2, 1.5, -1] }),
})

export default function WorldMap({ runId, side }: { runId: string | null; side: 'solo' | 'left' | 'right' }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLike | null>(null)
  const overlayRef = useRef<MapboxOverlay | null>(null)
  const runIdRef = useRef(runId)
  const redrawRef = useRef<() => void>(() => {})
  useEffect(() => {
    runIdRef.current = runId
    redrawRef.current()
  }, [runId])

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const container = containerRef.current
    let disposed = false
    let unregister = () => {}
    let stopFrame = () => {}
    let unsub = () => {}
    let detachError = () => {}
    let lastError: string | null = null
    const reportError = (error: unknown, sourceId?: string) => {
      if (disposed) return
      let detail = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error ?? 'Unknown map error')
      if (MAPBOX_TOKEN) detail = detail.replaceAll(MAPBOX_TOKEN, '[redacted]')
      detail = detail.replace(/([?&](?:access_token|token|api_key|key)=)[^&\s]*/gi, '$1[redacted]')
      const message = `${MAPBOX_TOKEN ? 'Mapbox' : 'MapLibre'} basemap${sourceId ? ` (${sourceId})` : ''}: ${detail}`
      if (message === lastError) return
      lastError = message
      useStore.getState().setError(message)
    }

    if (USE_INTERLEAVED_MAPBOX_LAYERS) patchTexImage3D()
    const overlay = new MapboxOverlay({
      interleaved: USE_INTERLEAVED_MAPBOX_LAYERS,
      layers: [],
      effects: [LIGHTING],
      useDevicePixels: true,
      pickingRadius: 6,
    })
    overlayRef.current = overlay

    const init = async () => {
      const pack = useStore.getState().pack
      const pose = pack ? cityPose(pack.pack_id, pack.center) : TORONTO_CITY
      let map: MapLike
      if (MAPBOX_TOKEN) {
        const mapboxgl = (await import('mapbox-gl')).default
        mapboxgl.accessToken = MAPBOX_TOKEN
        const m = new mapboxgl.Map({
          container,
          style: 'mapbox://styles/mapbox/standard',
          center: pose.center,
          zoom: pose.zoom,
          pitch: pose.pitch,
          bearing: pose.bearing,
          antialias: true,
          attributionControl: false,
          logoPosition: 'bottom-right',
          maxPitch: 75,
          minZoom: 11,
          config: { basemap: STANDARD_CONFIG },
        } as ConstructorParameters<typeof mapboxgl.Map>[0])
        m.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right')
        map = m as unknown as MapLike
      } else {
        maplibregl.setWorkerUrl(MAPLIBRE_WORKER_URL)
        const m = new maplibregl.Map({
          container,
          style: OPENFREEMAP_STYLE,
          center: pose.center,
          zoom: pose.zoom,
          pitch: pose.pitch,
          bearing: pose.bearing,
          maxPitch: 75,
          attributionControl: { compact: true },
        })
        map = m as unknown as MapLike
      }
      if (disposed) {
        map.remove()
        return
      }
      mapRef.current = map
      const onMapError = (event: { error?: unknown; sourceId?: string }) => reportError(event.error, event.sourceId)
      map.on('error', onMapError as (e: never) => void)
      detachError = () => { map.off('error', onMapError as (e: never) => void) }
      // Invisible per-slot anchor layers that deck layer groups are inserted before (see SLOT in layers.ts).
      let anchorsReady = false
      const ensureAnchors = () => {
        for (const slot of SLOT_NAMES) {
          const id = slotAnchorId(slot)
          if (map.getLayer(id)) continue
          map.addLayer({ id, type: 'background', ...(MAPBOX_TOKEN ? { slot } : {}), paint: { 'background-opacity': 0 } })
        }
        anchorsReady = true
      }
      map.on('style.load', ensureAnchors as (e: never) => void)
      if (map.isStyleLoaded()) ensureAnchors()

      map.addControl(overlay as unknown as maplibregl.IControl)
      unregister = registerMap(side, map)

      let dirty = true
      const redraw = () => {
        dirty = true
      }
      redrawRef.current = redraw
      const draw = () => {
        if (!dirty || disposed || !anchorsReady) return
        dirty = false
        renderStats.layerRebuilds++
        const s = useStore.getState()
        const rid = runIdRef.current
        const focusEdges = s.selection?.kind === 'restriction' ? s.scenarios.find((x) => x.scenario_id === s.scenarioId)?.restrictions.find((r) => r.restriction_id === s.selection?.id)?.edge_ids : undefined
        overlay.setProps({
          layers: buildWorldLayers({
            pack: s.pack,
            roads: s.roads,
            scenario: s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null,
            replay: rid ? s.replays[rid] ?? null : null,
            t: clock.t,
            zoom: map.getZoom(),
            selection: s.selection,
            select: s.select,
            ghostEdges: s.ghost?.edges,
            ghostStops: s.ghost?.stops,
            ghostHazard: s.ghost?.hazard,
            focusCorridorEdges: focusEdges,
            dimOthers: s.selection?.kind === 'person' || s.selection?.kind === 'resident',
            side: side === 'solo' ? undefined : side,
          }),
        })
      }
      // Renderer loop: one rAF; only rebuilds layers when time/state/zoom changed.
      let raf = 0
      const loop = () => {
        draw()
        raf = requestAnimationFrame(loop)
      }
      raf = requestAnimationFrame(loop)
      const offFrame = clock.onFrame(redraw)
      stopFrame = () => {
        cancelAnimationFrame(raf)
        offFrame()
      }
      unsub = useStore.subscribe(redraw)
      map.on('zoom', redraw as (e: never) => void)
      map.on('style.load', redraw as (e: never) => void)
      map.getCanvas().style.cursor = 'default'
    }
    void init().catch((error: unknown) => reportError(error))
    return () => {
      disposed = true
      stopFrame()
      unsub()
      unregister()
      detachError()
      mapRef.current?.remove()
      mapRef.current = null
      overlayRef.current = null
      redrawRef.current = () => {}
    }
  }, [side])

  return <div ref={containerRef} className={`world world-${side}`} />
}
