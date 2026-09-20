import { create } from 'zustand'
import { api } from './api'
import { buildIndex, type ReplayIndex } from './replay'
import { populationScaleReason, populationUnavailableReason } from './populationControls'
import { selectionForEntity } from './selection'
import { canPausePopulationRun, canResumePopulationRun, needsPopulationReplayRefresh, populationReplayReady, populationRunRevision, runIsActive, type PopulationRunAction } from './populationLifecycle'
import { clock } from './world/playback'
import { cityPose, type CameraMode } from './world/camera'
import { cameraTo } from './world/registry'
import type {
  CityPack,
  EntityTrack,
  HazardTrack,
  Health,
  InterventionProposal,
  Investigation,
  PlanWithValidation,
  PopulationDefinition,
  PopulationSpec,
  PopulationStatus,
  ScenarioSpec,
  SimulationRun,
  StopCandidate,
  Traveler,
} from './types'

export type Selection =
  | { kind: EntityTrack['kind']; id: string }
  | { kind: 'resident'; id: string }
  | { kind: 'stop'; id: string }
  | { kind: 'restriction'; id: string }
  | null

export type ToolId = 'road' | 'intersection' | 'stop' | 'route' | 'population' | 'event' | 'closure' | 'weather' | 'custom'

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
  populationDefinition: PopulationDefinition | null
  populationStatus: PopulationStatus | null
  populationStatusError: string | null
  populationSubmitting: boolean
  populationActions: Record<string, PopulationRunAction | undefined>
  populationReplayDirty: Record<string, boolean>
  plans: PlanWithValidation[]
  runs: SimulationRun[]
  primaryRunId: string | null
  compareRunId: string | null
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
  compareMode: boolean
  cameraMode: CameraMode
  building: string | null // "freeze → build → reload" banner text while a branch is compiled

  boot: () => Promise<void>
  selectPack: (packId: string) => Promise<void>
  selectScenario: (sid: string) => Promise<void>
  createFlagship: (cohort: number, seed: number) => Promise<void>
  refreshPopulationStatus: () => Promise<void>
  createPopulation: (spec: PopulationSpec) => Promise<void>
  submitPopulationRun: () => Promise<void>
  pausePopulationRun: (rid: string) => Promise<void>
  resumePopulationRun: (rid: string) => Promise<void>
  invalidatePopulationReplay: (rid: string) => void
  loadReplay: (run: SimulationRun, force?: boolean) => Promise<ReplayIndex | null>
  refreshRuns: () => Promise<void>
  submitRun: (planId: string, seed?: number) => Promise<void>
  cancelRun: (rid: string) => Promise<void>
  openRun: (rid: string, slot: 'primary' | 'compare', force?: boolean) => Promise<void>
  select: (s: Selection) => void
  setInvestigation: (i: Investigation | null) => void
  setError: (e: string | null) => void
  setTool: (t: ToolId | null) => void
  setGhost: (g: Ghost | null) => void
  setLens: (l: LensTab | null) => void
  setDeveloper: (d: boolean) => void
  setCompareMode: (c: boolean) => void
  setCameraMode: (m: CameraMode) => void
  applyGhost: () => Promise<void>
}

const pendingPopulationRequests = new Map<string, string>()
const replayVersions = new Map<string, number>()
const replayLoads = new Map<string, { version: number; revision: string; token: object; promise: Promise<ReplayIndex | null> }>()
let scenarioLoadVersion = 0
let runsRefreshVersion = 0

export const useStore = create<State>((set, get) => ({
  health: null,
  packs: [],
  pack: null,
  roads: null,
  scenarios: [],
  scenarioId: null,
  travelers: {},
  populationDefinition: null,
  populationStatus: null,
  populationStatusError: null,
  populationSubmitting: false,
  populationActions: {},
  populationReplayDirty: {},
  plans: [],
  runs: [],
  primaryRunId: null,
  compareRunId: null,
  replays: {},
  loadingReplay: null,
  t: 0,
  playing: false,
  speed: clock.speed,
  selection: null,
  investigation: null,
  error: null,
  tool: null,
  ghost: null,
  lens: null,
  developer: false,
  compareMode: false,
  cameraMode: 'city',
  building: null,

  async boot() {
    void get().refreshPopulationStatus()
    try {
      const [health, scenarios, packs] = await Promise.all([api.health(), api.scenarios(), api.packs()])
      set({ health, scenarios, packs })
      const preferred = scenarios.find((s) => s.pack_id === 'toronto') ?? scenarios[scenarios.length - 1]
      const packId = preferred?.pack_id ?? packs.find((p) => p.pack_id === 'toronto')?.pack_id ?? packs[0]?.pack_id ?? 'toronto'
      const [pack, roads] = await Promise.all([api.pack(packId), api.roads(packId)])
      set({ pack, roads })
      if (preferred) await get().selectScenario(preferred.scenario_id)
    } catch (e) {
      set({ error: String(e) })
    }
  },

  async selectPack(packId) {
    if (packId === get().pack?.pack_id) return
    try {
      const [pack, roads] = await Promise.all([api.pack(packId), api.roads(packId)])
      set({ pack, roads })
      cameraTo(cityPose(pack.pack_id, pack.center), 'city')
      const own = get().scenarios.filter((s) => s.pack_id === packId)
      if (own.length) await get().selectScenario(own[own.length - 1].scenario_id)
      else {
        clock.pause()
        scenarioLoadVersion++
        set({ scenarioId: null, plans: [], runs: [], primaryRunId: null, compareRunId: null, selection: null, ghost: null, travelers: {}, populationDefinition: null, investigation: null })
      }
    } catch (e) {
      set({ error: String(e) })
    }
  },

  async selectScenario(sid) {
    const version = ++scenarioLoadVersion
    runsRefreshVersion++
    clock.pause()
    clock.seek(0)
    set({ scenarioId: sid, primaryRunId: null, compareRunId: null, selection: null, ghost: null, plans: [], runs: [], travelers: {}, populationDefinition: null, investigation: null, compareMode: false })
    try {
      const sc = get().scenarios.find((s) => s.scenario_id === sid) ?? await api.scenario(sid)
      if (version !== scenarioLoadVersion) return
      if (sc.pack_id !== get().pack?.pack_id) {
        const [pack, roads] = await Promise.all([api.pack(sc.pack_id), api.roads(sc.pack_id)])
        if (version !== scenarioLoadVersion) return
        set({ pack, roads })
        cameraTo(cityPose(pack.pack_id, pack.center), 'city')
      }
      clock.setHorizon(sc.constraints.horizon_s)
      if (sc.scenario_kind === 'population') {
        if (!sc.population_id) throw new Error('Population scenario is missing population_id.')
        const [populationDefinition, runs] = await Promise.all([api.populationDefinition(sc.population_id), api.runs(sid)])
        if (version !== scenarioLoadVersion) return
        if (populationDefinition.population_id !== sc.population_id) throw new Error('Population definition does not match the scenario.')
        set({ populationDefinition, runs, lens: 'people', tool: get().tool === 'population' ? 'population' : null })
      } else {
        const [plans, runs, demand] = await Promise.all([api.plans(sid), api.runs(sid), api.demand(sid).catch(() => null)])
        if (version !== scenarioLoadVersion) return
        set({ plans, runs, travelers: Object.fromEntries((demand?.travelers ?? []).map((traveler) => [traveler.person_id, traveler])) })
      }
      const done = get().runs.filter((r) => r.status === 'completed' || (r.run_kind === 'population' && r.status === 'paused'))
      if (done.length) await get().openRun(done[done.length - 1].run_id, 'primary')
    } catch (e) {
      if (version === scenarioLoadVersion) set({ error: String(e) })
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

  async refreshPopulationStatus() {
    try {
      const populationStatus = await api.populationStatus()
      set({ populationStatus, populationStatusError: null })
    } catch (e) {
      set({ populationStatus: null, populationStatusError: String(e) })
    }
  },

  async createPopulation(spec) {
    if (get().building) return
    const unavailable = populationUnavailableReason(get().populationStatus, get().populationStatusError)
    if (unavailable) return set({ error: unavailable })
    if (spec.brains.some((brain) => brain.control_mode !== 'jiuwenswarm')) return set({ error: 'Rules fixtures cannot be submitted as native population scenarios.' })
    clock.pause()
    set({ building: `Defining ${spec.count} synthetic residents · no inference during generation…`, error: null })
    try {
      const scenario = await api.createPopulation(spec)
      if (scenario.scenario_kind !== 'population' || !scenario.population_id) throw new Error('Population API returned an invalid scenario envelope.')
      const scenarios = await api.scenarios()
      set({ scenarios: scenarios.some((s) => s.scenario_id === scenario.scenario_id) ? scenarios : [...scenarios, scenario] })
      await get().selectScenario(scenario.scenario_id)
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ building: null })
    }
  },

  async submitPopulationRun() {
    const { populationDefinition: definition, populationSubmitting, scenarioId } = get()
    if (!definition || populationSubmitting) return
    if (definition.spec.brains.some((brain) => brain.control_mode !== 'jiuwenswarm')) return set({ error: 'This is a rules fixture. Native execution cannot be substituted; replay remains available.' })
    if (get().runs.some((r) => r.status === 'queued' || r.status === 'running')) return
    set({ populationSubmitting: true, error: null })
    try {
      await get().refreshPopulationStatus()
      const unavailable = populationUnavailableReason(get().populationStatus, get().populationStatusError) ?? populationScaleReason(get().populationStatus, definition.spec.count)
      if (unavailable) throw new Error(unavailable)
      const key = pendingPopulationRequests.get(definition.population_id) ?? `population-${crypto.randomUUID()}`
      pendingPopulationRequests.set(definition.population_id, key)
      const run = await api.submitPopulationRun(definition.population_id, key)
      if (run.run_kind !== 'population' || run.population_id !== definition.population_id) throw new Error('Population API returned a run for a different population.')
      pendingPopulationRequests.delete(definition.population_id)
      if (get().scenarioId === scenarioId) {
        clock.pause()
        clock.seek(0)
        set({ runs: [...get().runs.filter((r) => r.run_id !== run.run_id), run], primaryRunId: null, compareRunId: null, selection: null })
        await get().refreshRuns()
      }
    } catch (e) {
      set({ error: String(e) })
    } finally {
      set({ populationSubmitting: false })
    }
  },

  async pausePopulationRun(rid) {
    const pending = get().populationActions[rid]
    if (pending && pending.phase !== 'error') return
    runsRefreshVersion++
    set({ populationActions: { ...get().populationActions, [rid]: { action: 'pause', phase: 'submitting' } }, error: null })
    try {
      const run = get().runs.find((r) => r.run_id === rid) ?? await api.run(rid)
      if (!canPausePopulationRun(run)) throw new Error('Only a queued or running population execution can request a pause.')
      const response = await api.pausePopulationRun(rid)
      if (response.requested !== true || response.run_id !== rid) throw new Error('Pause acknowledgement did not match the requested run.')
      runsRefreshVersion++
      set({ populationActions: { ...get().populationActions, [rid]: { action: 'pause', phase: 'requested' } } })
      await get().refreshRuns()
    } catch (e) {
      const message = `Execution pause not confirmed: ${String(e)}`
      set({ error: message, populationActions: { ...get().populationActions, [rid]: { action: 'pause', phase: 'error', message } } })
    }
  },

  async resumePopulationRun(rid) {
    const pending = get().populationActions[rid]
    if (pending && pending.phase !== 'error') return
    runsRefreshVersion++
    replayVersions.set(rid, (replayVersions.get(rid) ?? 0) + 1)
    set({ populationActions: { ...get().populationActions, [rid]: { action: 'resume', phase: 'submitting' } }, error: null })
    let dispatched = false
    try {
      const run = get().runs.find((r) => r.run_id === rid) ?? await api.run(rid)
      if (!canResumePopulationRun(run)) throw new Error('Only paused or interrupted failed population runs may request checkpoint validation and resume. Stop/cancel is not pause.')
      let definition = get().populationDefinition?.population_id === run.population_id ? get().populationDefinition : get().replays[rid]?.population?.definition
      if (!definition && run.population_id) definition = await api.populationDefinition(run.population_id)
      if (!definition || definition.population_id !== run.population_id) throw new Error('The matching frozen population definition is required before resume.')
      if (definition.spec.brains.some((brain) => brain.control_mode === 'jiuwenswarm')) {
        await get().refreshPopulationStatus()
        const reason = populationUnavailableReason(get().populationStatus, get().populationStatusError) ?? populationScaleReason(get().populationStatus, definition.spec.count)
        if (reason) throw new Error(reason)
      }
      dispatched = true
      const resumed = await api.resumePopulationRun(rid)
      if (resumed.run_id !== rid || resumed.scenario_id !== run.scenario_id || resumed.run_kind !== 'population' || resumed.population_id !== run.population_id || !runIsActive(resumed)) throw new Error('Resume must return the same population simulation identity in queued/running status.')
      runsRefreshVersion++
      get().invalidatePopulationReplay(rid)
      set({ populationActions: { ...get().populationActions, [rid]: { action: 'resume', phase: 'requested' } } })
      if (get().scenarioId === run.scenario_id) {
        set({ runs: get().runs.map((r) => r.run_id === rid ? resumed : r) })
        await get().refreshRuns()
      }
    } catch (e) {
      const message = `Resume not confirmed; no new simulation identity was requested. Check run status before retrying: ${String(e)}`
      set({ error: message, populationActions: { ...get().populationActions, [rid]: { action: 'resume', phase: 'error', message } } })
      if (dispatched) await get().refreshRuns()
    }
  },

  invalidatePopulationReplay(rid) {
    replayVersions.set(rid, (replayVersions.get(rid) ?? 0) + 1)
    if (get().primaryRunId === rid) clock.pause()
    set({
      replays: Object.fromEntries(Object.entries(get().replays).filter(([id]) => id !== rid)),
      populationReplayDirty: { ...get().populationReplayDirty, [rid]: true },
      loadingReplay: get().loadingReplay === rid ? null : get().loadingReplay,
    })
  },

  async loadReplay(run, force = false) {
    const rid = run.run_id
    const cached = get().replays[rid]
    const population = run.run_kind === 'population'
    if (population && !populationReplayReady(run)) return cached ?? null
    if (cached && !force && !needsPopulationReplayRefresh(cached.bundle.run, run, Boolean(get().populationReplayDirty[rid]))) return cached
    const version = replayVersions.get(rid) ?? 0
    const revision = populationRunRevision(run)
    const pending = replayLoads.get(rid)
    if (pending?.version === version && pending.revision === revision) return pending.promise
    const token = {}
    const scenarioVersion = scenarioLoadVersion
    set({ loadingReplay: rid })
    const promise = api.bundle(run).then((bundle) => {
      const current = get().runs.find((r) => r.run_id === rid)
      if ((replayVersions.get(rid) ?? 0) !== version || (population && current && populationRunRevision(current) !== revision)) return null
      const rx = buildIndex(bundle)
      set({ replays: { ...get().replays, [rid]: rx }, populationReplayDirty: { ...get().populationReplayDirty, [rid]: false } })
      if (get().primaryRunId === rid && population) clock.setHorizon(rx.tMax)
      return rx
    }).catch((e) => {
      if (scenarioVersion === scenarioLoadVersion && (replayVersions.get(rid) ?? 0) === version) set({ error: `Recorded replay could not be refreshed: ${String(e)}` })
      return null
    }).finally(() => {
      if (replayLoads.get(rid)?.token === token) {
        replayLoads.delete(rid)
        if (get().loadingReplay === rid) set({ loadingReplay: null })
      }
    })
    replayLoads.set(rid, { version, revision, token, promise })
    return promise
  },

  async refreshRuns() {
    const sid = get().scenarioId
    if (!sid) return
    const version = ++runsRefreshVersion
    const previous = new Map(get().runs.map((run) => [run.run_id, run]))
    try {
      const runs = await api.runs(sid)
      if (get().scenarioId !== sid || version !== runsRefreshVersion) return
      const populationActions = { ...get().populationActions }
      for (const run of runs) {
        const action = populationActions[run.run_id]
        if (action?.phase === 'requested' && (action.action === 'resume' ? run.status !== 'queued' : !runIsActive(run))) delete populationActions[run.run_id]
      }
      set({ runs, populationActions })
      for (const run of runs) {
        const cached = get().replays[run.run_id]
        if (run.run_kind === 'population' && runIsActive(run) && cached && !runIsActive(cached.bundle.run)) get().invalidatePopulationReplay(run.run_id)
      }
      const changed = runs.filter((run) => {
        const cached = get().replays[run.run_id]
        const dirty = Boolean(get().populationReplayDirty[run.run_id])
        const before = previous.get(run.run_id)
        const interested = cached || dirty || get().primaryRunId === run.run_id || get().compareRunId === run.run_id || (before && runIsActive(before))
        return interested && needsPopulationReplayRefresh(cached?.bundle.run, run, dirty)
      })
      await Promise.all(changed.map((run) => get().loadReplay(run)))
    } catch (e) {
      if (get().scenarioId === sid && version === runsRefreshVersion) set({ error: String(e) })
    }
  },

  async submitRun(planId, seed = 1) {
    const sid = get().scenarioId
    if (!sid) return
    if (get().scenarios.find((s) => s.scenario_id === sid)?.scenario_kind === 'population') return set({ error: 'Population scenarios use explicit JiuwenSwarm population execution, not transit compilation.' })
    try {
      await api.submitRun(sid, planId, seed)
      await get().refreshRuns()
    } catch (e) {
      set({ error: String(e) })
    }
  },

  async cancelRun(rid) {
    const population = get().runs.find((r) => r.run_id === rid)?.run_kind === 'population'
    if (population && get().populationActions[rid]?.phase === 'submitting') return
    if (population) {
      runsRefreshVersion++
      set({ populationActions: { ...get().populationActions, [rid]: { action: 'stop', phase: 'submitting' } } })
    }
    try {
      const response = await api.cancelRun(rid)
      if (population) {
        if (!response.canceled) throw new Error('The backend did not confirm a stop request.')
        runsRefreshVersion++
        set({ populationActions: { ...get().populationActions, [rid]: { action: 'stop', phase: 'requested' } } })
      }
      await get().refreshRuns()
    } catch (e) {
      const message = String(e)
      set({ error: message, ...(population ? { populationActions: { ...get().populationActions, [rid]: { action: 'stop' as const, phase: 'error' as const, message } } } : {}) })
    }
  },

  async openRun(rid, slot, force = false) {
    const version = scenarioLoadVersion
    const recordsVersion = runsRefreshVersion
    const replayVersion = replayVersions.get(rid) ?? 0
    try {
      const run = force ? await api.run(rid) : get().runs.find((r) => r.run_id === rid) ?? await api.run(rid)
      if (version !== scenarioLoadVersion || replayVersion !== (replayVersions.get(rid) ?? 0) || (force && run.run_kind === 'population' && recordsVersion !== runsRefreshVersion)) return
      if (force && get().scenarioId === run.scenario_id) set({ runs: get().runs.map((r) => r.run_id === rid ? run : r) })
      const cached = get().replays[rid]
      if (run.run_kind === 'population' && runIsActive(run) && cached && !runIsActive(cached.bundle.run)) get().invalidatePopulationReplay(rid)
      const rx = await get().loadReplay(run, force)
      if (!rx || version !== scenarioLoadVersion || get().replays[rid] !== rx) return
      clock.setHorizon(slot === 'primary' && rx.population ? rx.tMax : Math.max(clock.horizon, rx.tMax))
      if (slot === 'primary') {
        const { primaryRunId, selection, populationDefinition, replays } = get()
        const previousPopulation = primaryRunId ? replays[primaryRunId]?.bundle.run.population_id : populationDefinition?.population_id
        const sameResident = selection?.kind === 'resident' && rx.population?.profiles[selection.id] && previousPopulation === run.population_id
        set({ primaryRunId: rid, selection: primaryRunId === rid || sameResident ? selection : null })
      } else set({ compareRunId: rid === get().compareRunId ? null : rid })
    } catch (e) {
      if (version === scenarioLoadVersion) set({ error: String(e) })
    }
  },

  select: (selection) => {
    const s = get()
    const rx = s.primaryRunId ? s.replays[s.primaryRunId] : null
    if (rx && selection && selection.kind !== 'resident' && selection.kind !== 'stop' && selection.kind !== 'restriction') selection = selectionForEntity(rx, selection.id, selection.kind, clock.t)
    set({ selection })
  },
  setInvestigation: (investigation) => set({ investigation }),
  setError: (error) => set({ error }),
  setTool: (tool) => {
    const population = get().scenarios.find((sc) => sc.scenario_id === get().scenarioId)?.scenario_kind === 'population'
    if (population && tool && tool !== 'population') return
    set({ tool, ghost: tool ? get().ghost : null })
  },
  setGhost: (ghost) => set({ ghost }),
  setLens: (lens) => set({ lens }),
  setDeveloper: (developer) => set({ developer }),
  setCompareMode: (compareMode) => set({ compareMode }),
  setCameraMode: (cameraMode) => set({ cameraMode }),

  /** Confirm a ghost: the backend applies the typed proposal to a NEW scenario id (parent stays immutable). */
  async applyGhost() {
    const { ghost, scenarioId } = get()
    if (!ghost?.proposal || !scenarioId) return
    if (get().scenarios.find((sc) => sc.scenario_id === scenarioId)?.scenario_kind === 'population') return set({ error: 'Transport interventions are not supported for population scenarios.' })
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
