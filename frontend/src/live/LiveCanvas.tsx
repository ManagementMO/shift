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

interface Props {
  pack: CityPack
  channel: LiveChannel | null
  clock: PlaybackClock
  quality: 'high' | 'balanced'
  preview: LivePreview | null
  pickedRoads: string[]
  pickMode: 'road' | 'inspect'
  selected: { id: string; follow: boolean } | null
  onPick: (picked: Picked) => void
  onRoad: (ids: string[]) => void
  onWorld: (world: WorldScene, adapter: BabylonSyncMap) => () => void
}

export default memo(function LiveCanvas(props: Props) {
  const latest = useRef(props)
  const scene = useRef<WorldScene | null>(null)
  const synchronize = useRef<() => void>(() => {})
  const [error, setError] = useState<string | null>(null)

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
    const unregister = latest.current.onWorld(ws, map)
    let attached: LiveChannel | null | undefined
    let routeMesh: Mesh | null = null
    let routeKey = ''
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
      ws.canvas.style.cursor = p.pickMode === 'road' ? 'crosshair' : ''
      ws.simT = p.clock.t
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
      if (p.pickMode === 'road') {
        const ray = ws.scene.createPickingRay(x, y, Matrix.Identity(), ws.camera.cam)
        const along = ray.intersectsPlane(ground)
        if (along === null || along < 0) return
        const point = ray.origin.add(ray.direction.scale(along))
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
      unregister()
      map.dispose()
      if (scene.current === ws) { scene.current = null; synchronize.current = () => {} }
    })
  }, [])

  return <>
    <WorldCanvas packId={props.pack.pack_id} quality={props.quality} onReady={onReady} />
    {error && <div className="live-canvas-error" role="alert">{error}</div>}
  </>
})
