// Registry of live map instances so shell controls (camera modes, compare sync) can drive them.
import { moveTo, type CameraMode, type CameraPose, type MapCamera } from './camera'

export type SyncMap = MapCamera & {
  jumpTo: (o: CameraPose) => unknown
  isMoving: () => boolean
  on: (ev: string, cb: (e: { originalEvent?: unknown }) => void) => unknown
  off: (ev: string, cb: (e: { originalEvent?: unknown }) => void) => unknown
  /** Renderer-native framings (Babylon world): opening city hero and the venue egress scene. */
  cityHero?: () => void
  egress?: () => boolean
}

/** Renderer counters for diagnostics (Developer panel / debug bridge). */
export const renderStats = { layerRebuilds: 0 }

const maps = new Map<string, SyncMap>()
let syncing = false

export function registerMap(side: string, map: SyncMap): () => void {
  maps.set(side, map)
  const onMove = () => {
    if (syncing) return
    syncing = true
    const pose: CameraPose = { center: [map.getCenter().lng, map.getCenter().lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() }
    for (const [k, m] of maps) if (k !== side) m.jumpTo(pose)
    syncing = false
  }
  map.on('move', onMove)
  return () => {
    map.off('move', onMove)
    maps.delete(side)
  }
}

export function leadMap(): SyncMap | null {
  return maps.get('solo') ?? maps.get('left') ?? maps.values().next().value ?? null
}

let onMode: ((m: CameraMode) => void) | null = null

/** The shell registers a listener so explicit camera moves also update the visible camera-mode control. */
export function watchCameraMode(cb: (m: CameraMode) => void): () => void {
  onMode = cb
  return () => {
    if (onMode === cb) onMode = null
  }
}

export function cameraTo(pose: CameraPose, mode: CameraMode) {
  const lead = leadMap()
  if (lead && mode === 'city' && lead.cityHero) lead.cityHero()
  else if (lead) moveTo(lead, pose, mode) // followers sync through the 'move' handler
  onMode?.(mode)
}
