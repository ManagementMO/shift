import { useEffect, useRef } from 'react'
import type { IControl } from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { AmbientLight, DirectionalLight, LightingEffect } from '@deck.gl/core'
import { useStore } from '../store'
import { clock } from './playback'
import { buildWorldLayers, SLOT_NAMES, slotAnchorId } from './layers'
import { cityPose, TORONTO_CITY, type CameraPose } from './camera'
import { registerMap, renderStats } from './registry'

type MapLike = {
  addControl: (c: IControl, pos?: string) => unknown
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

const MAPBOX_TOKEN = (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined)?.trim()

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
  const runIdRef = useRef(runId)
  const redrawRef = useRef<() => void>(() => {})
  useEffect(() => {
    runIdRef.current = runId
    redrawRef.current()
  }, [runId])

  useEffect(() => {
    if (!MAPBOX_TOKEN || !containerRef.current || mapRef.current) return
    const container = containerRef.current
    let disposed = false
    let unregister = () => {}
    let stopFrame = () => {}
    let unsub = () => {}

    const init = async () => {
      const mapboxgl = (await import('mapbox-gl')).default
      // React StrictMode and route changes can dispose this effect while the module loads.
      if (disposed) return
      patchTexImage3D()
      const overlay = new MapboxOverlay({
        interleaved: true,
        layers: [],
        effects: [LIGHTING],
        useDevicePixels: true,
      })
      const pack = useStore.getState().pack
      const pose = pack ? cityPose(pack.pack_id, pack.center) : TORONTO_CITY
      const m = new mapboxgl.Map({
        container,
        accessToken: MAPBOX_TOKEN,
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
      mapRef.current = m as unknown as MapLike
      m.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right')
      const map = mapRef.current
      // Invisible per-slot anchor layers that deck layer groups are inserted before (see SLOT in layers.ts).
      let anchorsReady = false
      const ensureAnchors = () => {
        for (const slot of SLOT_NAMES) {
          const id = slotAnchorId(slot)
          if (map.getLayer(id)) continue
          map.addLayer({ id, type: 'background', slot, paint: { 'background-opacity': 0 } })
        }
        anchorsReady = true
      }
      map.on('style.load', ensureAnchors as (e: never) => void)
      if (map.isStyleLoaded()) ensureAnchors()

      map.addControl(overlay as unknown as IControl)
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
            dimOthers: s.selection?.kind === 'person',
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
    void init().catch(() => {
      if (!disposed) useStore.getState().setError('Mapbox could not load. Check the map token and network connection, then reload.')
    })
    return () => {
      disposed = true
      stopFrame()
      unsub()
      unregister()
      mapRef.current?.remove()
      mapRef.current = null
      redrawRef.current = () => {}
    }
  }, [side])

  return (
    <div ref={containerRef} className={`world world-${side}`}>
      {!MAPBOX_TOKEN && (
        <div className="map-notice glass" role="status">
          <b>Connect Mapbox to load the 3D city</b>
          <p>Add the Mapbox token to the frontend environment, then restart the app.</p>
        </div>
      )}
    </div>
  )
}
