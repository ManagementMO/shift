import { create } from 'zustand'

export interface Preferences {
  aiEnabled: boolean
  candidatePlans: 1 | 2
  reasoningSteps: 2 | 4 | 6
  useElasticsearch: boolean
}

export const DEFAULT_PREFERENCES: Preferences = { aiEnabled: true, candidatePlans: 2, reasoningSteps: 6, useElasticsearch: true }
const KEY = 'concrete-consequences.preferences.v1'

export function normalizePreferences(value: unknown): Preferences {
  const data = value && typeof value === 'object' ? value as Partial<Preferences> : {}
  return {
    aiEnabled: typeof data.aiEnabled === 'boolean' ? data.aiEnabled : true,
    candidatePlans: data.candidatePlans === 1 ? 1 : 2,
    reasoningSteps: data.reasoningSteps === 2 || data.reasoningSteps === 4 ? data.reasoningSteps : 6,
    useElasticsearch: typeof data.useElasticsearch === 'boolean' ? data.useElasticsearch : true,
  }
}

function load(): Preferences {
  if (typeof window === 'undefined') return { ...DEFAULT_PREFERENCES }
  try { return normalizePreferences(JSON.parse(window.localStorage.getItem(KEY) ?? 'null')) }
  catch { return { ...DEFAULT_PREFERENCES } }
}

export function investigationOptions(preferences: Preferences) {
  return {
    ai_enabled: preferences.aiEnabled,
    plan_variants: preferences.candidatePlans,
    max_iterations: preferences.reasoningSteps,
    use_elasticsearch: preferences.useElasticsearch,
  }
}

export const usePreferences = create<{ preferences: Preferences; update: (patch: Partial<Preferences>) => void; reset: () => void }>((set, get) => ({
  preferences: load(),
  update: (patch) => {
    const preferences = normalizePreferences({ ...get().preferences, ...patch })
    set({ preferences })
    if (typeof window === 'undefined') return
    try { window.localStorage.setItem(KEY, JSON.stringify(preferences)) } catch { return }
  },
  reset: () => get().update(DEFAULT_PREFERENCES),
}))
