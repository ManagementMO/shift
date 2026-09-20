export const LASER_MIN_RADIUS = 25
export const LASER_MAX_RADIUS = 1000
export const LASER_RADIUS_STEP = 25
export const LASER_TIME_SCALE = 2
export const LASER_DURATION = 1.2 * LASER_TIME_SCALE
export const LASER_IMPACT_TIME = 0.2 * LASER_TIME_SCALE
export const LASER_EXPANSION_START = 0.36 * LASER_TIME_SCALE
export const LASER_EXPANSION_END = 0.82 * LASER_TIME_SCALE
export const MAX_LASER_STRIKES = 8

export interface LaserCircle {
  x: number
  z: number
  radius: number
}

export interface OrbitalStrike extends LaserCircle {
  id: string
  firedAt: number
}

export interface OrbitalImpact {
  buildings: number
  entities: number
  developments: number
}

export function laserRadius(value: number): number {
  return Number.isFinite(value) ? Math.max(LASER_MIN_RADIUS, Math.min(LASER_MAX_RADIUS, Math.round(value / LASER_RADIUS_STEP) * LASER_RADIUS_STEP)) : 150
}

const smooth = (value: number): number => {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}

export function laserEnvelope(age: number, radius = 150): { bottom: number; intensity: number; width: number } {
  const needle = Math.min(0.06, 6 / radius)
  return {
    bottom: 1 - smooth(age / LASER_IMPACT_TIME),
    intensity: smooth(age / (0.14 * LASER_TIME_SCALE)) * (1 - smooth((age - LASER_EXPANSION_END) / (LASER_DURATION - LASER_EXPANSION_END))),
    width: needle + (1 - needle) * smooth((age - LASER_EXPANSION_START) / (LASER_EXPANSION_END - LASER_EXPANSION_START)),
  }
}

export function insideLaser(circle: LaserCircle, x: number, z: number): boolean {
  return (x - circle.x) ** 2 + (z - circle.z) ** 2 <= circle.radius ** 2
}
