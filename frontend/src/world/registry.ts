// Registry of live map instances so shell controls (camera framing, info bubble, compare sync) can drive them.
import { moveTo, type CameraMode, type CameraPose, type MapCamera } from './camera'

/** What the shell can say about a clicked building; only the Babylon world knows buildings. */
export type BuildingFacts = {
  id: string
  name?: string
  kind: 'building' | 'landmark' | 'massing'
  cat?: string
  height: number
  area: number
  sections: number
  lonLat: [number, number]
}

export type SyncMap = MapCamera & {
  cameraLocked?: boolean
  setCameraPreset?: (pose: CameraPose, mode: CameraMode) => void
  jumpTo: (o: CameraPose) => unknown
  isMoving: () => boolean
  on: (ev: string, cb: (e: { originalEvent?: unknown }) => void) => unknown
  off: (ev: string, cb: (e: { originalEvent?: unknown }) => void) => unknown
  /** Renderer-native framing (Babylon world): the opening city hero. */
  cityHero?: () => void
  setCameraMode?: (mode: CameraMode) => void
  syncFrom?: (source: SyncMap) => boolean
  /** CSS-pixel screen position of a point `height` metres above the ground. */
  projectAt?: (lngLat: [number, number], height: number) => { x: number; y: number }
  buildingFacts?: (id: string) => BuildingFacts | null
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
    for (const [k, m] of maps) if (k !== side && !m.syncFrom?.(map)) m.jumpTo(pose)
    syncing = false
  }
  map.on('move', onMove)
  return () => {
    map.off('move', onMove)
    maps.delete(side)
  }
}

export function mapForSide(side: string): SyncMap | null {
  return maps.get(side) ?? null
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
  if (!lead || (lead.cameraLocked && !lead.setCameraPreset)) return
  for (const map of maps.values()) map.setCameraMode?.(mode)
  if (lead.setCameraPreset) lead.setCameraPreset(pose, mode)
  else if (mode === 'city' && lead.cityHero) lead.cityHero()
  else moveTo(lead, pose, mode) // followers sync through the 'move' handler
  onMode?.(mode)
}
