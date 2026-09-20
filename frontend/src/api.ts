import type {
  CityPack,
  CompileInfo,
  Corridor,
  DemandSet,
  EntityTrack,
  EvidenceBundle,
  HazardDraft,
  Health,
  InterventionProposal,
  Investigation,
  PersonEvent,
  PlanWithValidation,
  RunBundle,
  ScenarioSpec,
  ServicePlan,
  SimulationRun,
  ValidationReport,
} from './types'

import { investigationOptions, usePreferences } from './preferences'

const BASE = import.meta.env.VITE_API_BASE ?? ''

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`)
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`)
  return (await r.json()) as T
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`)
  return (await r.json()) as T
}

export const api = {
  health: () => get<Health>('/api/health'),
  packs: () => get<{ pack_id: string; name: string }[]>('/api/packs'),
  pack: (id: string) => get<CityPack>(`/api/packs/${id}`),
  roads: (id: string) => get<GeoJSON.FeatureCollection>(`/api/packs/${id}/roads`),
  corridors: (id: string) => get<Record<string, Corridor>>(`/api/packs/${id}/corridors`),
  scenarios: () => get<ScenarioSpec[]>('/api/scenarios'),
  scenario: (id: string) => get<ScenarioSpec>(`/api/scenarios/${id}`),
  createFlagship: (body: { pack_id: string; seed: number; cohort_size: number; horizon_s: number }) =>
    post<ScenarioSpec>('/api/scenarios/flagship', body),
  demand: (sid: string) => get<DemandSet>(`/api/scenarios/${sid}/demand`),
  plans: (sid: string) => get<PlanWithValidation[]>(`/api/scenarios/${sid}/plans`),
  submitPlan: (sid: string, plan: ServicePlan) =>
    post<PlanWithValidation>(`/api/scenarios/${sid}/plans`, plan),
  validatePlan: (sid: string, plan: ServicePlan) => post<ValidationReport>(`/api/scenarios/${sid}/validate`, plan),
  runs: (sid?: string) => get<SimulationRun[]>(`/api/runs${sid ? `?scenario_id=${encodeURIComponent(sid)}` : ''}`),
  run: (rid: string) => get<SimulationRun>(`/api/runs/${rid}`),
  submitRun: (scenario_id: string, plan_id: string, seed = 1) =>
    post<SimulationRun>('/api/runs', { scenario_id, plan_id, seed }),
  cancelRun: (rid: string) => post<{ canceled: boolean }>(`/api/runs/${rid}/cancel`, {}),
  async bundle(run: SimulationRun): Promise<RunBundle> {
    const [tracks, events, occupancy, stopQueue, compile] = await Promise.all([
      get<Record<string, EntityTrack>>(`/api/runs/${run.run_id}/tracks`),
      get<PersonEvent[]>(`/api/runs/${run.run_id}/events`),
      get<Record<string, [number, number][]>>(`/api/runs/${run.run_id}/occupancy`),
      get<Record<string, [number, number][]>>(`/api/runs/${run.run_id}/stop_queue`),
      get<CompileInfo>(`/api/runs/${run.run_id}/compile`).catch(() => null),
    ])
    return { run, tracks, events, occupancy, stopQueue, compile }
  },
  // prompt-to-edit
  previewEdit: (sid: string, prompt: string) =>
    post<InterventionProposal>(`/api/scenarios/${sid}/edit/preview`, { prompt, use_ai: usePreferences.getState().preferences.aiEnabled }),
  previewHazard: (sid: string, draft: HazardDraft) =>
    post<InterventionProposal>(`/api/scenarios/${sid}/hazards/preview`, draft),
  previewHazardRemoval: (sid: string, trackId: string) =>
    post<InterventionProposal>(`/api/scenarios/${sid}/hazards/${encodeURIComponent(trackId)}/remove/preview`, {}),
  previewHazardReplacement: (sid: string, trackId: string, draft: HazardDraft) =>
    post<InterventionProposal>(`/api/scenarios/${sid}/hazards/${encodeURIComponent(trackId)}/replace/preview`, draft),
  applyEdit: (sid: string, proposal: InterventionProposal) =>
    post<ScenarioSpec>(`/api/scenarios/${sid}/edit/apply`, proposal),
  // agents
  investigate: (sid: string, problem: string, constraint: string) =>
    post<Investigation>(`/api/scenarios/${sid}/investigate`, { problem, constraint, options: investigationOptions(usePreferences.getState().preferences) }),
  investigation: (id: string) => get<Investigation>(`/api/investigations/${id}`),
  // evidence
  evidence: (bid: string) => get<EvidenceBundle>(`/api/evidence/${bid}`),
  // share
  exportReplay: (rid: string) => post<{ path: string; mode: string; url: string | null; bytes: number }>(`/api/runs/${rid}/export`, {}),
}
