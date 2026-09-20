import { create } from 'zustand'
import type { TornadoTrack } from '../babylon/tornadoPlacement'
import type { GodIntensity } from './model'

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
  setArmed: (armed: boolean) => void
  setScope: (scope: string) => void
  addEvent: (event: VisualCityEvent) => boolean
  removeEvent: (id: string) => void
  clear: () => void
}

export const useGodVisuals = create<GodVisualState>((set, get) => ({
  scope: null,
  armed: false,
  events: [],
  setArmed: (armed) => set({ armed }),
  setScope: (scope) => {
    if (get().scope !== scope) set({ scope, events: [], armed: false })
  },
  addEvent: (event) => {
    if (get().events.length >= 4 || get().events.some((e) => e.id === event.id)) return false
    set({ events: [...get().events, event], armed: false })
    return true
  },
  removeEvent: (id) => set({ events: get().events.filter((e) => e.id !== id) }),
  clear: () => set({ events: [], armed: false }),
}))
