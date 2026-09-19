import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'

export interface Location {
  id: string
  name: string
  region: string
  lat: number
  lon: number
}

export interface Orbit { alpha: number; beta: number; radius: number }

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

export function orbitRadius(width: number, height: number): number {
  return Math.max(3.25, 3.05 * height / Math.max(1, width))
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

export function flightPose(from: Orbit, place: Pick<Location, 'lat' | 'lon'>, progress: number): Orbit {
  const [x, y, z] = geoPoint(place.lat, place.lon)
  const alpha = Math.atan2(z, x)
  const turn = Math.atan2(Math.sin(alpha - from.alpha), Math.cos(alpha - from.alpha))
  const orient = smooth(progress / 0.64)
  const zoom = smooth((progress - 0.15) / 0.85)
  return {
    alpha: from.alpha + turn * orient,
    beta: from.beta + (Math.acos(y) - from.beta) * orient,
    radius: progress <= 0.15 ? from.radius : Math.exp(Math.log(from.radius) * (1 - zoom) + Math.log(1.025) * zoom),
  }
}

export function coordinates(place: Pick<Location, 'lat' | 'lon'>): string {
  return `${Math.abs(place.lat).toFixed(2)}° ${place.lat >= 0 ? 'N' : 'S'}  /  ${Math.abs(place.lon).toFixed(2)}° ${place.lon >= 0 ? 'E' : 'W'}`
}
