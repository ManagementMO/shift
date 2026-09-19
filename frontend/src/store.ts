import { create } from 'zustand'
import { api } from './api'
import { buildIndex, type ReplayIndex } from './replay'
import type {
  CityPack,
  Health,
  Investigation,
  PlanWithValidation,
  ScenarioSpec,
  SimulationRun,
} from './types'

export type Selection =
  | { kind: 'bus'; id: string }
  | { kind: 'person'; id: string }
  | { kind: 'car'; id: string }
  | { kind: 'stop'; id: string }
  | { kind: 'restriction'; id: string }
  | null

type State = {
  health: Health | null
  pack: CityPack | null
  roads: GeoJSON.FeatureCollection | null
  scenarios: ScenarioSpec[]
  scenarioId: string | null
  plans: PlanWithValidation[]
  runs: SimulationRun[]
  primaryRunId: string | null
  compareRunId: string | null
  replays: Record<string, ReplayIndex>
  loadingReplay: string | null
  t: number
  playing: boolean
  speed: number
  selection: Selection
  investigation: Investigation | null
  error: string | null
  showCars: boolean
  showPersons: boolean
  showRoads: boolean

  boot: () => Promise<void>
  selectScenario: (sid: string) => Promise<void>
  createFlagship: (cohort: number, seed: number) => Promise<void>
  refreshRuns: () => Promise<void>
  submitRun: (planId: string, seed?: number) => Promise<void>
  cancelRun: (rid: string) => Promise<void>
  openRun: (rid: string, slot: 'primary' | 'compare') => Promise<void>
  setT: (t: number) => void
  setPlaying: (p: boolean) => void
  setSpeed: (s: number) => void
  select: (s: Selection) => void
  setInvestigation: (i: Investigation | null) => void
  toggle: (k: 'showCars' | 'showPersons' | 'showRoads') => void
  setError: (e: string | null) => void
}

export const useStore = create<State>((set, get) => ({
  health: null,
  pack: null,
  roads: null,
  scenarios: [],
  scenarioId: null,
  plans: [],
  runs: [],
  primaryRunId: null,
  compareRunId: null,
  replays: {},
  loadingReplay: null,
  t: 0,
  playing: false,
  speed: 10,
  selection: null,
  investigation: null,
  error: null,
  showCars: true,
  showPersons: true,
  showRoads: true,

  async boot() {
    try {
      const [health, scenarios] = await Promise.all([api.health(), api.scenarios()])
      set({ health, scenarios })
      const packId = scenarios[0]?.pack_id ?? 'waterloo'
      const [pack, roads] = await Promise.all([api.pack(packId), api.roads(packId)])
      set({ pack, roads })
      if (scenarios.length) await get().selectScenario(scenarios[scenarios.length - 1].scenario_id)
    } catch (e) {
      set({ error: String(e) })
    }
  },

  async selectScenario(sid) {
    set({ scenarioId: sid, primaryRunId: null, compareRunId: null, selection: null, t: 0, playing: false })
    const [plans, runs] = await Promise.all([api.plans(sid), api.runs(sid)])
    set({ plans, runs })
    const done = runs.filter((r) => r.status === 'completed')
    if (done.length) await get().openRun(done[done.length - 1].run_id, 'primary')
  },

  async createFlagship(cohort, seed) {
    try {
      const s = await api.createFlagship({ pack_id: get().pack?.pack_id ?? 'waterloo', seed, cohort_size: cohort, horizon_s: 2700 })
      const scenarios = await api.scenarios()
      set({ scenarios })
      await get().selectScenario(s.scenario_id)
    } catch (e) {
      set({ error: String(e) })
    }
  },

  async refreshRuns() {
    const sid = get().scenarioId
    if (!sid) return
    const runs = await api.runs(sid)
    set({ runs })
  },

  async submitRun(planId, seed = 1) {
    const sid = get().scenarioId
    if (!sid) return
    try {
      await api.submitRun(sid, planId, seed)
      await get().refreshRuns()
    } catch (e) {
      set({ error: String(e) })
    }
  },

  async cancelRun(rid) {
    await api.cancelRun(rid)
    await get().refreshRuns()
  },

  async openRun(rid, slot) {
    const { replays, runs } = get()
    if (!replays[rid]) {
      const run = runs.find((r) => r.run_id === rid) ?? (await api.run(rid))
      set({ loadingReplay: rid })
      try {
        const bundle = await api.bundle(run)
        set({ replays: { ...get().replays, [rid]: buildIndex(bundle) } })
      } catch (e) {
        set({ error: String(e), loadingReplay: null })
        return
      }
      set({ loadingReplay: null })
    }
    if (slot === 'primary') set({ primaryRunId: rid })
    else set({ compareRunId: rid === get().compareRunId ? null : rid })
  },

  setT: (t) => set({ t }),
  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),
  select: (selection) => set({ selection }),
  setInvestigation: (investigation) => set({ investigation }),
  toggle: (k) => set({ [k]: !get()[k] } as Partial<State>),
  setError: (error) => set({ error }),
}))
