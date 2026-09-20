import { create } from 'zustand'

export interface DisplaySettings {
  shadows: boolean
  textures: boolean
  sharp: boolean
  projection: 'perspective' | 'isometric'
  lighting: 'afternoon' | 'golden'
}

export const useDisplay = create<DisplaySettings & { set: (patch: Partial<DisplaySettings>) => void }>((set) => ({
  shadows: true,
  textures: true,
  sharp: false,
  projection: 'perspective',
  lighting: 'afternoon',
  set: (patch) => set(patch),
}))

export function renderScale(dpr: number, sharp: boolean): number {
  return 1 / Math.min(Math.max(1, dpr || 1), sharp ? 2 : 1.5)
}
