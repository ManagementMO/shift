import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'

export interface Location {
  id: string
  name: string
  region: string
  lat: number
  lon: number
}

export interface Orbit { alpha: number; beta: number; radius: number }

export const GLOBE_FOV = 0.66
export const GLOBE_FILL = 0.82
export const ENTRY_DURATION = 4300
/** Progress at which the city is revealed behind the globe and the interface starts fading out. */
export const ENTRY_REVEAL = 0.78
/** Haze strength at its peak; the wash is what carries the globe into the city. */
export const ENTRY_HAZE = 0.45
/** Progress by which the bar and the side panels have cleared out of the way of the descent. */
export const ENTRY_CLEAR = 0.34

export function cityClickAction(selected: Pick<Location, 'id'> | null, place: Pick<Location, 'id'>): 'select' | 'enter' {
  return selected?.id === place.id ? 'enter' : 'select'
}

/**
 * Entry visuals: the bar and side panels clear out first so nothing frames the descent, the light peaks while
 * the globe reaches the surface, and the whole homepage dissolves into the city behind it.
 */
export function entryVisuals(progress: number) {
  return {
    ui: 1 - smooth(progress / ENTRY_CLEAR),
    haze: Math.sin(smooth((progress - 0.6) / 0.4) * Math.PI) * ENTRY_HAZE,
    opacity: 1 - smooth((progress - ENTRY_REVEAL) / (1 - ENTRY_REVEAL)),
  }
}

export const LOCATIONS: Location[] = [
  { id: 'toronto', name: 'Toronto', region: 'Canada', lat: 43.65, lon: -79.38 },
  { id: 'new-york', name: 'New York', region: 'United States', lat: 40.71, lon: -74.01 },
  { id: 'london', name: 'London', region: 'United Kingdom', lat: 51.51, lon: -0.13 },
  { id: 'tokyo', name: 'Tokyo', region: 'Japan', lat: 35.68, lon: 139.69 },
  { id: 'singapore', name: 'Singapore', region: 'Singapore', lat: 1.35, lon: 103.82 },
  { id: 'dubai', name: 'Dubai', region: 'United Arab Emirates', lat: 25.2, lon: 55.27 },
  { id: 'sao-paulo', name: 'São Paulo', region: 'Brazil', lat: -23.55, lon: -46.63 },
  { id: 'sydney', name: 'Sydney', region: 'Australia', lat: -33.87, lon: 151.21 },
]

export function searchLocations(query: string): Location[] {
  const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
  const term = normalize(query)
  return LOCATIONS.filter((place) => normalize(`${place.name} ${place.region}`).includes(term))
}

export function geoPoint(lat: number, lon: number, radius = 1): [number, number, number] {
  const phi = lat * Math.PI / 180, theta = lon * Math.PI / 180
  return [-radius * Math.cos(phi) * Math.cos(theta), radius * Math.sin(phi), radius * Math.cos(phi) * Math.sin(theta)]
}

export function pointGeo([x, y, z]: readonly number[]): { lat: number; lon: number } {
  const radius = Math.hypot(x, y, z) || 1
  return { lat: Math.asin(Math.max(-1, Math.min(1, y / radius))) * 180 / Math.PI, lon: Math.atan2(z, -x) * 180 / Math.PI }
}

export function destinationPack(_location: Pick<Location, 'lat' | 'lon'>): 'toronto' {
  return 'toronto'
}

/** The globe marker whose flight lands in a given city pack; packs without a marker cannot be entered from orbit. */
export function locationForPack(packId: string): Location | null {
  return LOCATIONS.find((place) => destinationPack(place) === packId && place.id === packId) ?? null
}

export function orbitRadius(width: number, height: number): number {
  const aspect = width > 0 && height > 0 ? Math.min(1, width / height) : 1
  return Math.sqrt(1 + (1 / (Math.tan(GLOBE_FOV / 2) * GLOBE_FILL * aspect)) ** 2)
}

export function lockOrbit(camera: ArcRotateCamera, radius: number): void {
  camera.inputs.removeByType('ArcRotateCameraMouseWheelInput')
  camera.useNaturalPinchZoom = false
  camera.pinchDeltaPercentage = 0
  camera.pinchPrecision = Infinity
  camera.inertialRadiusOffset = 0
  camera.radius = camera.lowerRadiusLimit = camera.upperRadiusLimit = radius
}

export function smooth(t: number): number {
  const x = Math.max(0, Math.min(1, t))
  return x * x * (3 - 2 * x)
}

export function focusPose(from: Orbit, place: Pick<Location, 'lat' | 'lon'>, progress: number): Orbit {
  const [x, y, z] = geoPoint(place.lat, place.lon)
  const alpha = Math.atan2(z, x)
  const turn = Math.atan2(Math.sin(alpha - from.alpha), Math.cos(alpha - from.alpha))
  const orient = smooth(progress)
  return {
    alpha: from.alpha + turn * orient,
    beta: from.beta + (Math.acos(y) - from.beta) * orient,
    radius: from.radius,
  }
}

export function flightPose(from: Orbit, place: Pick<Location, 'lat' | 'lon'>, progress: number): Orbit {
  const zoom = smooth((progress - 0.15) / 0.85)
  return {
    ...focusPose(from, place, progress / 0.64),
    radius: progress <= 0.15 ? from.radius : Math.exp(Math.log(from.radius) * (1 - zoom) + Math.log(1.025) * zoom),
  }
}

export function coordinates(place: Pick<Location, 'lat' | 'lon'>): string {
  return `${Math.abs(place.lat).toFixed(2)}° ${place.lat >= 0 ? 'N' : 'S'}  /  ${Math.abs(place.lon).toFixed(2)}° ${place.lon >= 0 ? 'E' : 'W'}`
}
