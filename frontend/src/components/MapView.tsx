import { useEffect, useMemo, useRef } from 'react'
import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { GeoJsonLayer, PathLayer, ScatterplotLayer, TextLayer, PolygonLayer } from '@deck.gl/layers'
import type { Layer, PickingInfo } from '@deck.gl/core'
import { useStore } from '../store'
import { entitiesAt, hazardFootprint, STATE_COLORS, trailAt, type EntityAt } from '../replay'

type MapLike = {
  addControl: (c: maplibregl.IControl, pos?: string) => unknown
  jumpTo: (o: { center: [number, number]; zoom: number }) => unknown
  remove: () => void
}

const OPENFREEMAP_STYLE = 'https://tiles.openfreemap.org/styles/positron'
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined

export default function MapView() {
  const containerRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<MapboxOverlay | null>(null)
  const mapRef = useRef<MapLike | null>(null)
  const pack = useStore((s) => s.pack)
  const roads = useStore((s) => s.roads)
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const primary = useStore((s) => (s.primaryRunId ? s.replays[s.primaryRunId] : null))
  const compare = useStore((s) => (s.compareRunId ? s.replays[s.compareRunId] : null))
  const t = useStore((s) => s.t)
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const showCars = useStore((s) => s.showCars)
  const showPersons = useStore((s) => s.showPersons)
  const showRoads = useStore((s) => s.showRoads)

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    let disposed = false
    const container = containerRef.current
    const overlay = new MapboxOverlay({ interleaved: false, layers: [] })
    overlayRef.current = overlay
    const init = async () => {
      let map: MapLike
      if (MAPBOX_TOKEN) {
        // Sponsor path: only taken when a real token is present. Mapbox Standard style.
        const mapboxgl = (await import('mapbox-gl')).default
        mapboxgl.accessToken = MAPBOX_TOKEN
        map = new mapboxgl.Map({
          container,
          style: 'mapbox://styles/mapbox/standard',
          center: [-80.5276, 43.4656],
          zoom: 13.6,
          pitch: 30,
        }) as unknown as MapLike
      } else {
        const m = new maplibregl.Map({
          container,
          style: OPENFREEMAP_STYLE,
          center: [-80.5276, 43.4656],
          zoom: 13.6,
          pitch: 30,
          attributionControl: { compact: true },
        })
        m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right')
        map = m as unknown as MapLike
      }
      if (disposed) {
        map.remove()
        return
      }
      map.addControl(overlay as unknown as maplibregl.IControl)
      mapRef.current = map
    }
    void init()
    return () => {
      disposed = true
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    if (pack && mapRef.current) mapRef.current.jumpTo({ center: pack.venue_lonlat, zoom: 13.6 })
  }, [pack])

  const closedNow = useMemo(() => {
    const set = new Set<string>()
    for (const r of scenario?.restrictions ?? []) if (t >= r.start_s && t <= r.end_s) r.edge_ids.forEach((e) => set.add(e))
    return set
  }, [scenario, t])

  const closedFeatures = useMemo(() => {
    if (!roads) return []
    return roads.features.filter((f) => closedNow.has(String(f.properties?.id)))
  }, [roads, closedNow])

  const planStops = useMemo(() => {
    const s = new Set<string>()
    for (const d of primary?.bundle.compile?.duties ?? []) d.stop_sequence.forEach((x) => s.add(x))
    return s
  }, [primary])

  const layers = useMemo(() => {
    const out: Layer[] = []
    if (roads && showRoads) {
      out.push(
        new GeoJsonLayer({
          id: 'roads',
          data: roads,
          stroked: true,
          filled: false,
          getLineColor: [40, 60, 90, 90],
          getLineWidth: 2,
          lineWidthMinPixels: 1,
          lineWidthMaxPixels: 3,
        }),
      )
    }
    if (closedFeatures.length) {
      out.push(
        new GeoJsonLayer({
          id: 'closed',
          data: { type: 'FeatureCollection', features: closedFeatures },
          stroked: true,
          filled: false,
          getLineColor: [255, 60, 60, 230],
          getLineWidth: 8,
          lineWidthMinPixels: 4,
          pickable: true,
          onClick: () => select({ kind: 'restriction', id: scenario?.restrictions[0]?.restriction_id ?? '' }),
        }),
      )
    }
    for (const h of scenario?.hazards ?? []) {
      const fp = hazardFootprint(h, t)
      if (!fp) continue
      out.push(
        new PolygonLayer({
          id: `hazard-${h.track_id}`,
          data: [fp],
          getPolygon: (d) => d.ring,
          getFillColor: [120, 80, 255, 60],
          getLineColor: [140, 100, 255, 220],
          getLineWidth: 3,
          lineWidthMinPixels: 2,
          stroked: true,
          filled: true,
        }),
      )
      out.push(
        new PathLayer({
          id: `hazard-track-${h.track_id}`,
          data: [{ path: h.waypoints }],
          getPath: (d) => d.path,
          getColor: [140, 100, 255, 120],
          getWidth: 3,
          widthMinPixels: 1,
          getDashArray: [6, 4],
        }),
      )
    }
    if (pack) {
      out.push(
        new ScatterplotLayer({
          id: 'stops',
          data: pack.stops,
          getPosition: (d) => [d.lon, d.lat],
          getRadius: (d) => (planStops.has(d.stop_id) ? 14 : 7),
          radiusMinPixels: 2,
          radiusMaxPixels: 12,
          getFillColor: (d) => (planStops.has(d.stop_id) ? [255, 255, 255, 240] : [130, 150, 190, 150]),
          getLineColor: [20, 30, 50, 200],
          lineWidthMinPixels: 1,
          stroked: true,
          pickable: true,
          onClick: (info: PickingInfo) => info.object && select({ kind: 'stop', id: info.object.stop_id }),
          updateTriggers: { getRadius: [planStops], getFillColor: [planStops] },
        }),
      )
      out.push(
        new TextLayer({
          id: 'zones',
          data: pack.zones,
          getPosition: (d) => [d.lon, d.lat],
          getText: (d) => d.name,
          getSize: 13,
          getColor: [200, 210, 230, 220],
          getPixelOffset: [0, -14],
          background: true,
          getBackgroundColor: [10, 14, 24, 180],
          fontFamily: 'ui-sans-serif, system-ui',
        }),
      )
      out.push(
        new ScatterplotLayer({
          id: 'venue',
          data: [pack.venue_lonlat],
          getPosition: (d) => d,
          getRadius: 60,
          radiusMinPixels: 6,
          getFillColor: [255, 200, 60, 40],
          getLineColor: [255, 200, 60, 220],
          lineWidthMinPixels: 2,
          stroked: true,
        }),
      )
    }
    const renderRun = (rx: NonNullable<typeof primary>, ghost: boolean) => {
      const ents = entitiesAt(rx, t)
      const buses = ents.filter((e) => e.kind === 'bus')
      const cars = ents.filter((e) => e.kind === 'car')
      const persons = ents.filter((e) => e.kind === 'person')
      const suffix = ghost ? '-ghost' : ''
      const trails = buses.flatMap((b) =>
        trailAt(rx.tracks[b.id], t, 240).map((path) => ({ path, id: b.id })),
      )
      out.push(
        new PathLayer({
          id: `bus-trails${suffix}`,
          data: trails,
          getPath: (d) => d.path,
          getColor: ghost ? [255, 140, 40, 120] : [0, 210, 255, 170],
          getWidth: ghost ? 3 : 5,
          widthMinPixels: 2,
          capRounded: true,
          jointRounded: true,
        }),
      )
      if (!ghost && showCars) {
        out.push(
          new ScatterplotLayer<EntityAt>({
            id: 'cars',
            data: cars,
            getPosition: (d) => [d.lon, d.lat],
            getRadius: 3.5,
            radiusMinPixels: 1.5,
            radiusMaxPixels: 5,
            getFillColor: (d) => (d.id.startsWith('car_p') ? [180, 180, 255, 200] : [110, 120, 140, 140]),
            pickable: true,
            onClick: (info: PickingInfo<EntityAt>) => info.object && select({ kind: 'car', id: info.object.id }),
          }),
        )
      }
      if (!ghost && showPersons) {
        out.push(
          new ScatterplotLayer<EntityAt>({
            id: 'persons',
            data: persons,
            getPosition: (d) => [d.lon, d.lat],
            getRadius: 4,
            radiusMinPixels: 2.5,
            radiusMaxPixels: 7,
            getFillColor: (d) => [...STATE_COLORS[d.state ?? 'walking'], 230] as [number, number, number, number],
            getLineColor: (d) => (selection?.kind === 'person' && selection.id === d.id ? [255, 255, 255, 255] : [0, 0, 0, 0]),
            lineWidthMinPixels: 2,
            stroked: true,
            pickable: true,
            onClick: (info: PickingInfo<EntityAt>) => info.object && select({ kind: 'person', id: info.object.id }),
            updateTriggers: { getLineColor: [selection] },
          }),
        )
      }
      out.push(
        new ScatterplotLayer<EntityAt>({
          id: `buses${suffix}`,
          data: buses,
          getPosition: (d) => [d.lon, d.lat],
          getRadius: 14,
          radiusMinPixels: 7,
          radiusMaxPixels: 22,
          getFillColor: (d) => {
            if (ghost) return [255, 140, 40, 160]
            const occ = d.occupancy ?? 0
            return occ >= 55 ? [255, 80, 80, 240] : occ >= 30 ? [255, 190, 60, 240] : [0, 210, 255, 240]
          },
          getLineColor: (d) => (selection?.kind === 'bus' && selection.id === d.id && !ghost ? [255, 255, 255, 255] : [10, 20, 30, 220]),
          lineWidthMinPixels: 2,
          stroked: true,
          pickable: !ghost,
          onClick: (info: PickingInfo<EntityAt>) => info.object && select({ kind: 'bus', id: info.object.id }),
          updateTriggers: { getLineColor: [selection] },
        }),
      )
      out.push(
        new TextLayer<EntityAt>({
          id: `bus-labels${suffix}`,
          data: buses,
          getPosition: (d) => [d.lon, d.lat],
          getText: (d) => `${d.id}${ghost ? ' (compare)' : ''}  ${d.occupancy ?? 0} pax`,
          getSize: 12,
          getColor: ghost ? [255, 170, 90, 230] : [230, 245, 255, 240],
          getPixelOffset: [0, -20],
          background: true,
          getBackgroundColor: [8, 12, 20, 200],
          fontFamily: 'ui-monospace, Menlo, monospace',
        }),
      )
    }
    if (compare) renderRun(compare, true)
    if (primary) renderRun(primary, false)
    return out
  }, [roads, showRoads, closedFeatures, scenario, pack, planStops, primary, compare, t, showCars, showPersons, selection, select])

  useEffect(() => {
    overlayRef.current?.setProps({ layers })
  }, [layers])

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map" />
      <div className="map-badge">
        {MAPBOX_TOKEN ? 'Mapbox Standard (token present)' : 'MapLibre + OpenFreeMap tiles (no Mapbox token)'} · road/stop geometry: OpenStreetMap via netconvert
      </div>
    </div>
  )
}
