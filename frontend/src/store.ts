import { create } from 'zustand'
import { api } from './api'
import { DEFAULT_HORIZON_S, developmentError as validateDevelopment, developmentKind, developmentPreset, latestDevelopment, validDevelopmentGeometry } from './development'
import { buildIndex, type ReplayIndex } from './replay'
import { clock } from './world/playback'
import { cityPose, currentPose, developmentPose, type CameraMode } from './world/camera'
import { cameraTo, leadMap } from './world/registry'
import type {
  BuildingKind,
  CityPack,
  DevelopmentPreview,
  DevelopmentSpec,
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
  | { kind: 'development'; id: string }
  | null

export type ToolId = 'road' | 'intersection' | 'stop' | 'route' | 'population' | 'event' | 'development' | 'closure' | 'weather'

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
  developmentDraft: DevelopmentSpec | null
  developmentPlaced: boolean
  /** Cursor position over the map while a draft is still being aimed; the ghost outline follows it. */
  developmentHover: [number, number] | null
  developmentPreview: DevelopmentPreview | null
  developmentError: string | null
  developmentPreviewing: boolean
  /** True while the base city crowd is being compiled because the tool was opened with no scenario yet. */
  developmentPreparing: boolean
  lens: LensTab | null
  developer: boolean
  cameraMode: CameraMode
  building: string | null // "freeze → build → reload" banner text while a branch is compiled

  boot: (packId?: string) => Promise<void>
  selectPack: (packId: string) => Promise<void>
  selectScenario: (sid: string, options?: { keepDevelopment?: boolean }) => Promise<void>
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
  setDevelopmentDraft: (spec: DevelopmentSpec) => void
  /** Swap the building kind; keeps the placement (and re-checks access) if already placed. */
  chooseDevelopmentKind: (kind: BuildingKind) => void
  setDevelopmentHover: (position: [number, number] | null) => void
  /** Commit the aimed footprint; access is checked immediately so the panel can show Confirm without a separate step. */
  placeDevelopment: (position: [number, number]) => void
  /** Create the default base crowd for the current city when no scenario exists, keeping the open development tool. */
  ensureBaseScenario: () => Promise<string | null>
  previewDevelopment: () => Promise<void>
  applyDevelopment: () => Promise<ScenarioSpec | null>
  setLens: (l: LensTab | null) => void
  setDeveloper: (d: boolean) => void
  setCameraMode: (m: CameraMode) => void
  /** Fly the lead camera to a saved development (default: the newest in the active scenario). Returns false if none. */
  focusDevelopment: (id?: string) => boolean
  /** Set when a development branch loads before any map is registered; the lead renderer consumes it on ready. */
  pendingDevelopmentFocus: string | null
  applyGhost: () => Promise<void>
}

let packSelectionRequest = 0
let scenarioSelectionRequest = 0

const EMPTY_DEVELOPMENT = {
  developmentDraft: null, developmentPlaced: false, developmentHover: null, developmentPreview: null,
  developmentError: null, developmentPreviewing: false,
}

let basePromise: Promise<string | null> | null = null

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
  ...EMPTY_DEVELOPMENT,
  developmentPreparing: false,
  pendingDevelopmentFocus: null,
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
      // Latest scenario of the chosen city, so a freshly confirmed branch (e.g. a development) survives a reload.
      const preferred = requested
        ? scenarios.filter((s) => s.pack_id === requested.pack_id).at(-1)
        : scenarios.filter((s) => s.pack_id === 'toronto').at(-1) ?? scenarios.at(-1)
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
        pendingDevelopmentFocus: null, ...EMPTY_DEVELOPMENT,
      })
      cameraTo(cityPose(pack.pack_id, pack.center), 'city')
      const own = get().scenarios.filter((s) => s.pack_id === packId)
      if (own.length) await get().selectScenario(own[own.length - 1].scenario_id)
    } catch (e) {
      if (request === packSelectionRequest) set({ error: String(e) })
    }
  },

  async selectScenario(sid, options) {
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
    set({ scenarioId: sid, plans: [], runs: [], travelers: {}, primaryRunId: null, loadingReplay: null, selection: null, ghost: null, pendingDevelopmentFocus: null,
      ...(options?.keepDevelopment ? {} : { tool: null, ...EMPTY_DEVELOPMENT }) })
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
    if (request === scenarioSelectionRequest && get().scenarioId === sid && latestDevelopment(sc)) get().focusDevelopment()
  },

  focusDevelopment(id) {
    const { scenarios, scenarioId } = get()
    const scenario = scenarios.find((s) => s.scenario_id === scenarioId)
    const development = id ? scenario?.developments?.find((d) => d.development_id === id) ?? null : latestDevelopment(scenario)
    if (!development || !validDevelopmentGeometry(development.spec)) return false
    set({ selection: { kind: 'development', id: development.development_id }, tool: 'development', ghost: null, ...EMPTY_DEVELOPMENT })
    const lead = leadMap()
    if (!lead) {
      set({ pendingDevelopmentFocus: development.development_id })
      return false
    }
    const { spec } = development
    cameraTo(developmentPose(spec.position, spec.footprint_m, spec.height_m, currentPose(lead)), 'development')
    set({ cameraMode: 'development', pendingDevelopmentFocus: null })
    return true
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

  select: (selection) => set({ selection, ...(selection?.kind === 'development' ? EMPTY_DEVELOPMENT : {}) }),
  setInvestigation: (investigation) => set({ investigation }),
  setError: (error) => set({ error }),
  setTool: (tool) => {
    const { pack, scenarios, scenarioId } = get()
    const scenario = scenarios.find((s) => s.scenario_id === scenarioId)
    set({ tool, ghost: null, ...EMPTY_DEVELOPMENT,
      selection: tool === 'development' ? null : get().selection,
      developmentDraft: tool === 'development' && pack ? developmentPreset(pack, scenario?.constraints.horizon_s ?? DEFAULT_HORIZON_S) : null,
    })
    // No "create a base scenario" step: the first building simply lands on a default crowd compiled in the background.
    if (tool === 'development' && pack && !scenario) void get().ensureBaseScenario()
  },
  setGhost: (ghost) => set({ ghost }),
  setDevelopmentDraft: (developmentDraft) => set({ developmentDraft, developmentPreview: null, developmentError: null, developmentPreviewing: false }),
  chooseDevelopmentKind: (kind) => {
    const { pack, scenarios, scenarioId, developmentDraft, developmentPlaced, tool } = get()
    if (tool !== 'development' || !pack) return
    const scenario = scenarios.find((s) => s.scenario_id === scenarioId)
    const ordinal = (scenario?.developments?.filter((d) => developmentKind(d.spec) === kind).length ?? 0) + 1
    const preset = developmentPreset(pack, scenario?.constraints.horizon_s ?? DEFAULT_HORIZON_S, kind, ordinal)
    set({ developmentDraft: { ...preset, position: developmentDraft?.position ?? preset.position }, developmentPreview: null, developmentError: null, developmentPreviewing: false })
    if (developmentPlaced) void get().previewDevelopment()
  },
  setDevelopmentHover: (developmentHover) => {
    const { developmentDraft, developmentPlaced } = get()
    if (!developmentDraft || developmentPlaced) return
    const before = get().developmentHover
    if (before === developmentHover || (before && developmentHover && before[0] === developmentHover[0] && before[1] === developmentHover[1])) return
    set({ developmentHover })
  },
  placeDevelopment: (position) => {
    const { developmentDraft, tool } = get()
    if (tool !== 'development' || !developmentDraft) return
    set({ developmentDraft: { ...developmentDraft, position }, developmentPlaced: true, developmentHover: null, developmentPreview: null, developmentError: null, developmentPreviewing: false })
    void get().previewDevelopment()
  },
  async ensureBaseScenario() {
    const { scenarioId, pack } = get()
    if (scenarioId) return scenarioId
    if (!pack) return null
    if (!basePromise) {
      basePromise = (async () => {
        set({ developmentPreparing: true })
        try {
          const created = await api.createFlagship({ pack_id: pack.pack_id, seed: 7, cohort_size: 240, horizon_s: DEFAULT_HORIZON_S })
          set({ scenarios: await api.scenarios() })
          if (get().scenarioId) return get().scenarioId
          await get().selectScenario(created.scenario_id, { keepDevelopment: true })
          return created.scenario_id
        } catch (e) {
          set({ developmentError: `Could not prepare the base city: ${String(e)}` })
          return null
        } finally {
          set({ developmentPreparing: false })
          basePromise = null
        }
      })()
    }
    return basePromise
  },
  async previewDevelopment() {
    if (!get().scenarioId) await get().ensureBaseScenario()
    const { scenarioId, developmentDraft, developmentPlaced, scenarios } = get()
    const scenario = scenarios.find((s) => s.scenario_id === scenarioId)
    if (!scenarioId || !scenario || !developmentDraft || !developmentPlaced) return
    const problem = validateDevelopment(developmentDraft, scenario.constraints.horizon_s)
    if (problem) { set({ developmentError: problem }); return }
    set({ developmentPreviewing: true, developmentError: null, developmentPreview: null })
    try {
      const preview = await api.previewDevelopment(scenarioId, developmentDraft)
      if (get().scenarioId === scenarioId && get().developmentDraft === developmentDraft) set({ developmentPreview: preview, developmentDraft: preview.development.spec, developmentPreviewing: false })
    } catch (e) {
      if (get().scenarioId === scenarioId && get().developmentDraft === developmentDraft) set({ developmentError: String(e) })
    } finally {
      if (get().developmentDraft === developmentDraft) set({ developmentPreviewing: false })
    }
  },
  async applyDevelopment() {
    const { scenarioId, developmentPreview, developmentDraft } = get()
    if (!scenarioId || !developmentPreview || !developmentDraft || developmentPreview.base_scenario_id !== scenarioId) return null
    if (JSON.stringify(developmentPreview.development.spec) !== JSON.stringify(developmentDraft)) {
      set({ developmentError: 'Assumptions changed. Preview again before confirming.' })
      return null
    }
    set({ building: 'Adding development · preserving parent trips…', developmentError: null })
    try {
      const child = await api.applyDevelopment(scenarioId, developmentPreview)
      const scenarios = await api.scenarios()
      set({ scenarios })
      if (get().scenarioId === scenarioId) {
        set({ tool: null, ...EMPTY_DEVELOPMENT })
        await get().selectScenario(child.scenario_id)
      }
      return child
    } catch (e) {
      set({ developmentError: String(e), error: String(e) })
      return null
    } finally {
      set({ building: null })
    }
  },
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
