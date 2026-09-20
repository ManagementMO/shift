import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { DEFAULT_PREFERENCES, investigationOptions, normalizePreferences, usePreferences } from './preferences'

afterEach(() => { usePreferences.getState().reset(); vi.unstubAllGlobals() })

describe('Simulation preferences', () => {
  it('bounds persisted settings and ignores unrelated fields', () => {
    expect(normalizePreferences(null)).toEqual(DEFAULT_PREFERENCES)
    expect(normalizePreferences({ aiEnabled: false, candidatePlans: 999, reasoningSteps: -1, useElasticsearch: false, extra: 'ignored' })).toEqual({ aiEnabled: false, candidatePlans: 2, reasoningSteps: 6, useElasticsearch: false })
  })

  it('maps UI choices to the bounded API contract', () => {
    expect(investigationOptions({ aiEnabled: false, candidatePlans: 1, reasoningSteps: 2, useElasticsearch: false })).toEqual({ ai_enabled: false, plan_variants: 1, max_iterations: 2, use_elasticsearch: false })
  })

  it('sends AI-off and retrieval preferences with actual API requests', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    vi.stubGlobal('fetch', request)
    usePreferences.getState().update({ aiEnabled: false, candidatePlans: 1, reasoningSteps: 4, useElasticsearch: false })
    await api.investigate('scenario', 'event closure', 'two buses')
    expect(JSON.parse(request.mock.calls[0][1].body).options).toEqual({ ai_enabled: false, plan_variants: 1, max_iterations: 4, use_elasticsearch: false })
    await api.previewEdit('scenario', 'close Front St')
    expect(JSON.parse(request.mock.calls[1][1].body)).toEqual({ prompt: 'close Front St', use_ai: false })
  })
})
