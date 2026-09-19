// deck.gl layer factory for the world. Pure: (pack, scenario, replay, t, view) -> layers.
// Every moving thing here is a stored TraCI sample; decoration (trails fading, tornado column, debris) is
// derived from those records or from the declared hazard track and is never fed back into the metrics.

import { GeoJsonLayer, PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { SimpleMeshLayer } from '@deck.gl/mesh-layers'
import { TripsLayer } from '@deck.gl/geo-layers'
import { ConeGeometry, CubeGeometry, CylinderGeometry } from '@luma.gl/engine'
import type { Layer, PickingInfo } from '@deck.gl/core'
import type { Selection } from '../store'
import type { CityPack, HazardTrack, ScenarioSpec, StopCandidate } from '../types'
import { entitiesAt, hazardFootprint, MAX_GAP_S, type EntityAt, type PersonState, type ReplayIndex, type TrackIndex } from '../replay'

export type RGBA = [number, number, number, number]

const withA = (c: RGBA, a: number): RGBA => [c[0], c[1], c[2], a]

// Mapbox Standard slots (interleaved): ground under buildings, middle between, top above.
// Every deck layer is pinned before an invisible anchor style layer in its slot (see WorldMap). deck's
// MapboxOverlay only keeps a stable layer order for groups that have a `beforeId`; several slot groups
// without one each expect to be last and re-`moveLayer` each other every frame, which dirties the style,
// fires `styledata`, and keeps Mapbox repainting forever even when nothing changed.
export const SLOT_NAMES = ['bottom', 'middle', 'top'] as const
export type SlotName = (typeof SLOT_NAMES)[number]
export const slotAnchorId = (slot: SlotName) => `cityshift-anchor-${slot}`
const SLOT = {
  bottom: { slot: 'bottom', beforeId: slotAnchorId('bottom') },
  middle: { slot: 'middle', beforeId: slotAnchorId('middle') },
  top: { slot: 'top', beforeId: slotAnchorId('top') },
} as const

// Art direction: physical-miniature palette (see docs/visual-direction). Not neon.
export const PALETTE = {
  intervention: [46, 196, 232, 255] as RGBA, // cyan: selected intervention / shuttle buses
  amber: [236, 168, 64, 255] as RGBA, // stress / warning
  coral: [214, 84, 74, 255] as RGBA, // severe / failure / closure
  gold: [255, 232, 180, 255] as RGBA, // selected citizen
  stone: [205, 196, 182, 255] as RGBA,
  car: [188, 178, 166, 235] as RGBA,
  cohortCar: [168, 182, 204, 240] as RGBA,
  stop: [246, 240, 228, 235] as RGBA,
  stopRing: [72, 66, 60, 220] as RGBA,
  hazard: [92, 98, 112, 255] as RGBA,
}

export const PERSON_COLORS: Record<PersonState, RGBA> = {
  not_departed: [150, 146, 140, 160],
  walking: [238, 206, 132, 240],
  waiting: [236, 150, 64, 245],
  riding: [46, 196, 232, 240],
  arrived: [132, 178, 126, 200],
  unroutable: [214, 84, 74, 240],
  driving: [168, 182, 204, 230],
}

const BUS_MESH = new CubeGeometry()
const CAR_MESH = new CubeGeometry()
const PERSON_MESH = new CylinderGeometry({ radius: 1, height: 1, nradial: 8, topCap: true, bottomCap: true })
const CONE_MESH = new ConeGeometry({ radius: 1, height: 1, nradial: 14, cap: false })

export type Trip = { id: string; path: [number, number][]; timestamps: number[] }

const tripCache = new WeakMap<ReplayIndex, { bus: Trip[]; car: Trip[] }>()

function tripsFor(ix: TrackIndex): Trip[] {
  const out: Trip[] = []
  let path: [number, number][] = []
  let ts: number[] = []
  const flush = () => {
    if (path.length > 1) out.push({ id: ix.track.entity_id, path, timestamps: ts })
    path = []
    ts = []
  }
  ix.track.samples.forEach((s, i) => {
    if (ix.breakSet.has(i) || (ts.length && s[0] - ts[ts.length - 1] > MAX_GAP_S)) flush()
    path.push([s[1], s[2]])
    ts.push(s[0])
  })
  flush()
  return out
}

export function tripsOf(rx: ReplayIndex): { bus: Trip[]; car: Trip[] } {
  let c = tripCache.get(rx)
  if (!c) {
    c = { bus: [], car: [] }
    for (const ix of Object.values(rx.tracks)) {
      if (ix.track.kind === 'bus') c.bus.push(...tripsFor(ix))
      else if (ix.track.kind === 'car') c.car.push(...tripsFor(ix))
    }
    tripCache.set(rx, c)
  }
  return c
}

export type WorldInputs = {
  pack: CityPack | null
  roads: GeoJSON.FeatureCollection | null
  scenario: ScenarioSpec | null
  replay: ReplayIndex | null
  t: number
  zoom: number
  selection: Selection
  select: (s: Selection) => void
  ghostStops?: StopCandidate[]
  ghostEdges?: string[]
  ghostHazard?: HazardTrack | null
  focusCorridorEdges?: string[]
  dimOthers?: boolean
  side?: string
}

function sumoYaw(angle: number): number {
  return 90 - angle
}

/** Ground metres per screen pixel at Toronto latitude for a given zoom. */
function metresPerPixel(zoom: number): number {
  return (156543.03 * Math.cos((43.64 * Math.PI) / 180)) / 2 ** zoom
}

/** Miniature-city exaggeration: real size in metres, but never smaller than `minPx` on screen. Positions stay measured. */
function presentational(realM: number, minPx: number, zoom: number): number {
  return Math.max(realM, minPx * metresPerPixel(zoom))
}

function busColor(occ: number, cap: number): RGBA {
  const f = occ / Math.max(1, cap)
  if (f >= 0.9) return withA(PALETTE.coral, 255)
  if (f >= 0.55) return withA(PALETTE.amber, 255)
  return withA(PALETTE.intervention, 255)
}

export function buildWorldLayers(w: WorldInputs): Layer[] {
  const { pack, roads, scenario, replay, t, zoom, selection, select } = w
  const sfx = w.side ? `-${w.side}` : ''
  const out: Layer[] = []
  const selectedId = selection?.id ?? null
  const dim = w.dimOthers && selection && (selection.kind === 'person' || selection.kind === 'bus' || selection.kind === 'car')

  // --- closures & focus corridors (ground, below buildings) ---
  const closedNow = new Set<string>()
  for (const r of scenario?.restrictions ?? []) if (t >= r.start_s && t <= r.end_s) r.edge_ids.forEach((e) => closedNow.add(e))
  const ghostEdges = new Set(w.ghostEdges ?? [])
  const focus = new Set(w.focusCorridorEdges ?? [])
  if (roads && (closedNow.size || ghostEdges.size || focus.size)) {
    const feats = roads.features.filter((f) => {
      const id = String(f.properties?.id)
      return closedNow.has(id) || ghostEdges.has(id) || focus.has(id)
    })
    // Road markings sit in the middle slot: above Mapbox's road lines, under 3D buildings.
    const glowFeats = feats.filter((f) => closedNow.has(String(f.properties?.id)) || ghostEdges.has(String(f.properties?.id)))
    if (glowFeats.length) {
      out.push(
        new GeoJsonLayer({
          ...SLOT.middle,
          id: `edges-closed-glow${sfx}`,
          data: { type: 'FeatureCollection', features: glowFeats },
          stroked: true,
          filled: false,
          getLineColor: (f) => (closedNow.has(String(f.properties?.id)) ? withA(PALETTE.coral, 70) : withA(PALETTE.intervention, 60)),
          getLineWidth: 26,
          lineWidthUnits: 'meters',
          lineWidthMinPixels: 10,
          lineCapRounded: true,
          lineJointRounded: true,
          updateTriggers: { getLineColor: [closedNow.size, ghostEdges.size] },
          parameters: { depthCompare: 'always' },
        }),
      )
    }
    out.push(
      new GeoJsonLayer({
        ...SLOT.middle,
        id: `edges-marked${sfx}`,
        data: { type: 'FeatureCollection', features: feats },
        stroked: true,
        filled: false,
        getLineColor: (f) => {
          const id = String(f.properties?.id)
          if (closedNow.has(id)) return withA(PALETTE.coral, 245)
          if (ghostEdges.has(id)) return withA(PALETTE.intervention, 230)
          return withA(PALETTE.gold, 150)
        },
        getLineWidth: (f) => (closedNow.has(String(f.properties?.id)) || ghostEdges.has(String(f.properties?.id)) ? 9 : 5),
        lineWidthUnits: 'meters',
        lineWidthMinPixels: 3,
        lineCapRounded: true,
        lineJointRounded: true,
        pickable: closedNow.size > 0,
        onClick: (info: PickingInfo) => {
          const id = String(info.object?.properties?.id)
          const r = scenario?.restrictions.find((x) => x.edge_ids.includes(id))
          if (r) select({ kind: 'restriction', id: r.restriction_id })
        },
        updateTriggers: { getLineColor: [closedNow.size, ghostEdges.size, focus.size], getLineWidth: [closedNow.size, ghostEdges.size] },
        parameters: { depthCompare: 'always' },
      }),
    )
  }

  // --- hazard: declared moving region (footprint + column + debris) ---
  const hazards: HazardTrack[] = [...(scenario?.hazards ?? [])]
  if (w.ghostHazard) hazards.push(w.ghostHazard)
  for (const h of hazards) {
    const isGhost = w.ghostHazard?.track_id === h.track_id && !scenario?.hazards.some((x) => x.track_id === h.track_id)
    out.push(
      new PathLayer({
        ...SLOT.middle,
        id: `hazard-path-${h.track_id}${sfx}`,
        data: [{ path: h.waypoints }],
        getPath: (d) => d.path,
        getColor: withA(PALETTE.hazard, isGhost ? 120 : 90),
        getWidth: 14,
        widthUnits: 'meters',
        widthMinPixels: 2,
        capRounded: true,
        jointRounded: true,
      }),
    )
    const fp = hazardFootprint(h, t)
    if (!fp) continue
    out.push(
      new PolygonLayer({
        ...SLOT.middle,
        id: `hazard-shadow-${h.track_id}${sfx}`,
        data: [fp],
        getPolygon: (d) => d.ring,
        getFillColor: [30, 32, 40, isGhost ? 40 : 70],
        getLineColor: withA(PALETTE.amber, 160),
        getLineWidth: 4,
        lineWidthUnits: 'meters',
        lineWidthMinPixels: 1,
        stroked: true,
        filled: true,
      }),
    )
    if (isGhost) continue
    const spin = (t * 140) % 360
    const height = Math.max(320, h.radius_m * 1.6)
    // Funnel: a dense core plus translucent, slightly offset shells so the column reads as a rotating vortex
    // rather than a solid monolith.  Purely presentational — the modeled hazard is the footprint above.
    const shells = [
      { k: 0.16, a: 120, dx: 0, tilt: 0 },
      { k: 0.3, a: 60, dx: 0.06, tilt: 6 },
      { k: 0.42, a: 34, dx: -0.05, tilt: -4 },
      { k: 0.55, a: 20, dx: 0.09, tilt: 8 },
    ]
    shells.forEach((s, i) => {
      const off = h.radius_m * s.dx * Math.sin(t * 0.9 + i)
      const dLat = off / 111320
      const dLon = off / (111320 * Math.cos((fp.center[1] * Math.PI) / 180))
      out.push(
        new SimpleMeshLayer({
          ...SLOT.top,
          id: `hazard-column-${i}-${h.track_id}${sfx}`,
          data: [{ p: fp.center }],
          mesh: CONE_MESH,
          getPosition: (d) => [d.p[0] + dLon, d.p[1] + dLat, height / 2],
          getOrientation: [s.tilt, (spin * (1 + i * 0.15)) % 360, 180],
          getScale: [h.radius_m * s.k, h.radius_m * s.k, height * (1 + i * 0.08)],
          getColor: [150, 152, 162, s.a],
          material: { ambient: 0.7, diffuse: 0.35, shininess: 4, specularColor: [30, 30, 30] },
          parameters: { cullMode: 'none', depthWriteEnabled: false },
        }),
      )
    })
    const debris: { p: [number, number, number]; r: number }[] = []
    const n = 220
    for (let i = 0; i < n; i++) {
      const phase = (i / n) * Math.PI * 2
      const ang = phase + t * 1.6 + i * 0.37
      const frac = (i % 11) / 11
      const rad = h.radius_m * (0.15 + 0.9 * frac) * (0.8 + 0.4 * Math.sin(t * 0.7 + i))
      const z = frac * height * 0.9 * (0.6 + 0.4 * Math.sin(t * 1.1 + phase))
      const dLat = rad / 111320
      const dLon = rad / (111320 * Math.cos((fp.center[1] * Math.PI) / 180))
      debris.push({ p: [fp.center[0] + dLon * Math.cos(ang), fp.center[1] + dLat * Math.sin(ang), z], r: 1.2 + (i % 4) })
    }
    out.push(
      new ScatterplotLayer({
        ...SLOT.top,
        id: `hazard-debris-${h.track_id}${sfx}`,
        data: debris,
        getPosition: (d) => d.p,
        getRadius: (d) => d.r,
        radiusUnits: 'meters',
        radiusMinPixels: 1,
        getFillColor: [120, 112, 100, 200],
        billboard: true,
      }),
    )
  }

  // --- stops & venue ---
  if (pack) {
    const planStops = new Set<string>()
    for (const d of replay?.bundle.compile?.duties ?? []) d.stop_sequence.forEach((x) => planStops.add(x))
    const stopData = zoom < 13.8 ? pack.stops.filter((s) => planStops.has(s.stop_id)) : pack.stops
    out.push(
      new ScatterplotLayer<StopCandidate>({
        ...SLOT.middle,
        id: `stops${sfx}`,
        data: stopData,
        getPosition: (d) => [d.lon, d.lat, 0.3],
        getRadius: (d) => (planStops.has(d.stop_id) ? 7 : 3.2),
        radiusUnits: 'meters',
        radiusMinPixels: 2,
        radiusMaxPixels: 14,
        getFillColor: (d) => (planStops.has(d.stop_id) ? PALETTE.stop : (withA(PALETTE.stop, 150))),
        getLineColor: (d) => (selection?.kind === 'stop' && selection.id === d.stop_id ? PALETTE.gold : PALETTE.stopRing),
        lineWidthMinPixels: 1.5,
        stroked: true,
        pickable: true,
        onClick: (info: PickingInfo<StopCandidate>) => info.object && select({ kind: 'stop', id: info.object.stop_id }),
        updateTriggers: { getRadius: [planStops.size], getFillColor: [planStops.size], getLineColor: [selectedId] },
      }),
    )
    if (w.ghostStops?.length) {
      out.push(
        new ScatterplotLayer<StopCandidate>({
          ...SLOT.middle,
          id: `ghost-stops${sfx}`,
          data: w.ghostStops,
          getPosition: (d) => [d.lon, d.lat, 0.5],
          getRadius: 9,
          radiusUnits: 'meters',
          radiusMinPixels: 5,
          getFillColor: withA(PALETTE.intervention, 110),
          getLineColor: withA(PALETTE.intervention, 240),
          lineWidthMinPixels: 2,
          stroked: true,
        }),
      )
    }
    if (zoom >= 14) {
      out.push(
        new TextLayer({
          ...SLOT.top,
          id: `zone-labels${sfx}`,
          data: pack.zones,
          getPosition: (d) => [d.lon, d.lat, 2],
          getText: (d) => d.name.toUpperCase(),
          getSize: 11,
          getColor: [250, 246, 238, 230],
          getPixelOffset: [0, -18],
          fontFamily: 'Inter, ui-sans-serif, system-ui',
          fontWeight: 600,
          characterSet: 'auto',
          outlineWidth: 4,
          outlineColor: [40, 36, 32, 200],
          fontSettings: { sdf: true },
        }),
      )
    }
    out.push(
      new ScatterplotLayer({
        ...SLOT.middle,
        id: `venue${sfx}`,
        data: [pack.venue_lonlat],
        getPosition: (d) => [d[0], d[1], 0.2],
        getRadius: 70,
        radiusUnits: 'meters',
        getFillColor: withA(PALETTE.gold, 26),
        getLineColor: withA(PALETTE.gold, 170),
        lineWidthMinPixels: 1.5,
        getLineWidth: 3,
        lineWidthUnits: 'meters',
        stroked: true,
      }),
    )
  }

  if (!replay) return out

  // --- measured entities ---
  const ents = entitiesAt(replay, t)
  const buses = ents.filter((e) => e.kind === 'bus')
  const cars = ents.filter((e) => e.kind === 'car')
  const persons = ents.filter((e) => e.kind === 'person')
  const capOf = (id: string) => scenario?.constraints.fleet.find((f) => f.vehicle_id === id)?.capacity ?? 60
  const trips = tripsOf(replay)
  const alpha = (id: string, base: number) => (dim && id !== selectedId ? Math.round(base * 0.3) : base)

  out.push(
    new TripsLayer<Trip>({
      ...SLOT.middle,
      id: `bus-trips${sfx}`,
      data: trips.bus,
      getPath: (d) => d.path,
      getTimestamps: (d) => d.timestamps,
      getColor: withA(PALETTE.intervention, 200),
      currentTime: t,
      trailLength: 300,
      fadeTrail: true,
      getWidth: 3.2,
      widthUnits: 'meters',
      widthMinPixels: 3,
      capRounded: true,
      jointRounded: true,
    }),
  )
  if (selection?.kind === 'car' || selection?.kind === 'person') {
    const id = selection.kind === 'car' ? selection.id : `car_${selection.id}`
    const own = trips.car.filter((d) => d.id === id)
    if (own.length) {
      out.push(
        new TripsLayer<Trip>({
          ...SLOT.middle,
          id: `sel-car-trip${sfx}`,
          data: own,
          getPath: (d) => d.path,
          getTimestamps: (d) => d.timestamps,
          getColor: withA(PALETTE.gold, 220),
          currentTime: t,
          trailLength: 600,
          fadeTrail: true,
          getWidth: 3,
          widthUnits: 'meters',
          widthMinPixels: 2,
          capRounded: true,
          jointRounded: true,
        }),
      )
    }
  }
  if (selection?.kind === 'person') {
    const ix = replay.tracks[selection.id]
    if (ix) {
      const own = tripsFor(ix)
      out.push(
        new TripsLayer<Trip>({
          ...SLOT.middle,
          id: `sel-person-trip${sfx}`,
          data: own,
          getPath: (d) => d.path,
          getTimestamps: (d) => d.timestamps,
          getColor: withA(PALETTE.gold, 230),
          currentTime: t,
          trailLength: 900,
          fadeTrail: true,
          getWidth: 1.6,
          widthUnits: 'meters',
          widthMinPixels: 2,
          capRounded: true,
          jointRounded: true,
        }),
      )
    }
  }

  // Selection beacon: a halo drawn on top of the depth buffer so the selected entity stays findable behind towers.
  const selEnt = selectedId ? ents.find((e) => e.id === selectedId) : undefined
  if (selEnt) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.4)
    out.push(
      new ScatterplotLayer<EntityAt>({
        ...SLOT.top,
        id: `sel-beacon${sfx}`,
        data: [selEnt],
        getPosition: (d) => [d.lon, d.lat, 0.4],
        getRadius: selEnt.kind === 'bus' ? 11 + 4 * pulse : 5 + 3 * pulse,
        radiusUnits: 'meters',
        radiusMinPixels: 14,
        stroked: true,
        filled: true,
        getFillColor: withA(PALETTE.gold, 40),
        getLineColor: withA(PALETTE.gold, 235),
        getLineWidth: 1.2,
        lineWidthUnits: 'meters',
        lineWidthMinPixels: 2.5,
        parameters: { depthCompare: 'always' },
        updateTriggers: { getRadius: [pulse] },
      }),
    )
  }

  const carK = Math.min(3.5, presentational(4.4, 12, zoom) / 4.4)
  const personK = Math.min(7, presentational(0.68, 5, zoom) / 0.68)
  const busK = Math.min(2.6, presentational(12, 18, zoom) / 12)
  // cars: instanced low-poly boxes (GPU instancing; one draw call)
  if (zoom >= 13.2) {
    out.push(
      new SimpleMeshLayer<EntityAt>({
        ...SLOT.middle,
        id: `cars${sfx}`,
        data: cars,
        mesh: CAR_MESH,
        getPosition: (d) => [d.lon, d.lat, 0.75 * carK],
        getOrientation: (d) => [0, sumoYaw(d.angle), 0],
        getScale: [2.2 * carK, 0.9 * carK, 0.7 * carK],
        getColor: (d) => {
          const c = d.id.startsWith('car_p') ? PALETTE.cohortCar : PALETTE.car
          return [c[0], c[1], c[2], alpha(d.id, c[3])] as RGBA
        },
        material: { ambient: 0.5, diffuse: 0.6, shininess: 24, specularColor: [90, 90, 90] },
        pickable: true,
        onClick: (info: PickingInfo<EntityAt>) => info.object && select({ kind: 'car', id: info.object.id }),
        updateTriggers: { getColor: [selectedId, dim], getPosition: [carK] },
      }),
    )
  } else {
    out.push(
      new ScatterplotLayer<EntityAt>({
        ...SLOT.middle,
        id: `cars-far${sfx}`,
        data: cars,
        getPosition: (d) => [d.lon, d.lat, 0.5],
        getRadius: 2.6,
        radiusUnits: 'meters',
        radiusMinPixels: 1.8,
        getFillColor: (d) => (d.id.startsWith('car_p') ? PALETTE.cohortCar : PALETTE.car),
      }),
    )
  }

  // people: LOD — distant: soft dots; near: small upright figures; riding people are inside buses.
  if (zoom >= 15.2) {
    out.push(
      new SimpleMeshLayer<EntityAt>({
        ...SLOT.middle,
        id: `people-near${sfx}`,
        data: persons,
        mesh: PERSON_MESH,
        getPosition: (d) => [d.lon, d.lat, 0.45 * personK],
        getOrientation: (d) => [0, sumoYaw(d.angle), 0],
        getScale: (d) => (selectedId === d.id ? [0.5 * personK, 0.5 * personK, 1.1 * personK] : [0.34 * personK, 0.34 * personK, 0.9 * personK]),
        getColor: (d) => {
          const c = selectedId === d.id ? PALETTE.gold : PERSON_COLORS[d.state ?? 'walking']
          return [c[0], c[1], c[2], alpha(d.id, c[3])] as RGBA
        },
        material: { ambient: 0.6, diffuse: 0.5, shininess: 6, specularColor: [30, 30, 30] },
        pickable: true,
        onClick: (info: PickingInfo<EntityAt>) => info.object && select({ kind: 'person', id: info.object.id }),
        updateTriggers: { getColor: [selectedId, dim], getScale: [selectedId, personK], getPosition: [personK] },
      }),
    )
  } else {
    out.push(
      new ScatterplotLayer<EntityAt>({
        ...SLOT.middle,
        id: `people-far${sfx}`,
        data: persons,
        getPosition: (d) => [d.lon, d.lat, 0.6],
        getRadius: (d) => (selectedId === d.id ? 3.4 : 2.2),
        radiusUnits: 'meters',
        radiusMinPixels: 2.8,
        radiusMaxPixels: 7,
        getFillColor: (d) => {
          const c = selectedId === d.id ? PALETTE.gold : PERSON_COLORS[d.state ?? 'walking']
          return [c[0], c[1], c[2], alpha(d.id, c[3])] as RGBA
        },
        billboard: true,
        pickable: true,
        onClick: (info: PickingInfo<EntityAt>) => info.object && select({ kind: 'person', id: info.object.id }),
        updateTriggers: { getFillColor: [selectedId, dim], getRadius: [selectedId] },
      }),
    )
  }

  // buses: a ground beacon keeps the fleet legible at city zoom (position measured; ring size is presentational)
  if (zoom < 16.2) {
    out.push(
      new ScatterplotLayer<EntityAt>({
        ...SLOT.middle,
        id: `bus-beacons${sfx}`,
        data: buses,
        getPosition: (d) => [d.lon, d.lat, 0.4],
        getRadius: 11,
        radiusUnits: 'meters',
        radiusMinPixels: 9,
        radiusMaxPixels: 18,
        stroked: true,
        filled: true,
        getFillColor: (d) => withA(busColor(d.occupancy ?? 0, capOf(d.id)), 70),
        getLineColor: (d) => withA(busColor(d.occupancy ?? 0, capOf(d.id)), 230),
        getLineWidth: 2,
        lineWidthUnits: 'pixels',
        pickable: true,
        onClick: (info: PickingInfo<EntityAt>) => info.object && select({ kind: 'bus', id: info.object.id }),
        updateTriggers: { getFillColor: [t], getLineColor: [t] },
      }),
    )
  }
  // buses: instanced boxes, colour = measured occupancy against declared capacity
  out.push(
    new SimpleMeshLayer<EntityAt>({
      ...SLOT.middle,
      id: `buses${sfx}`,
      data: buses,
      mesh: BUS_MESH,
      getPosition: (d) => [d.lon, d.lat, 1.6 * busK],
      getOrientation: (d) => [0, sumoYaw(d.angle), 0],
      getScale: [6 * busK, 1.3 * busK, 1.55 * busK],
      getColor: (d) => busColor(d.occupancy ?? 0, capOf(d.id)),
      material: { ambient: 0.45, diffuse: 0.65, shininess: 32, specularColor: [120, 120, 120] },
      pickable: true,
      onClick: (info: PickingInfo<EntityAt>) => info.object && select({ kind: 'bus', id: info.object.id }),
      updateTriggers: { getPosition: [busK] },
    }),
  )

  // selection halo on the ground
  const sel = ents.find((e) => e.id === selectedId)
  if (sel) {
    out.push(
      new ScatterplotLayer<EntityAt>({
        ...SLOT.top,
        id: `selection-halo${sfx}`,
        data: [sel],
        getPosition: (d) => [d.lon, d.lat, 0.4],
        getRadius: sel.kind === 'bus' ? 11 : 4,
        radiusUnits: 'meters',
        radiusMinPixels: 8,
        getFillColor: withA(PALETTE.gold, 40),
        getLineColor: withA(PALETTE.gold, 235),
        getLineWidth: 0.8,
        lineWidthUnits: 'meters',
        lineWidthMinPixels: 2,
        stroked: true,
      }),
    )
  }

  if (zoom >= 14.6) {
    out.push(
      new TextLayer<EntityAt>({
        ...SLOT.top,
        id: `bus-labels${sfx}`,
        data: buses,
        getPosition: (d) => [d.lon, d.lat, 6],
        getText: (d) => `${d.id.replace('bus_', 'Bus ')} · ${d.occupancy ?? 0}/${capOf(d.id)}`,
        getSize: 12,
        getColor: [250, 246, 238, 240],
        getPixelOffset: [0, -16],
        fontFamily: 'Inter, ui-sans-serif, system-ui',
        fontWeight: 600,
        characterSet: 'auto',
        outlineWidth: 4,
        outlineColor: [30, 28, 26, 210],
        fontSettings: { sdf: true },
      }),
    )
  }
  return out
}
