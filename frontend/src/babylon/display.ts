import { create } from 'zustand'

export interface DisplaySettings {
  shadows: boolean
  textures: boolean
  sharp: boolean
  projection: 'perspective' | 'isometric'
  lighting: 'afternoon' | 'golden'
  /** Travellers and vehicles are drawn this many times life-size so the swarm reads from the city camera. */
  swarmScale: number
}

export const useDisplay = create<DisplaySettings & { set: (patch: Partial<DisplaySettings>) => void }>((set) => ({
  shadows: true,
  textures: true,
  sharp: true,
  projection: 'perspective',
  lighting: 'afternoon',
  swarmScale: 1,
  set: (patch) => set(patch),
}))

export function renderScale(dpr: number, sharp: boolean, width = 0, height = 0): number {
  const desired = sharp ? 2 : Math.min(Math.max(1, dpr || 1), 1.5)
  const budget = width > 0 && height > 0 ? Math.max(1, Math.sqrt(8_294_400 / (width * height))) : desired
  return 1 / Math.min(desired, budget)
}
