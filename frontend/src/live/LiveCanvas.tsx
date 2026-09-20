import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Matrix } from '@babylonjs/core/Maths/math.vector'
import { Plane } from '@babylonjs/core/Maths/math.plane'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import '@babylonjs/core/Culling/ray'

import { meshFromBatch, vertexColorMaterial, Y } from '../babylon/city'
import { Batch } from '../babylon/geometry'
import { BabylonSyncMap } from '../babylon/mapAdapter'
import { Overlay } from '../babylon/overlay'
import { RoadIndex } from '../babylon/roadIndex'
import type { WorldScene } from '../babylon/scene'
import type { Picked } from '../babylon/traffic'
import WorldCanvas from '../babylon/WorldCanvas'
import type { CityPack } from '../types'
import type { PlaybackClock } from '../world/playback'
import type { LiveChannel } from './channel'
import { environmentAt } from './timeline'
import type { LivePreview } from './types'
import '../babylon/world.css'

export interface IncidentDraft { lon: number; lat: number; radius_m: number; alarm_radius_m: number; label: string }

interface Props {
  pack: CityPack
  channel: LiveChannel | null
  clock: PlaybackClock
  quality: 'high' | 'balanced'
  preview: LivePreview | null
  pickedRoads: string[]
  pickMode: 'road' | 'inspect' | 'incident'
  incidentDraft: IncidentDraft | null
  selected: { id: string; follow: boolean } | null
  onPick: (picked: Picked) => void
  onRoad: (ids: string[]) => void
  onPlace: (lon: number, lat: number) => void
  onWorld: (world: WorldScene, adapter: BabylonSyncMap) => () => void
}

const DANGER: [number, number, number] = [0.93, 0.2, 0.12]
const ALARM: [number, number, number] = [1.0, 0.62, 0.2]
const DRAFT: [number, number, number] = [0.2, 0.75, 0.85]

function ringPolygon(b: Batch, x: number, z: number, r: number, w: number, y: number, c: [number, number, number]): void {
  const outer: number[] = [], inner: number[] = []
  const segments = 48
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2
    outer.push(x + Math.cos(a) * r, z + Math.sin(a) * r)
    inner.push(x + Math.cos(a) * Math.max(0.5, r - w), z + Math.sin(a) * Math.max(0.5, r - w))
  }
  b.polygon(outer, [inner], y, c)
}

export default memo(function LiveCanvas(props: Props) {
  const latest = useRef(props)
  const scene = useRef<WorldScene | null>(null)
  const synchronize = useRef<() => void>(() => {})
  const [error, setError] = useState<string | null>(null)
  const [labels, setLabelsState] = useState<{ id: string; text: string; x: number; y: number }[]>([])
  const labelKey = useRef('')
  const setLabels = (next: { id: string; text: string; x: number; y: number }[]) => {
    const key = next.map(l => `${l.id}:${l.text}:${Math.round(l.x)}:${Math.round(l.y)}`).join('|')
    if (key === labelKey.current) return
    labelKey.current = key
    setLabelsState(next)
  }

  useEffect(() => {
    latest.current = props
    synchronize.current()
  })

  const onReady = useCallback((ws: WorldScene) => {
    scene.current = ws
    const map = new BabylonSyncMap(ws)
    const overlay = new Overlay(ws.scene, ws.roads, ws.frame)
    const streets = new RoadIndex(ws.world, r => r.allow.includes('car') || r.allow.includes('bus'))
    const routeMaterial = vertexColorMaterial('live-service-routes', ws.scene, 0)
    routeMaterial.emissiveColor.set(0.25, 0.25, 0.25)
    const zoneMaterial = vertexColorMaterial('live-incident-zones', ws.scene, 0)
    zoneMaterial.emissiveColor.set(0.45, 0.45, 0.45)
    zoneMaterial.alpha = 0.42
    zoneMaterial.backFaceCulling = false
    const unregister = latest.current.onWorld(ws, map)
    let attached: LiveChannel | null | undefined
    let routeMesh: Mesh | null = null
    let routeKey = ''
    let zoneMesh: Mesh | null = null
    let zoneKey = ''
    let disposed = false

    const sync = () => {
      if (disposed) return
      const p = latest.current
      const channel = p.channel
      if (attached !== channel) {
        attached = channel
        const compatible = !channel || channel.state.network_fingerprint === ws.world.network_fingerprint
        setError(compatible ? null : 'This recording uses a different city network. Open its matching city pack.')
        ws.traffic.setLiveSource(compatible ? channel : null)
      }
      ws.traffic.selectedId = p.selected?.id ?? null
      ws.traffic.dimOthers = false
      ws.canvas.style.cursor = p.pickMode === 'inspect' ? '' : 'crosshair'
      ws.simT = p.clock.t
      const t = p.clock.t
      const incidents = (channel?.state.incidents ?? []).filter(i => i.start_s <= t && t < i.end_s)
      const draft = p.incidentDraft
      const draftWorld = draft ? ws.frame.lonLatToWorld(draft.lon, draft.lat) : null
      const zone = [...incidents.map(i => `${i.event_id}:${i.radius_m}`), draft && draftWorld ? `draft:${draftWorld[0].toFixed(1)}:${draftWorld[1].toFixed(1)}:${draft.radius_m}:${draft.alarm_radius_m}` : ''].join('|')
      if (zone !== zoneKey) {
        zoneKey = zone
        zoneMesh?.dispose()
        zoneMesh = null
        const geometry = new Batch()
        for (const i of incidents) {
          geometry.disc(i.x, i.z, i.radius_m, Y.junction + 0.14, DANGER, 48)
          ringPolygon(geometry, i.x, i.z, i.alarm_radius_m, Math.max(1.5, i.alarm_radius_m * 0.02), Y.junction + 0.13, ALARM)
          // a beacon column reads above the rooftops from the city camera
          const beacon: number[] = []
          for (let k = 0; k < 12; k++) beacon.push(i.x + Math.cos(k / 12 * Math.PI * 2) * 9, i.z + Math.sin(k / 12 * Math.PI * 2) * 9)
          geometry.walls(beacon, undefined, Y.junction, 320, DANGER, 1)
        }
        if (draft && draftWorld) {
          ringPolygon(geometry, draftWorld[0], draftWorld[1], draft.radius_m, Math.max(1.5, draft.radius_m * 0.06), Y.junction + 0.15, DRAFT)
          ringPolygon(geometry, draftWorld[0], draftWorld[1], draft.alarm_radius_m, Math.max(1, draft.alarm_radius_m * 0.015), Y.junction + 0.15, DRAFT)
        }
        if (geometry.vertexCount) zoneMesh = meshFromBatch('live-incident-zones', geometry, ws.scene, zoneMaterial)
      }
      const width = ws.canvas.clientWidth, height = ws.canvas.clientHeight
      setLabels(incidents.map(i => {
        const screen = map.projectWorld(i.x, 6, i.z)
        return { id: i.event_id, text: `${i.label} · ${Math.max(0, Math.ceil((i.end_s - t) / 60))} min left`, x: screen.x, y: screen.y }
      }).filter(l => Number.isFinite(l.x) && Number.isFinite(l.y) && l.x > -40 && l.x < width + 40 && l.y > 0 && l.y < height))
      const environment = channel ? environmentAt(channel.state, p.clock.t) : null
      const change = p.preview?.intervention
      const ghosts = change?.kind === 'close_road' || change?.kind === 'reopen_road' ? change.edge_ids : p.pickedRoads
      const ghostStops = change?.kind === 'add_bus_route' ? p.pack.stops.filter(s => change.stop_ids.includes(s.stop_id)) : []
      overlay.set({ closed: environment?.closedEdges ?? [], ghost: ghosts, focus: [], ghostStops })
      const routes = channel?.metadata.routes.filter(r => environment?.assignedBuses.has(r.bus_id)) ?? []
      const key = routes.map(r => r.line).join('|')
      if (key !== routeKey) {
        routeKey = key
        routeMesh?.dispose()
        routeMesh = null
        const geometry = new Batch()
        for (const route of routes) geometry.ribbon(route.path.flat(), 1.6, Y.junction + 0.1, [0.09, 0.43, 0.75])
        if (geometry.vertexCount) routeMesh = meshFromBatch('live-service-routes', geometry, ws.scene, routeMaterial)
      }
      if (p.selected?.follow) {
        const position = ws.traffic.poseOf(p.selected.id)
        if (position) ws.camera.follow(position.x, position.z, 2)
      }
    }
    synchronize.current = sync
    sync()
    const offClock = latest.current.clock.onFrame(sync)
    const ground = new Plane(0, 1, 0, 0)
    let down: { x: number; y: number } | null = null
    const pointerDown = (event: PointerEvent) => { if (event.button === 0) down = { x: event.clientX, y: event.clientY } }
    const pointerUp = (event: PointerEvent) => {
      if (!down) return
      const distance = Math.hypot(event.clientX - down.x, event.clientY - down.y)
      down = null
      if (distance > 5) return
      const rect = ws.canvas.getBoundingClientRect()
      const x = event.clientX - rect.left, y = event.clientY - rect.top
      const p = latest.current
      if (p.pickMode === 'road' || p.pickMode === 'incident') {
        const ray = ws.scene.createPickingRay(x, y, Matrix.Identity(), ws.camera.cam)
        const along = ray.intersectsPlane(ground)
        if (along === null || along < 0) return
        const point = ray.origin.add(ray.direction.scale(along))
        if (p.pickMode === 'incident') {
          const [lon, lat] = ws.frame.worldToLonLat(point.x, point.z)
          p.onPlace(lon, lat)
          return
        }
        const hit = streets.nearest(point.x, point.z, 24)
        if (hit) {
          const reverse = hit.road.id.startsWith('-') ? hit.road.id.slice(1) : `-${hit.road.id}`
          p.onRoad(streets.byId.has(reverse) ? [hit.road.id, reverse] : [hit.road.id])
        }
      } else {
        const picked = ws.traffic.pick(x, y, (px, py, pz) => map.projectWorld(px, py, pz))
        if (picked) p.onPick(picked)
      }
    }
    ws.canvas.addEventListener('pointerdown', pointerDown)
    ws.canvas.addEventListener('pointerup', pointerUp)
    ws.scene.onDisposeObservable.addOnce(() => {
      disposed = true
      offClock()
      ws.canvas.removeEventListener('pointerdown', pointerDown)
      ws.canvas.removeEventListener('pointerup', pointerUp)
      overlay.dispose()
      routeMesh?.dispose()
      routeMaterial.dispose()
      zoneMesh?.dispose()
      zoneMaterial.dispose()
      unregister()
      map.dispose()
      if (scene.current === ws) { scene.current = null; synchronize.current = () => {} }
    })
  }, [])

  return <>
    <WorldCanvas packId={props.pack.pack_id} quality={props.quality} onReady={onReady} />
    {labels.map(label => <div key={label.id} className="live-incident-label" style={{ transform: `translate(-50%, -100%) translate(${label.x}px, ${label.y}px)` }}>{label.text}</div>)}
    {error && <div className="live-canvas-error" role="alert">{error}</div>}
  </>
})
