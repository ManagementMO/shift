import type {
  CityPack,
  CompileInfo,
  Corridor,
  DemandSet,
  EntityTrack,
  EvidenceBundle,
  Health,
  InterventionProposal,
  Investigation,
  PersonEvent,
  PlanWithValidation,
  PopulationArtifact,
  PopulationPauseResponse,
  PopulationSpec,
  RunBundle,
  ScenarioSpec,
  ServicePlan,
  SimulationRun,
  ValidationReport,
} from './types'
import { parsePopulationArtifact, parsePopulationDefinition, parsePopulationStatus } from './populationValidation'

const BASE = import.meta.env.VITE_API_BASE ?? ''

async function get<T>(path: string, fresh = false): Promise<T> {
  const r = await fetch(`${BASE}${path}`, fresh ? { cache: 'no-store' } : undefined)
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

async function populationArtifact(run: SimulationRun): Promise<PopulationArtifact | null> {
  if (run.run_kind !== 'population') return null
  const path = `/api/runs/${encodeURIComponent(run.run_id)}/population`
  const response = await fetch(`${BASE}${path}`, { cache: 'no-store' })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
  const artifact = parsePopulationArtifact(await response.json())
  if (artifact.run_id !== run.run_id || (run.population_id && artifact.definition.population_id !== run.population_id)) throw new Error(`${path}: population artifact does not match the requested run`)
  return artifact
}

export const api = {
  populationStatus: async () => parsePopulationStatus(await get<unknown>('/api/population/status', true)),
  createPopulation: (spec: PopulationSpec) => post<ScenarioSpec>('/api/population/scenarios', spec),
  populationDefinition: async (id: string) => parsePopulationDefinition(await get<unknown>(`/api/population/scenarios/${encodeURIComponent(id)}`)),
  submitPopulationRun: (population_id: string, idempotency_key: string) => post<SimulationRun>('/api/population/runs', { population_id, idempotency_key }),
  pausePopulationRun: (rid: string) => post<PopulationPauseResponse>(`/api/population/runs/${encodeURIComponent(rid)}/pause`, {}),
  resumePopulationRun: (rid: string) => post<SimulationRun>(`/api/population/runs/${encodeURIComponent(rid)}/resume`, {}),
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
  runs: (sid?: string) => get<SimulationRun[]>(`/api/runs${sid ? `?scenario_id=${encodeURIComponent(sid)}` : ''}`, true),
  run: (rid: string) => get<SimulationRun>(`/api/runs/${rid}`, true),
  submitRun: (scenario_id: string, plan_id: string, seed = 1) =>
    post<SimulationRun>('/api/runs', { scenario_id, plan_id, seed }),
  cancelRun: (rid: string) => post<{ canceled: boolean }>(`/api/runs/${rid}/cancel`, {}),
  async bundle(run: SimulationRun): Promise<RunBundle> {
    const fresh = run.run_kind === 'population'
    const [tracks, events, occupancy, stopQueue, compile, population] = await Promise.all([
      get<Record<string, EntityTrack>>(`/api/runs/${run.run_id}/tracks`, fresh),
      get<PersonEvent[]>(`/api/runs/${run.run_id}/events`, fresh),
      get<Record<string, [number, number][]>>(`/api/runs/${run.run_id}/occupancy`, fresh),
      get<Record<string, [number, number][]>>(`/api/runs/${run.run_id}/stop_queue`, fresh),
      get<CompileInfo>(`/api/runs/${run.run_id}/compile`, fresh).catch(() => null),
      populationArtifact(run),
    ])
    return { run, tracks, events, occupancy, stopQueue, compile, population }
  },
  // prompt-to-edit
  previewEdit: (sid: string, prompt: string) =>
    post<InterventionProposal>(`/api/scenarios/${sid}/edit/preview`, { prompt }),
  applyEdit: (sid: string, proposal: InterventionProposal) =>
    post<ScenarioSpec>(`/api/scenarios/${sid}/edit/apply`, proposal),
  // agents
  investigate: (sid: string, problem: string, constraint: string) =>
    post<Investigation>(`/api/scenarios/${sid}/investigate`, { problem, constraint }),
  investigation: (id: string) => get<Investigation>(`/api/investigations/${id}`),
  // evidence
  evidence: (bid: string) => get<EvidenceBundle>(`/api/evidence/${bid}`),
  // share
  exportReplay: (rid: string) => post<{ path: string; mode: string; url: string | null; bytes: number }>(`/api/runs/${rid}/export`, {}),
}
