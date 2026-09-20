import { create } from 'zustand'
import type { TornadoTrack } from '../babylon/tornadoPlacement'
import type { Hazard } from '../live/types'
import type { GodIntensity } from './model'

/** A real weather / fire event being aimed: the cloud follows the cursor and a click posts the live incident. */
export interface WeatherAim {
  hazard: Hazard
  radius_m: number
  duration_s: number
  label: string
}

export interface VisualCityEvent {
  id: string
  track: TornadoTrack
  area: string
  intensity: GodIntensity
}

interface GodVisualState {
  scope: string | null
  armed: boolean
  events: VisualCityEvent[]
  /** Live weather / fire placement in progress (measured by SUMO once cast), and where the cursor is aiming it. */
  weather: WeatherAim | null
  weatherAt: [number, number] | null
  setArmed: (armed: boolean) => void
  setWeather: (aim: WeatherAim | null) => void
  setWeatherAt: (lonLat: [number, number] | null) => void
  setScope: (scope: string) => void
  addEvent: (event: VisualCityEvent) => boolean
  removeEvent: (id: string) => void
  clear: () => void
}

export const useGodVisuals = create<GodVisualState>((set, get) => ({
  scope: null,
  armed: false,
  events: [],
  weather: null,
  weatherAt: null,
  setArmed: (armed) => set({ armed }),
  setWeather: (weather) => set({ weather, weatherAt: weather ? get().weatherAt : null }),
  setWeatherAt: (weatherAt) => {
    const before = get().weatherAt
    if (before === weatherAt || (before && weatherAt && before[0] === weatherAt[0] && before[1] === weatherAt[1])) return
    set({ weatherAt })
  },
  setScope: (scope) => {
    if (get().scope !== scope) set({ scope, events: [], armed: false, weather: null, weatherAt: null })
  },
  addEvent: (event) => {
    if (get().events.length >= 4 || get().events.some((e) => e.id === event.id)) return false
    set({ events: [...get().events, event], armed: false })
    return true
  },
  removeEvent: (id) => set({ events: get().events.filter((e) => e.id !== id) }),
  clear: () => set({ events: [], armed: false, weather: null, weatherAt: null }),
}))
