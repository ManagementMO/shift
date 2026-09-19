// Cinematic camera presets. Every transition is an eased easeTo/flyTo; nothing jumps.

export type CameraMode = 'city' | 'district' | 'corridor' | 'agent' | 'incident' | 'development'

export type CameraPose = { center: [number, number]; zoom: number; pitch: number; bearing: number }

export type CameraTarget = { map: MapCamera; mode: CameraMode }

/** The subset of mapbox-gl / maplibre-gl Map we drive. */
export type MapCamera = {
  easeTo: (o: CameraPose & { duration: number; essential?: boolean; easing?: (x: number) => number }) => unknown
  flyTo: (o: CameraPose & { duration: number; essential?: boolean; curve?: number }) => unknown
  getCenter: () => { lng: number; lat: number }
  getZoom: () => number
  getPitch: () => number
  getBearing: () => number
  project: (lngLat: [number, number]) => { x: number; y: number }
}

/** Downtown Toronto / waterfront: lake at the bottom of the frame, skyline rising toward the top. */
export const TORONTO_CITY: CameraPose = { center: [-79.3848, 43.6438], zoom: 15.05, pitch: 60, bearing: -17 }

const CITY_POSES: Record<string, CameraPose> = {
  toronto: TORONTO_CITY,
  waterloo: { center: [-80.5265, 43.4668], zoom: 14.4, pitch: 55, bearing: -8 },
  waterloo_e7: { center: [-80.5395046, 43.4729528], zoom: 15.7, pitch: 42, bearing: -35 },
}

export function cityPose(packId: string, center: [number, number]): CameraPose {
  return CITY_POSES[packId] ?? { center, zoom: 14.4, pitch: 55, bearing: -10 }
}

export function districtPose(center: [number, number], base: CameraPose): CameraPose {
  return { center, zoom: 15.6, pitch: 60, bearing: base.bearing }
}

export function corridorPose(path: [number, number][], base: CameraPose): CameraPose {
  const a = path[0]
  const b = path[path.length - 1]
  const center: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const dx = (b[0] - a[0]) * Math.cos((center[1] * Math.PI) / 180)
  const dy = b[1] - a[1]
  const along = (Math.atan2(dx, dy) * 180) / Math.PI // heading of the corridor
  const bearing = ((along + 90 + 540) % 360) - 180 // look across it
  const span = Math.hypot(dx, dy) * 111 // km
  const zoom = Math.max(14.5, Math.min(17, 16.4 - Math.log2(Math.max(0.2, span)) ))
  return { center, zoom, pitch: 62, bearing: Math.abs(bearing - base.bearing) < 100 ? bearing : bearing + 180 }
}

export function agentPose(center: [number, number], heading: number | null, base: CameraPose): CameraPose {
  return { center, zoom: 17.6, pitch: 66, bearing: heading ?? base.bearing }
}

export function incidentPose(center: [number, number], radiusM: number, base: CameraPose): CameraPose {
  const zoom = Math.max(14.5, Math.min(16.5, 17.2 - Math.log2(Math.max(60, radiusM) / 60)))
  return { center, zoom, pitch: 60, bearing: base.bearing + 25 }
}

/** Close-up on a placed building: the whole footprint and roof stay in frame, with street context around it. */
export function developmentPose(center: [number, number], footprintM: [number, number], heightM: number, base: CameraPose): CameraPose {
  const extent = Math.max(60, ...footprintM, heightM * 0.8)
  const zoom = Math.max(15.5, Math.min(17.9, 18.9 - Math.log2(extent / 30)))
  return { center, zoom, pitch: 58, bearing: base.bearing }
}

export function currentPose(map: MapCamera): CameraPose {
  const c = map.getCenter()
  return { center: [c.lng, c.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() }
}

export function moveTo(map: MapCamera, pose: CameraPose, mode: CameraMode) {
  const from = currentPose(map)
  const far = Math.abs(from.zoom - pose.zoom) > 1.8 || distKm(from.center, pose.center) > 1.5
  if (far && mode !== 'agent') map.flyTo({ ...pose, duration: 1900, essential: true, curve: 1.25 })
  else map.easeTo({ ...pose, duration: mode === 'agent' ? 1100 : 1400, essential: true })
}

function distKm(a: [number, number], b: [number, number]): number {
  const dx = (b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180) * 111.32
  const dy = (b[1] - a[1]) * 110.57
  return Math.hypot(dx, dy)
}
