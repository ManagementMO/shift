// deck.gl layer factory for the world. Pure: (pack, scenario, replay, t, view) -> layers.
// Every moving entity here is a stored TraCI sample; static hazard buffers and exact affected roads are
// returned by the backend. Placement guides never determine simulation restrictions or metrics.

import { GeoJsonLayer, PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { SimpleMeshLayer } from '@deck.gl/mesh-layers'
import { TripsLayer } from '@deck.gl/geo-layers'
import { CubeGeometry, CylinderGeometry } from '@luma.gl/engine'
import type { Layer, PickingInfo } from '@deck.gl/core'
import type { Selection } from '../store'
import { distanceToStroke, strokeSamples } from '../hazardGeometry'
import type { CityPack, HazardDraft, HazardKind, HazardTrack, ScenarioSpec, StopCandidate } from '../types'
import { entitiesAt, fireSpreadProgress, hazardFootprint, pointInRing, MAX_GAP_S, type EntityAt, type PersonState, type ReplayIndex, type TrackIndex } from '../replay'

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
  hazardSketch?: HazardDraft | null
  /** Select an incident to expose its explicit on-map removal control. */
  selectHazard?: (trackId: string) => void
  hiddenHazardId?: string | null
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

const HAZARD_TINT: Record<HazardKind, RGBA> = {
  rain: [122, 140, 164, 255],
  fire: [228, 96, 32, 255],
  flood: [70, 128, 168, 255],
  storm: [84, 92, 110, 255],
}

const markCache = new WeakMap<object, { p: [number, number]; r: number }[]>()

/** Deterministic points inside the footprint bounding box that fall within its exterior ring. */
function hazardMarks(fp: { center: [number, number]; rings: [number, number][][]; span_m: number }, seed: string, kind: HazardKind): { p: [number, number]; r: number }[] {
  const cached = markCache.get(fp)
  if (cached) return cached
  const ring = fp.rings[0]
  const lon = ring.map((c) => c[0]), lat = ring.map((c) => c[1])
  const west = Math.min(...lon), east = Math.max(...lon), south = Math.min(...lat), north = Math.max(...lat)
  const inside = (x: number, y: number) => {
    let hit = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j]
      if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit
    }
    return hit
  }
  const count = Math.max(12, Math.min(400, Math.round(fp.span_m * (kind === 'storm' ? 0.6 : 0.3))))
  const out: { p: [number, number]; r: number }[] = []
  for (let i = 0; i < count * 6 && out.length < count; i++) {
    const x = west + hash01(`${seed}:x:${i}`) * (east - west)
    const y = south + hash01(`${seed}:y:${i}`) * (north - south)
    if (inside(x, y) && !fp.rings.slice(1).some((hole) => pointInRing(hole, [x, y]))) out.push({ p: [x, y], r: kind === 'fire' ? 4 : kind === 'storm' ? 1 : 0.7 })
  }
  markCache.set(fp, out)
  return out
}

function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 10000) / 10000
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
  for (const r of scenario?.restrictions ?? []) if (t >= r.start_s && t < r.end_s && (!w.hiddenHazardId || r.source_claim_id !== `hazard:${w.hiddenHazardId}`)) r.edge_ids.forEach((e) => closedNow.add(e))
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
          getLineColor: (f) => (ghostEdges.has(String(f.properties?.id)) ? withA(PALETTE.intervention, 60) : withA(PALETTE.coral, 70)),
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
          if (ghostEdges.has(id)) return withA(PALETTE.intervention, 230)
          if (closedNow.has(id)) return withA(PALETTE.coral, 245)
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
          const r = scenario?.restrictions.find((x) => t >= x.start_s && t < x.end_s && x.edge_ids.includes(id))
          if (r) select({ kind: 'restriction', id: r.restriction_id })
        },
        updateTriggers: { getLineColor: [closedNow.size, ghostEdges.size, focus.size], getLineWidth: [closedNow.size, ghostEdges.size] },
        parameters: { depthCompare: 'always' },
      }),
    )
  }

  // --- hazard: declared static region (full-window footprint) ---
  const hazards: HazardTrack[] = (scenario?.hazards ?? []).filter((h) => h.track_id !== w.ghostHazard?.track_id && h.track_id !== w.hiddenHazardId)
  if (w.ghostHazard) hazards.push(w.ghostHazard)
  for (const h of hazards) {
    const isGhost = w.ghostHazard?.track_id === h.track_id
    const fp = hazardFootprint(h, t, isGhost)
    if (!fp) continue
    const kind = h.kind ?? 'storm'
    const tint = HAZARD_TINT[kind]
    const color = isGhost ? PALETTE.intervention : tint
    out.push(
      new PolygonLayer({
        ...SLOT.top,
        id: `hazard-zone-${h.track_id}${sfx}`,
        data: [fp],
        getPolygon: (d) => d.rings,
        getFillColor: withA(color, kind === 'fire' ? isGhost ? 20 : 0 : kind === 'flood' ? 120 : 45),
        getLineColor: withA(color, 220),
        getLineWidth: 3.5,
        lineWidthUnits: 'meters',
        lineWidthMinPixels: 2,
        // Only the unconfirmed preview is outlined; applied events are just their weather.
        stroked: isGhost,
        filled: true,
        pickable: !isGhost,
        onClick: () => {
          // Clicking selects the event; removal requires its separate cross button.
          if (w.selectHazard) w.selectHazard(h.track_id)
          else {
            const r = scenario?.restrictions.find((r) => r.source_claim_id === `hazard:${h.track_id}`)
            if (r) select({ kind: 'restriction', id: r.restriction_id })
          }
        },
        parameters: { depthCompare: 'always', depthWriteEnabled: false },
      }),
    )
    // The entire server-projected buffer stays fixed for the full restriction window.
    // Only backend edge ids determine road closures; the outline is a declared spatial assumption.
    out.push(
      new PathLayer({
        ...SLOT.top,
        id: `hazard-path-${h.track_id}${sfx}`,
        data: h.waypoints.length > 1 ? [h.waypoints] : [],
        getPath: (d) => d,
        getColor: withA(color, 130),
        getWidth: 2,
        widthUnits: 'meters',
        widthMinPixels: 1,
        capRounded: true,
        jointRounded: true,
        parameters: { depthCompare: 'always', depthWriteEnabled: false },
      }),
    )
    // Illustrative decoration only: rain drops or flame dots at deterministic points inside the footprint.
    if (kind !== 'flood') {
      let marks = hazardMarks(fp, h.track_id, kind)
      if (kind === 'fire') {
        const source = h.waypoints[0] ?? fp.center
        const kx = 111320 * Math.cos(source[1] * Math.PI / 180)
        const local = (p: [number, number]): [number, number] => [(p[0] - source[0]) * kx, (p[1] - source[1]) * 110574]
        const path = (h.shape === 'polygon' ? [source] : h.waypoints).map(local)
        const distance = (p: [number, number]) => distanceToStroke(local(p), path)
        const reach = Math.max(1, ...fp.rings[0].map(distance))
        const front = fireSpreadProgress(h, isGhost ? Math.max(h.start_s, Math.min(h.end_s - 0.01, t)) : t) * reach
        marks = marks.filter((m) => distance(m.p) <= front)
        const ignition = strokeSamples(path, Math.max(3, reach * 0.08)).map(([x, y]) => [source[0] + x / kx, source[1] + y / 110574] as [number, number])
          .filter((p) => pointInRing(fp.rings[0], p) && !fp.rings.slice(1).some((ring) => pointInRing(ring, p)))
        marks = [...ignition.map((p) => ({ p, r: 4 })), ...marks]
      }
      out.push(
        new ScatterplotLayer<{ p: [number, number]; r: number }>({
          ...SLOT.top,
          id: `hazard-${kind}-marks-${h.track_id}${sfx}`,
          data: marks,
          getPosition: (d) => [d.p[0], d.p[1], kind === 'fire' ? 3 : 60],
          getRadius: (d) => d.r,
          radiusUnits: 'meters',
          radiusMinPixels: 1.5,
          getFillColor: kind === 'fire' ? withA([255, 170, 40, 255], isGhost ? 120 : 230) : withA(PALETTE.cohortCar, isGhost ? 90 : kind === 'storm' ? 200 : 140),
          parameters: { depthCompare: 'always', depthWriteEnabled: false },
        }),
      )
    }
  }
  const sketch = w.hazardSketch
  if (sketch?.shape === 'polygon' && sketch.waypoints.length) {
    const closed = sketch.waypoints.length >= 3 ? [...sketch.waypoints, sketch.waypoints[0]] : sketch.waypoints
    out.push(
      new PathLayer({
        ...SLOT.top, id: `hazard-sketch-area${sfx}`, data: closed.length > 1 ? [closed] : [], getPath: (d) => d,
        getWidth: 2.5, widthUnits: 'meters', widthMinPixels: 2, getColor: withA(PALETTE.intervention, 220),
        capRounded: true, jointRounded: true, parameters: { depthCompare: 'always', depthWriteEnabled: false },
      }),
      new ScatterplotLayer({
        ...SLOT.top, id: `hazard-sketch-corners${sfx}`, data: sketch.waypoints.length >= 3 ? [] : sketch.waypoints, getPosition: (d) => d,
        getRadius: 4, radiusUnits: 'meters', radiusMinPixels: 4, getFillColor: withA(PALETTE.intervention, 230),
        parameters: { depthCompare: 'always', depthWriteEnabled: false },
      }),
    )
  } else if (sketch?.waypoints.length && Number.isFinite(sketch.radius_m) && sketch.radius_m > 0) {
    out.push(
      new PathLayer({
        ...SLOT.top, id: `hazard-sketch-corridor${sfx}`,
        data: sketch.waypoints.length > 1 ? [sketch.waypoints] : [], getPath: (d) => d,
        getWidth: sketch.radius_m * 2, widthUnits: 'meters', getColor: withA(PALETTE.intervention, 30),
        capRounded: true, jointRounded: true, parameters: { depthCompare: 'always', depthWriteEnabled: false },
      }),
      new ScatterplotLayer({
        ...SLOT.top, id: `hazard-sketch-points${sfx}`, data: sketch.waypoints, getPosition: (d) => d,
        getRadius: sketch.radius_m, radiusUnits: 'meters', getFillColor: withA(PALETTE.intervention, 30),
        getLineColor: withA(PALETTE.intervention, 200), stroked: true, lineWidthMinPixels: 1.5,
        parameters: { depthCompare: 'always', depthWriteEnabled: false },
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
