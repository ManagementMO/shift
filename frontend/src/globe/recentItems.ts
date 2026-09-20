import { create } from 'zustand'
import { api } from '../api'
import type { ScenarioSpec, SimulationRun } from '../types'
import { locationForPack, type Location } from './flight'

export interface RecentItem {
  scenario: ScenarioSpec
  location: Location
  title: string
  branch: string | null
  run: SimulationRun | null
  status: string
  measured: boolean
  createdAt: number
}

const RANK: Record<string, number> = { running: 0, queued: 1, completed: 2, failed: 3, canceled: 4, invalid: 5, validated: 6, draft: 7 }

/** Human title for a scenario label such as "Event egress (Toronto, ON (Downtown)) during the X closure; two extra buses". */
export function scenarioTitle(label: string): { title: string; branch: string | null } {
  const [head, ...edits] = label.split(' · edit: ')
  const m = head.match(/^(.*?)\s*\(.*?\)\)?\s*(during .*?)(;|$)/)
  const title = (m ? `${m[1]} ${m[2]}` : head).replace(/\s+/g, ' ').trim()
  const branch = edits.length ? edits[edits.length - 1].replace(/\s*\(.*?\)\s*$/, '').trim() : null
  return { title: title || 'Scenario', branch: branch || null }
}

export function runSummary(run: SimulationRun | null): { status: string; measured: boolean } {
  if (!run) return { status: 'No run yet', measured: false }
  if (run.status === 'completed') {
    const m = run.metrics
    return { status: m ? `Measured · ${m.completed} of ${m.cohort_size} arrived` : 'Measured', measured: true }
  }
  if (run.status === 'running') return { status: `Simulating ${Math.round((run.progress ?? 0) * 100)}%`, measured: false }
  if (run.status === 'queued') return { status: 'Queued', measured: false }
  return { status: run.status[0].toUpperCase() + run.status.slice(1), measured: false }
}

/** Most relevant run per scenario: active work first, then the newest measured result. */
export function latestRun(runs: SimulationRun[]): SimulationRun | null {
  return [...runs].sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null
}

export function recentItems(scenarios: ScenarioSpec[], runs: SimulationRun[], limit = 8): RecentItem[] {
  const items: RecentItem[] = []
  for (const scenario of scenarios) {
    const location = locationForPack(scenario.pack_id)
    if (!location) continue
    const run = latestRun(runs.filter((r) => r.scenario_id === scenario.scenario_id))
    const { title, branch } = scenarioTitle(scenario.label)
    items.push({ scenario, location, title, branch, run, ...runSummary(run), createdAt: Math.max(Date.parse(scenario.created_at) || 0, run ? Date.parse(run.created_at) || 0 : 0) })
  }
  return items.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
}

interface RecentState {
  items: RecentItem[] | null
  failed: boolean
  loadedAt: number
  refresh: () => Promise<void>
}

let refreshRequest = 0

/** Shared across globe visits so returning from the city shows the last list immediately while it refreshes. */
export const useRecentWork = create<RecentState>((set) => ({
  items: null,
  failed: false,
  loadedAt: 0,
  async refresh() {
    const request = ++refreshRequest
    try {
      const [scenarios, runs] = await Promise.all([api.scenarios(), api.runs()])
      if (request === refreshRequest) set({ items: recentItems(scenarios, runs), failed: false, loadedAt: Date.now() })
    } catch { if (request === refreshRequest) set({ failed: true }) }
  },
}))

export function relativeTime(iso: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - iso) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}
