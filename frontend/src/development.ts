import { utmForward, utmInverse, type WorldFrame } from './babylon/coords'
import type { BuildingKind, CityPack, Development, DevelopmentSpec, DevelopmentUse, RunBundle, ScenarioSpec } from './types'

export const DEVELOPMENT_USES: Record<DevelopmentUse, { label: string; unit: string; color: string }> = {
  residential: { label: 'Homes', unit: 'homes', color: '#178f83' },
  office: { label: 'Offices', unit: 'employees', color: '#6764c5' },
  school: { label: 'School', unit: 'students', color: '#c48529' },
  park: { label: 'Park', unit: 'visitors', color: '#4f9a3c' },
}

/** Default flagship horizon (matches the backend `FlagshipRequest.horizon_s` default) used before a scenario exists. */
export const DEFAULT_HORIZON_S = 2700

export type BuildingPreset = {
  label: string
  blurb: string
  color: string
  land_use: DevelopmentUse
  footprint_m: [number, number]
  height_m: number
  capacity: number
  people_per_unit: number
  trip_rate: number
  car_share: number
  first_wave_s: number
  profile: 'uniform' | 'triangular'
}

/**
 * The only building choices offered in the UI. Every number here is a declared synthetic assumption that is shown
 * (read-only) beside the placed building; geometry never sets occupancy.
 */
export const BUILDING_KINDS: Record<BuildingKind, BuildingPreset> = {
  park: {
    label: 'Park', blurb: '300 visitors arrive on foot and by car', color: '#4f9a3c', land_use: 'park',
    footprint_m: [90, 70], height_m: 1, capacity: 300, people_per_unit: 1, trip_rate: 1, car_share: 0.2, first_wave_s: 1200, profile: 'uniform',
  },
  townhouse: {
    label: 'Townhouses', blurb: '12 homes in a low row', color: '#b8743a', land_use: 'residential',
    footprint_m: [48, 14], height_m: 10, capacity: 12, people_per_unit: 2.5, trip_rate: 0.6, car_share: 0.6, first_wave_s: 900, profile: 'uniform',
  },
  apartment: {
    label: 'Apartments', blurb: '120 homes, mid-rise', color: '#178f83', land_use: 'residential',
    footprint_m: [36, 26], height_m: 30, capacity: 120, people_per_unit: 2, trip_rate: 0.5, car_share: 0.35, first_wave_s: 900, profile: 'uniform',
  },
  skyscraper: {
    label: 'Skyscraper', blurb: '1,200 office workers arriving', color: '#6764c5', land_use: 'office',
    footprint_m: [44, 44], height_m: 180, capacity: 1200, people_per_unit: 1, trip_rate: 0.7, car_share: 0.5, first_wave_s: 900, profile: 'triangular',
  },
}

export const BUILDING_KIND_ORDER: BuildingKind[] = ['park', 'townhouse', 'apartment', 'skyscraper']

export function developmentPreset(pack: CityPack, horizon: number, kind: BuildingKind = 'apartment', ordinal = 1): DevelopmentSpec {
  const preset = BUILDING_KINDS[kind]
  const totalShare = pack.zones.reduce((sum, z) => sum + z.share, 0)
  return {
    name: ordinal > 1 ? `${preset.label} ${ordinal}` : preset.label,
    land_use: preset.land_use, position: [...pack.venue_lonlat],
    footprint_m: [...preset.footprint_m], height_m: preset.height_m,
    capacity: preset.capacity, people_per_unit: preset.people_per_unit, trip_rate: preset.trip_rate, car_share: preset.car_share,
    walk_limit_m: 1500,
    zone_shares: Object.fromEntries(pack.zones.map((z) => [z.zone_id, totalShare ? z.share / totalShare : 1 / pack.zones.length])),
    first_wave: { start_s: 0, end_s: Math.min(horizon, preset.first_wave_s), profile: preset.profile },
    return_wave: null, seed: 7,
  }
}

/** Which of the four kinds a saved spec is; specs from other tooling (e.g. schools) return null. */
export function developmentKind(spec: DevelopmentSpec): BuildingKind | null {
  if (spec.land_use === 'park') return 'park'
  if (spec.land_use === 'office') return 'skyscraper'
  if (spec.land_use === 'residential') return spec.height_m <= 15 ? 'townhouse' : 'apartment'
  return null
}

export function developmentLabel(spec: DevelopmentSpec): string {
  const kind = developmentKind(spec)
  return kind ? BUILDING_KINDS[kind].label : DEVELOPMENT_USES[spec.land_use].label
}

export function developmentColor(spec: DevelopmentSpec): string {
  const kind = developmentKind(spec)
  return kind ? BUILDING_KINDS[kind].color : DEVELOPMENT_USES[spec.land_use].color
}

export function developmentCounts(spec: DevelopmentSpec): { participants: number; trips: number; cars: number } {
  const participants = Math.floor(spec.capacity * spec.people_per_unit * spec.trip_rate + 0.5)
  const waves = spec.return_wave ? 2 : 1
  return { participants, trips: participants * waves, cars: Math.floor(participants * spec.car_share + 0.5) * waves }
}

export function developmentDirection(spec: DevelopmentSpec, returning = false): 'inbound' | 'outbound' {
  const outbound = spec.land_use === 'residential'
  return outbound !== returning ? 'outbound' : 'inbound'
}

export function developmentActivity(spec: DevelopmentSpec, t: number): 'inbound' | 'outbound' | null {
  if (t >= spec.first_wave.start_s && t < spec.first_wave.end_s) return developmentDirection(spec)
  if (spec.return_wave && t >= spec.return_wave.start_s && t < spec.return_wave.end_s) return developmentDirection(spec, true)
  return null
}

export function developmentArrowFraction(spec: DevelopmentSpec, direction: 'inbound' | 'outbound', distanceM: number): number {
  const near = Math.min(0.35, (Math.max(...spec.footprint_m) / 2 + 35) / Math.max(1, distanceM))
  return direction === 'outbound' ? near : 1 - near
}

export function validDevelopmentGeometry(spec: DevelopmentSpec): boolean {
  return [...spec.position, ...spec.footprint_m, spec.height_m].every(Number.isFinite)
    && Math.abs(spec.position[0]) <= 180 && Math.abs(spec.position[1]) <= 85
    && spec.height_m > 0 && spec.height_m <= 300 && spec.footprint_m.every((n) => n > 0 && n <= 250)
}

export function developmentRing(spec: DevelopmentSpec, frame: WorldFrame, pad = 0): number[] {
  const [x, z] = frame.lonLatToWorld(...spec.position)
  const w = spec.footprint_m[0] / 2 + pad
  const d = spec.footprint_m[1] / 2 + pad
  return [x - w, z - d, x + w, z - d, x + w, z + d, x - w, z + d]
}

export function developmentPolygon(spec: DevelopmentSpec): [number, number][] {
  const zone = Math.min(60, Math.floor((spec.position[0] + 180) / 6) + 1)
  const [x, y] = utmForward(...spec.position, zone)
  const [w, d] = spec.footprint_m.map((size) => size / 2)
  return [[-w, -d], [w, -d], [w, d], [-w, d]].map(([dx, dy]) => utmInverse(x + dx, y + dy, zone))
}

/** The development to show first: the most recently added one in the active scenario. */
export function latestDevelopment(scenario: ScenarioSpec | null | undefined): Development | null {
  return scenario?.developments?.at(-1) ?? null
}

export function scenarioForView(scenarios: ScenarioSpec[], selectedId: string | null, bundle: RunBundle | null, side: string): ScenarioSpec | null {
  if (bundle) return bundle.scenario ?? scenarios.find((s) => s.scenario_id === bundle.run.scenario_id) ?? null
  return side === 'left' ? null : scenarios.find((s) => s.scenario_id === selectedId) ?? null
}

export function developmentError(spec: DevelopmentSpec, horizon: number): string | null {
  if (!spec.name.trim()) return 'Give the development a name.'
  if (!Number.isInteger(spec.capacity) || spec.capacity < 1 || spec.capacity > 5000) return 'Capacity must be 1–5,000 whole units, employees or students.'
  if (!Number.isFinite(spec.people_per_unit) || spec.people_per_unit <= 0 || spec.people_per_unit > 10) return 'People per unit must be greater than 0 and at most 10.'
  if (spec.land_use !== 'residential' && spec.people_per_unit !== 1) return 'Office, school and park capacity already counts people; people per unit must be 1.'
  if (!Number.isFinite(spec.trip_rate) || spec.trip_rate <= 0 || spec.trip_rate > 1) return 'Participation must be greater than 0% and at most 100%.'
  if (!Number.isFinite(spec.car_share) || spec.car_share < 0 || spec.car_share > 1) return 'Car share must be 0–100%.'
  if (!Number.isInteger(spec.walk_limit_m) || spec.walk_limit_m < 0 || spec.walk_limit_m > 10000) return 'Walking limit must be 0–10,000 m.'
  if (!spec.position.every(Number.isFinite) || Math.abs(spec.position[0]) > 180 || Math.abs(spec.position[1]) > 85) return 'Choose a valid map position.'
  if (spec.footprint_m.some((n) => !Number.isFinite(n) || n <= 0 || n > 250)) return 'Footprint dimensions must be greater than 0 and at most 250 m.'
  if (!Number.isFinite(spec.height_m) || spec.height_m <= 0 || spec.height_m > 300) return 'Display height must be greater than 0 and at most 300 m.'
  const shares = Object.values(spec.zone_shares)
  if (!shares.length || shares.some((n) => !Number.isFinite(n) || n < 0 || n > 1) || Math.abs(shares.reduce((a, b) => a + b, 0) - 1) > 1e-6) return 'Counterpart zone shares must add up to 100%.'
  for (const wave of [spec.first_wave, spec.return_wave]) {
    if (wave && (!Number.isInteger(wave.start_s) || !Number.isInteger(wave.end_s) || wave.start_s < 0 || wave.end_s <= wave.start_s || wave.end_s > horizon)) return 'Departure windows must be ordered and fit within this scenario’s horizon.'
  }
  if (spec.return_wave && spec.return_wave.start_s < spec.first_wave.end_s) return 'The return/dismissal wave must follow the first wave.'
  if (!Number.isInteger(spec.seed) || spec.seed < 0 || spec.seed > 2147483647) return 'Seed must be a non-negative 32-bit integer.'
  const { trips } = developmentCounts(spec)
  return trips < 1 || trips > 10000 ? 'These assumptions must generate between 1 and 10,000 one-way trips.' : null
}
