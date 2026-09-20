import { create } from 'zustand'
import type { TornadoTrack } from '../babylon/tornadoPlacement'
import type { GodIntensity } from './model'
import { LASER_MAX_RADIUS, LASER_MIN_RADIUS, MAX_LASER_STRIKES, type OrbitalImpact, type OrbitalStrike } from '../babylon/orbitalLaserModel'

export interface VisualCityEvent {
  id: string
  track: TornadoTrack
  area: string
  intensity: GodIntensity
}

export interface VisualLaserEvent {
  strike: OrbitalStrike
  area: string
  impact?: OrbitalImpact
}

interface GodVisualState {
  scope: string | null
  armed: boolean
  events: VisualCityEvent[]
  lasers: VisualLaserEvent[]
  lastKind: 'tornado' | 'orbital' | null
  setArmed: (armed: boolean) => void
  setScope: (scope: string) => void
  addEvent: (event: VisualCityEvent) => boolean
  removeEvent: (id: string) => void
  addLaser: (event: VisualLaserEvent) => boolean
  completeLaser: (id: string, impact: OrbitalImpact) => void
  removeLaser: (id: string) => void
  clear: () => void
}

const empty = { events: [] as VisualCityEvent[], lasers: [] as VisualLaserEvent[], armed: false, lastKind: null }

export const useGodVisuals = create<GodVisualState>((set, get) => ({
  scope: null,
  ...empty,
  setArmed: (armed) => set({ armed }),
  setScope: (scope) => {
    if (get().scope !== scope) set({ scope, ...empty })
  },
  addEvent: (event) => {
    if (get().events.length >= 4 || get().events.some((e) => e.id === event.id)) return false
    set({ events: [...get().events, event], armed: false, lastKind: 'tornado' })
    return true
  },
  removeEvent: (id) => {
    const events = get().events.filter(e => e.id !== id)
    set({ events, lastKind: events.length ? 'tornado' : get().lasers.length ? 'orbital' : null })
  },
  addLaser: (event) => {
    const { strike } = event
    if (get().lasers.length >= MAX_LASER_STRIKES || get().lasers.some(e => e.strike.id === strike.id)) return false
    if (!strike.id || ![strike.x, strike.z, strike.radius, strike.firedAt].every(Number.isFinite) || strike.radius < LASER_MIN_RADIUS || strike.radius > LASER_MAX_RADIUS) return false
    set({ lasers: [...get().lasers, event], armed: false, lastKind: 'orbital' })
    return true
  },
  completeLaser: (id, impact) => {
    if (get().lasers.some(e => e.strike.id === id && !e.impact)) set({ lasers: get().lasers.map(e => e.strike.id === id ? { ...e, impact } : e) })
  },
  removeLaser: (id) => {
    const lasers = get().lasers.filter(e => e.strike.id !== id)
    set({ lasers, lastKind: lasers.length ? 'orbital' : get().events.length ? 'tornado' : null })
  },
  clear: () => set({ ...empty }),
}))
