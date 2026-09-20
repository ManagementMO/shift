import { create } from 'zustand'
import { api } from './api'
import { buildIndex, type ReplayIndex } from './replay'
import { clock } from './world/playback'
import { cityPose, type CameraMode } from './world/camera'
import { cameraTo } from './world/registry'
import type {
  CityPack,
  HazardTrack,
  Health,
  InterventionProposal,
  Investigation,
  PlanWithValidation,
  ScenarioSpec,
  SimulationRun,
  StopCandidate,
  Traveler,
} from './types'

export type Selection =
  | { kind: 'bus'; id: string }
  | { kind: 'person'; id: string }
  | { kind: 'car'; id: string }
  | { kind: 'stop'; id: string }
  | { kind: 'restriction'; id: string }
  | null

export type ToolId = 'road' | 'intersection' | 'stop' | 'route' | 'population' | 'event' | 'closure' | 'weather'

export type LensTab = 'people' | 'agents' | 'transport' | 'diagnostics'

/** A proposed-but-unconfirmed change, drawn as a ghost on the world. Never applied without confirm. */
export type Ghost = {
  proposal: InterventionProposal | null
  edges: string[]
  stops: StopCandidate[]
  hazard: HazardTrack | null
}

type State = {
  health: Health | null
  packs: { pack_id: string; name: string }[]
  pack: CityPack | null
  roads: GeoJSON.FeatureCollection | null
  scenarios: ScenarioSpec[]
  scenarioId: string | null
  travelers: Record<string, Traveler>
  plans: PlanWithValidation[]
  runs: SimulationRun[]
  primaryRunId: string | null
  replays: Record<string, ReplayIndex>
  loadingReplay: string | null
  /** UI-rate copy of the playback clock (≈10 Hz); the renderer reads `clock.t` directly. */
  t: number
  playing: boolean
  speed: number
  selection: Selection
  investigation: Investigation | null
  error: string | null
  // shell
  tool: ToolId | null
  ghost: Ghost | null
  lens: LensTab | null
  developer: boolean
  cameraMode: CameraMode
  building: string | null // "freeze → build → reload" banner text while a branch is compiled

  boot: (packId?: string) => Promise<void>
  selectPack: (packId: string) => Promise<void>
  selectScenario: (sid: string) => Promise<void>
  createFlagship: (cohort: number, seed: number) => Promise<void>
  refreshRuns: () => Promise<void>
  submitRun: (planId: string, seed?: number) => Promise<void>
  cancelRun: (rid: string) => Promise<void>
  openRun: (rid: string) => Promise<void>
  select: (s: Selection) => void
  setInvestigation: (i: Investigation | null) => void
  setError: (e: string | null) => void
  setTool: (t: ToolId | null) => void
  setGhost: (g: Ghost | null) => void
  setLens: (l: LensTab | null) => void
  setDeveloper: (d: boolean) => void
  setCameraMode: (m: CameraMode) => void
  applyGhost: () => Promise<void>
}

let packSelectionRequest = 0
let scenarioSelectionRequest = 0

export const useStore = create<State>((set, get) => ({
  health: null,
  packs: [],
  pack: null,
  roads: null,
  scenarios: [],
  scenarioId: null,
  travelers: {},
  plans: [],
  runs: [],
  primaryRunId: null,
  replays: {},
  loadingReplay: null,
  t: clock.t,
  playing: clock.playing,
  speed: clock.speed,
  selection: null,
  investigation: null,
  error: null,
  tool: null,
  ghost: null,
  lens: null,
  developer: false,
  cameraMode: 'city',
  building: null,

  async boot(requestedPackId) {
    const request = ++packSelectionRequest
    try {
      const [health, scenarios, packs] = await Promise.all([api.health(), api.scenarios(), api.packs()])
      if (request !== packSelectionRequest) return
      set({ health, scenarios, packs })
      const requested = packs.find((p) => p.pack_id === requestedPackId)
      const preferred = requested
        ? scenarios.filter((s) => s.pack_id === requested.pack_id).at(-1)
        : scenarios.find((s) => s.pack_id === 'toronto') ?? scenarios.at(-1)
      const packId = requested?.pack_id ?? preferred?.pack_id ?? packs.find((p) => p.pack_id === 'toronto')?.pack_id ?? packs[0]?.pack_id ?? 'toronto'
      const [pack, roads] = await Promise.all([api.pack(packId), api.roads(packId)])
      if (request !== packSelectionRequest) return
      set({ pack, roads })
      if (preferred) await get().selectScenario(preferred.scenario_id)
    } catch (e) {
      if (request === packSelectionRequest) set({ error: String(e) })
    }
  },

  async selectPack(packId) {
    const request = ++packSelectionRequest
    if (packId === get().pack?.pack_id) return
    try {
      const [pack, roads] = await Promise.all([api.pack(packId), api.roads(packId)])
      if (request !== packSelectionRequest) return
      clock.pause()
      clock.seek(0)
      set({
        pack, roads, scenarioId: null, travelers: {}, plans: [], runs: [], primaryRunId: null,
        loadingReplay: null, selection: null, ghost: null, investigation: null, tool: null, cameraMode: 'city', error: null,
      })
      cameraTo(cityPose(pack.pack_id, pack.center), 'city')
      const own = get().scenarios.filter((s) => s.pack_id === packId)
      if (own.length) await get().selectScenario(own[own.length - 1].scenario_id)
    } catch (e) {
      if (request === packSelectionRequest) set({ error: String(e) })
    }
  },

  async selectScenario(sid) {
    const request = ++scenarioSelectionRequest
    const sc = get().scenarios.find((s) => s.scenario_id === sid)
    if (sc && sc.pack_id !== get().pack?.pack_id) {
      const [pack, roads] = await Promise.all([api.pack(sc.pack_id), api.roads(sc.pack_id)])
      if (request !== scenarioSelectionRequest) return
      set({ pack, roads })
      cameraTo(cityPose(pack.pack_id, pack.center), 'city')
    }
    clock.pause()
    clock.seek(0)
    if (sc) clock.setHorizon(sc.constraints.horizon_s)
    set({ scenarioId: sid, plans: [], runs: [], travelers: {}, primaryRunId: null, loadingReplay: null, selection: null, ghost: null })
    const [plans, runs, demand] = await Promise.all([api.plans(sid), api.runs(sid), api.demand(sid).catch(() => null)])
    if (request !== scenarioSelectionRequest || get().scenarioId !== sid) return
    set({ plans, runs, travelers: Object.fromEntries((demand?.travelers ?? []).map((t) => [t.person_id, t])) })
    const done = runs.filter((r) => r.status === 'completed')
    if (done.length) await get().openRun(done[done.length - 1].run_id)
    else if (!runs.length) {
      const valid = plans.filter((p) => p.validation?.valid)
      const initial = valid.find((p) => p.plan.family === 'none') ?? valid[0]
      if (initial) await get().submitRun(initial.plan.plan_id)
    }
  },

  async createFlagship(cohort, seed) {
    try {
      const s = await api.createFlagship({ pack_id: get().pack?.pack_id ?? 'toronto', seed, cohort_size: cohort, horizon_s: 2700 })
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
    if (get().scenarioId !== sid) return
    set({ runs })
    if (get().primaryRunId || get().loadingReplay) return
    const done = runs.filter((r) => r.status === 'completed' && r.scenario_id === sid)
    if (done.length) await get().openRun(done[done.length - 1].run_id)
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

  async openRun(rid) {
    const { replays, runs, scenarioId, primaryRunId, loadingReplay } = get()
    if (rid === primaryRunId || rid === loadingReplay) return
    clock.pause()
    set({ loadingReplay: rid })
    try {
      let rx = replays[rid]
      if (!rx) {
        const run = runs.find((r) => r.run_id === rid) ?? (await api.run(rid))
        rx = buildIndex(await api.bundle(run))
        set({ replays: { ...get().replays, [rid]: rx } })
      }
      if (get().scenarioId !== scenarioId || get().loadingReplay !== rid) return
      const scenario = get().scenarios.find((s) => s.scenario_id === scenarioId)
      clock.setHorizon(Math.max(scenario?.constraints.horizon_s ?? 0, rx.tMax))
      clock.seek(rx.activityStart ?? 0)
      set({ primaryRunId: rid, selection: null })
      clock.play()
    } catch (e) {
      if (get().scenarioId === scenarioId && get().loadingReplay === rid) set({ error: String(e) })
    } finally {
      if (get().loadingReplay === rid) set({ loadingReplay: null })
    }
  },

  select: (selection) => set({ selection }),
  setInvestigation: (investigation) => set({ investigation }),
  setError: (error) => set({ error }),
  setTool: (tool) => set({ tool, ghost: tool ? get().ghost : null }),
  setGhost: (ghost) => set({ ghost }),
  setLens: (lens) => set({ lens }),
  setDeveloper: (developer) => set({ developer }),
  setCameraMode: (cameraMode) => set({ cameraMode }),

  /** Confirm a ghost: the backend applies the typed proposal to a NEW scenario id (parent stays immutable). */
  async applyGhost() {
    const { ghost, scenarioId } = get()
    if (!ghost?.proposal || !scenarioId) return
    set({ building: 'Freezing scenario · compiling branch…' })
    try {
      const s = await api.applyEdit(scenarioId, ghost.proposal)
      const scenarios = await api.scenarios()
      set({ scenarios, ghost: null, tool: null, building: `Branch ${s.scenario_id} compiled · loading world…` })
      await get().selectScenario(s.scenario_id)
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ building: null })
    }
  },
}))

clock.onUi((t) => useStore.setState({ t, playing: clock.playing, speed: clock.speed }))
