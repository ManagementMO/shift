import { utmForward, utmInverse, type WorldFrame } from './babylon/coords'
import type { CityPack, Development, DevelopmentSpec, DevelopmentUse, RunBundle, ScenarioSpec } from './types'

export const DEVELOPMENT_USES: Record<DevelopmentUse, { label: string; unit: string; color: string }> = {
  residential: { label: 'Apartments', unit: 'units', color: '#178f83' },
  office: { label: 'Offices', unit: 'employees', color: '#6764c5' },
  school: { label: 'School', unit: 'students', color: '#c48529' },
}

export function developmentPreset(pack: CityPack, horizon: number, use: DevelopmentUse = 'residential'): DevelopmentSpec {
  const residential = use === 'residential'
  const school = use === 'school'
  const totalShare = pack.zones.reduce((sum, z) => sum + z.share, 0)
  return {
    name: `New ${DEVELOPMENT_USES[use].label.toLowerCase()}`,
    land_use: use, position: [...pack.venue_lonlat],
    footprint_m: school ? [60, 40] : residential ? [36, 26] : [44, 32],
    height_m: school ? 12 : residential ? 30 : 45,
    capacity: residential ? 500 : school ? 300 : 200,
    people_per_unit: residential ? 2 : 1,
    trip_rate: residential ? 0.5 : school ? 1 : 0.8,
    car_share: residential ? 0.35 : school ? 0.2 : 0.55,
    walk_limit_m: 1500,
    zone_shares: Object.fromEntries(pack.zones.map((z) => [z.zone_id, totalShare ? z.share / totalShare : 1 / pack.zones.length])),
    first_wave: { start_s: 0, end_s: Math.min(horizon, school ? 300 : residential ? 900 : 600), profile: residential ? 'uniform' : 'triangular' },
    return_wave: null, seed: 7,
  }
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
  if (spec.land_use !== 'residential' && spec.people_per_unit !== 1) return 'Office and school capacity already counts people; people per unit must be 1.'
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
