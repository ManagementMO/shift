import type { Hazard } from './types'

// Mirrors backend/cityshift/live/contracts.py HAZARDS so previews match what SUMO will apply.
export const ALARM_FACTOR: Record<Hazard, number> = { crash: 2.5, fire: 3, flood: 2, tornado: 4, gas_leak: 3 }
export const DEFAULT_DURATION: Record<Hazard, number> = { crash: 900, fire: 1800, flood: 3600, tornado: 600, gas_leak: 1200 }

export interface IncidentSettings { hazard: Hazard; radius_m: number; duration_s: number | null; label: string; place: { lon: number; lat: number } | null }
export const DEFAULT_INCIDENT: IncidentSettings = { hazard: 'crash', radius_m: 120, duration_s: null, label: '', place: null }
export const alarmRadius = (settings: IncidentSettings): number => Math.round(settings.radius_m * ALARM_FACTOR[settings.hazard] * 10) / 10
