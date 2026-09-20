import type { StateCreator } from 'zustand'
import { api } from './api'
import { enterCity, live } from './live/session'
import { populationDefinitionReason, populationScaleReason, populationUnavailableReason } from './populationControls'
import { usePopulationStimuli } from './populationStimuli'
import { canPausePopulationRun, canResumePopulationRun, needsPopulationReplayRefresh, populationReplayReady, populationRunRevision, runIsActive, type PopulationRunAction } from './populationLifecycle'
import { buildIndex, type ReplayIndex } from './replay'
import type { State } from './store'
import type { PlanWithValidation, PopulationDefinition, PopulationSpec, PopulationStatus, PopulationStimulus, ScenarioSpec, SimulationRun } from './types'
import { clock } from './world/playback'
import { usePopulationPlayback } from './populationLifecycle'

export interface PopulationState {
  populationActive: boolean
  scenarios: ScenarioSpec[]
  scenarioId: string | null
  populationDefinition: PopulationDefinition | null
  populationStatus: PopulationStatus | null
  populationStatusError: string | null
  populationSubmitting: boolean
  populationActions: Record<string, PopulationRunAction | undefined>
  populationReplayDirty: Record<string, boolean>
  plans: PlanWithValidation[]
  runs: SimulationRun[]
  primaryRunId: string | null
  replays: Record<string, ReplayIndex>
  loadingReplay: string | null
  building: string | null
  refreshPopulationStatus: () => Promise<void>
  refreshPopulations: () => Promise<void>
  enterNativePopulation: (packId: string) => Promise<void>
  selectScenario: (id: string) => Promise<void>
  createPopulation: (spec: PopulationSpec) => Promise<void>
  submitPopulationRun: () => Promise<void>
  pausePopulationRun: (id: string) => Promise<void>
  resumePopulationRun: (id: string) => Promise<void>
  invalidatePopulationReplay: (id: string) => void
  loadReplay: (run: SimulationRun, force?: boolean) => Promise<ReplayIndex | null>
  refreshRuns: () => Promise<void>
  cancelRun: (id: string) => Promise<void>
  openRun: (id: string, slot?: 'primary', force?: boolean) => Promise<void>
  submitRun: (planId: string, seed?: number) => Promise<void>
  leavePopulation: () => Promise<void>
}

const pendingRequests = new Map<string, { key: string; stimuli: PopulationStimulus[] }>()
const replayVersions = new Map<string, number>()
const replayLoads = new Map<string, { version: number; revision: string; token: object; promise: Promise<ReplayIndex | null> }>()
let selectionVersion = 0
let refreshVersion = 0
const lastPopulationKey = (packId: string) => `concrete-consequences:native-population:${packId}`

function preferredPopulation(packId: string): string | null {
  try { return localStorage.getItem(lastPopulationKey(packId)) } catch { return null }
}

function rememberPopulation(packId: string, scenarioId: string) {
  try { localStorage.setItem(lastPopulationKey(packId), scenarioId) } catch { /* Storage is optional. */ }
}

export const createPopulationSlice: StateCreator<State, [], [], PopulationState> = (set, get) => ({
  populationActive: false, scenarios: [], scenarioId: null, populationDefinition: null,
  populationStatus: null, populationStatusError: null, populationSubmitting: false,
  populationActions: {}, populationReplayDirty: {}, plans: [], runs: [], primaryRunId: null,
  replays: {}, loadingReplay: null, building: null,

  async refreshPopulationStatus() {
    try { set({ populationStatus: await api.populationStatus(), populationStatusError: null }) }
    catch (error) { set({ populationStatus: null, populationStatusError: String(error) }) }
  },

  async refreshPopulations() {
    try { set({ scenarios: (await api.scenarios()).filter(s => s.scenario_kind === 'population') }) }
    catch (error) { set({ error: String(error) }) }
  },

  async enterNativePopulation(packId) {
    const version = ++selectionVersion
    refreshVersion++
    live.stop()
    clock.setLoop(null)
    clock.setFrontier(0)
    clock.seek(0)
    set({ populationActive: true, tool: 'residents', scenarioId: null, primaryRunId: null, populationDefinition: null, plans: [], runs: [], selection: null, error: null })
    try {
      const [, scenarios] = await Promise.all([get().refreshPopulationStatus(), api.scenarios()])
      if (version !== selectionVersion || get().pack?.pack_id !== packId) return
      set({ scenarios: scenarios.filter(s => s.scenario_kind === 'population') })
      const preferred = preferredPopulation(packId)
      const candidates = scenarios.filter(s => s.scenario_kind === 'population' && s.pack_id === packId && s.population_id)
        .sort((a, b) => Number(b.scenario_id === preferred) - Number(a.scenario_id === preferred) || b.created_at.localeCompare(a.created_at))
      for (const candidate of candidates) {
        let definition: PopulationDefinition
        try { definition = await api.populationDefinition(candidate.population_id!) }
        catch { continue }
        if (version !== selectionVersion || get().pack?.pack_id !== packId) return
        if (definition.population_id !== candidate.population_id || definition.spec.pack_id !== packId || definition.network_fingerprint !== get().pack?.network_fingerprint || !definition.spec.brains.length || definition.spec.brains.some(brain => brain.control_mode !== 'jiuwenswarm')) continue
        await get().selectScenario(candidate.scenario_id)
        return
      }
    } catch (error) {
      if (version === selectionVersion) set({ error: `Native residents could not be loaded: ${String(error)}` })
    }
  },

  async selectScenario(id) {
    const version = ++selectionVersion
    refreshVersion++
    if (live.getSnapshot().busy) { set({ error: 'Wait for the current city operation before opening residents.' }); return }
    live.stop()
    clock.setFrontier(0)
    clock.seek(0)
    set({ scenarioId: id, populationActive: true, primaryRunId: null, selection: null, plans: [], runs: [], populationDefinition: null, error: null })
    try {
      const scenario = get().scenarios.find(s => s.scenario_id === id) ?? await api.scenario(id)
      if (version !== selectionVersion) return
      if (scenario.pack_id !== get().pack?.pack_id) throw new Error('Open this population in its matching city pack.')
      if (scenario.scenario_kind === 'population') {
        if (!scenario.population_id) throw new Error('Population scenario is missing population_id.')
        const [definition, runs] = await Promise.all([api.populationDefinition(scenario.population_id), api.runs(id)])
        if (version !== selectionVersion) return
        if (definition.population_id !== scenario.population_id) throw new Error('Population definition does not match the scenario.')
        set({ populationDefinition: definition, runs })
        if (definition.spec.brains.length && definition.spec.brains.every(brain => brain.control_mode === 'jiuwenswarm')) rememberPopulation(scenario.pack_id, id)
      } else {
        const [plans, runs] = await Promise.all([api.plans(id), api.runs(id), api.demand(id)])
        if (version !== selectionVersion) return
        set({ plans, runs })
      }
      const saved = get().runs.filter(r => populationReplayReady(r) || r.status === 'completed')
      const running = get().runs.find(runIsActive)
      if (running) {
        set({ primaryRunId: running.run_id })
        usePopulationPlayback.getState().setFollowLive(true)
        await get().openRun(running.run_id)
      } else if (saved.length) await get().openRun(saved[saved.length - 1].run_id)
    } catch (error) {
      if (version === selectionVersion) set({ error: String(error) })
    }
  },

  async leavePopulation() {
    selectionVersion++
    refreshVersion++
    clock.pause()
    set({ populationActive: false, selection: null, error: null })
    const pack = get().pack
    if (pack) await enterCity(pack.pack_id)
  },

  async createPopulation(spec) {
    if (get().building) return
    const unavailable = populationDefinitionReason(get().populationStatus, get().populationStatusError)
    if (unavailable) { set({ error: unavailable }); return }
    if (spec.brains.some(b => b.control_mode !== 'jiuwenswarm')) { set({ error: 'Rules fixtures cannot be submitted as native population scenarios.' }); return }
    set({ building: `Defining ${spec.count} residents without inference`, error: null })
    try {
      const scenario = await api.createPopulation(spec)
      if (scenario.scenario_kind !== 'population' || !scenario.population_id) throw new Error('Population API returned an invalid scenario envelope.')
      await get().refreshPopulations()
      if (!get().scenarios.some(s => s.scenario_id === scenario.scenario_id)) set({ scenarios: [...get().scenarios, scenario] })
      await get().selectScenario(scenario.scenario_id)
    } catch (error) { set({ error: String(error) }) }
    finally { set({ building: null }) }
  },

  async submitPopulationRun() {
    const { populationDefinition: definition, populationSubmitting, scenarioId } = get()
    if (!definition || populationSubmitting) return
    if (definition.spec.brains.some(b => b.control_mode !== 'jiuwenswarm')) { set({ error: 'This is a rules fixture. Native execution cannot be substituted; replay remains available.' }); return }
    if (get().runs.some(runIsActive)) return
    set({ populationSubmitting: true, error: null })
    try {
      await get().refreshPopulationStatus()
      const reason = populationUnavailableReason(get().populationStatus, get().populationStatusError) ?? populationScaleReason(get().populationStatus, definition.spec.count)
      if (reason) throw new Error(reason)
      usePopulationStimuli.getState().reset(definition.population_id)
      const request = pendingRequests.get(definition.population_id) ?? { key: `population-${crypto.randomUUID()}`, stimuli: [...usePopulationStimuli.getState().pending] }
      pendingRequests.set(definition.population_id, request)
      const run = await api.submitPopulationRun(definition.population_id, request.key, request.stimuli)
      if (run.run_kind !== 'population' || run.population_id !== definition.population_id) throw new Error('Population API returned a run for a different population.')
      pendingRequests.delete(definition.population_id)
      if (usePopulationStimuli.getState().populationId === definition.population_id) {
        const sentIds = new Set(request.stimuli.map(stimulus => stimulus.stimulus_id))
        const remaining = usePopulationStimuli.getState().pending.filter(stimulus => !sentIds.has(stimulus.stimulus_id))
        if (!remaining.length) usePopulationStimuli.getState().clearPending()
        else usePopulationStimuli.setState({ pending: remaining })
      }
      if (get().scenarioId === scenarioId) {
        clock.pause()
        clock.seek(0)
        usePopulationPlayback.getState().setFollowLive(true)
        set({ runs: [...get().runs.filter(r => r.run_id !== run.run_id), run], primaryRunId: run.run_id, selection: null })
        await get().refreshRuns()
      }
    } catch (error) { set({ error: String(error) }) }
    finally { set({ populationSubmitting: false }) }
  },

  async pausePopulationRun(id) {
    const action = get().populationActions[id]
    if (action && action.phase !== 'error') return
    refreshVersion++
    set({ populationActions: { ...get().populationActions, [id]: { action: 'pause', phase: 'submitting' } }, error: null })
    try {
      const run = get().runs.find(r => r.run_id === id) ?? await api.run(id)
      if (!canPausePopulationRun(run)) throw new Error('Only queued or running population executions can pause.')
      const response = await api.pausePopulationRun(id)
      if (response.requested !== true || response.run_id !== id) throw new Error('Pause acknowledgement did not match the requested run.')
      refreshVersion++
      set({ populationActions: { ...get().populationActions, [id]: { action: 'pause', phase: 'requested' } } })
      await get().refreshRuns()
    } catch (error) {
      const message = `Execution pause not confirmed: ${String(error)}`
      set({ error: message, populationActions: { ...get().populationActions, [id]: { action: 'pause', phase: 'error', message } } })
    }
  },

  async resumePopulationRun(id) {
    const action = get().populationActions[id]
    if (action && action.phase !== 'error') return
    refreshVersion++
    replayVersions.set(id, (replayVersions.get(id) ?? 0) + 1)
    set({ populationActions: { ...get().populationActions, [id]: { action: 'resume', phase: 'submitting' } }, error: null })
    let dispatched = false
    try {
      const run = get().runs.find(r => r.run_id === id) ?? await api.run(id)
      if (!canResumePopulationRun(run)) throw new Error('Only paused or interrupted failed population runs can resume. Stop/cancel is not pause.')
      let definition = get().populationDefinition?.population_id === run.population_id ? get().populationDefinition : get().replays[id]?.population?.definition
      if (!definition && run.population_id) definition = await api.populationDefinition(run.population_id)
      if (!definition || definition.population_id !== run.population_id) throw new Error('The matching frozen population is required before resume.')
      if (definition.spec.brains.some(b => b.control_mode === 'jiuwenswarm')) {
        await get().refreshPopulationStatus()
        const reason = populationUnavailableReason(get().populationStatus, get().populationStatusError) ?? populationScaleReason(get().populationStatus, definition.spec.count)
        if (reason) throw new Error(reason)
      }
      dispatched = true
      const resumed = await api.resumePopulationRun(id)
      if (resumed.run_id !== id || resumed.scenario_id !== run.scenario_id || resumed.run_kind !== 'population' || resumed.population_id !== run.population_id || !runIsActive(resumed)) throw new Error('Resume must return the same population simulation identity in queued/running status.')
      refreshVersion++
      get().invalidatePopulationReplay(id)
      set({ populationActions: { ...get().populationActions, [id]: { action: 'resume', phase: 'requested' } } })
      if (get().scenarioId === run.scenario_id) {
        set({ runs: get().runs.map(r => r.run_id === id ? resumed : r) })
        await get().refreshRuns()
      }
    } catch (error) {
      const message = `Resume not confirmed; no new simulation identity was requested. Check run status before retrying: ${String(error)}`
      set({ error: message, populationActions: { ...get().populationActions, [id]: { action: 'resume', phase: 'error', message } } })
      if (dispatched) await get().refreshRuns()
    }
  },

  invalidatePopulationReplay(id) {
    replayVersions.set(id, (replayVersions.get(id) ?? 0) + 1)
    if (get().primaryRunId === id) clock.pause()
    set({ replays: Object.fromEntries(Object.entries(get().replays).filter(([key]) => key !== id)),
      populationReplayDirty: { ...get().populationReplayDirty, [id]: true },
      loadingReplay: get().loadingReplay === id ? null : get().loadingReplay })
  },

  async loadReplay(run, force = false) {
    const id = run.run_id, cached = get().replays[id]
    const streaming = run.run_kind === 'population' && runIsActive(run)
    if (cached && !streaming && !force && !needsPopulationReplayRefresh(cached.bundle.run, run, Boolean(get().populationReplayDirty[id]))) return cached
    const version = replayVersions.get(id) ?? 0, revision = populationRunRevision(run)
    const pending = replayLoads.get(id)
    if (pending?.version === version && pending.revision === revision) return pending.promise
    const token = {}, currentSelection = selectionVersion
    set({ loadingReplay: id })
    const promise = (streaming ? api.populationSnapshot(run) : api.bundle(run)).then(bundle => {
      if (!bundle) return cached ?? null
      const current = get().runs.find(r => r.run_id === id)
      if ((replayVersions.get(id) ?? 0) !== version || currentSelection !== selectionVersion || (run.run_kind === 'population' && current && !streaming && populationRunRevision(current) !== revision)) return null
      const rx = buildIndex(bundle)
      set({ replays: { ...get().replays, [id]: rx }, populationReplayDirty: { ...get().populationReplayDirty, [id]: false } })
      if (get().primaryRunId === id && get().populationActive) {
        clock.setHorizon(rx.tMax); clock.setFrontier(rx.tMax)
        if (streaming && usePopulationPlayback.getState().followLive) { clock.pause(); clock.seek(rx.tMax) }
      }
      return rx
    }).catch(error => {
      if (currentSelection === selectionVersion && (replayVersions.get(id) ?? 0) === version) set({ error: `Recorded replay could not be refreshed: ${String(error)}` })
      return null
    }).finally(() => {
      if (replayLoads.get(id)?.token === token) { replayLoads.delete(id); if (get().loadingReplay === id) set({ loadingReplay: null }) }
    })
    replayLoads.set(id, { version, revision, token, promise })
    return promise
  },

  async refreshRuns() {
    const id = get().scenarioId
    if (!id) return
    const version = ++refreshVersion, previous = new Map(get().runs.map(r => [r.run_id, r]))
    try {
      const runs = await api.runs(id)
      if (get().scenarioId !== id || version !== refreshVersion) return
      const actions = { ...get().populationActions }
      for (const run of runs) {
        const action = actions[run.run_id]
        if (action?.phase === 'requested' && (action.action === 'resume' ? run.status !== 'queued' : !runIsActive(run))) delete actions[run.run_id]
      }
      set({ runs, populationActions: actions })
      for (const run of runs) {
        const cached = get().replays[run.run_id]
        if (run.run_kind === 'population' && runIsActive(run) && cached && !runIsActive(cached.bundle.run)) get().invalidatePopulationReplay(run.run_id)
      }
      await Promise.all(runs.filter(run => {
        if (run.run_kind === 'population' && runIsActive(run) && get().primaryRunId === run.run_id) return true
        const cached = get().replays[run.run_id], dirty = Boolean(get().populationReplayDirty[run.run_id]), before = previous.get(run.run_id)
        return (cached || dirty || get().primaryRunId === run.run_id || (before && runIsActive(before))) && needsPopulationReplayRefresh(cached?.bundle.run, run, dirty)
      }).map(run => get().loadReplay(run)))
    } catch (error) { if (get().scenarioId === id && version === refreshVersion) set({ error: String(error) }) }
  },

  async cancelRun(id) {
    if (get().populationActions[id]?.phase === 'submitting') return
    refreshVersion++
    set({ populationActions: { ...get().populationActions, [id]: { action: 'stop', phase: 'submitting' } } })
    try {
      if (!(await api.cancelRun(id)).canceled) throw new Error('The backend did not confirm a stop request.')
      refreshVersion++
      set({ populationActions: { ...get().populationActions, [id]: { action: 'stop', phase: 'requested' } } })
      await get().refreshRuns()
    } catch (error) {
      const message = String(error)
      set({ error: message, populationActions: { ...get().populationActions, [id]: { action: 'stop', phase: 'error', message } } })
    }
  },

  async openRun(id, _slot = 'primary', force = false) {
    const version = selectionVersion, recordsVersion = refreshVersion, replayVersion = replayVersions.get(id) ?? 0
    try {
      const run = force ? await api.run(id) : get().runs.find(r => r.run_id === id) ?? await api.run(id)
      if (version !== selectionVersion || replayVersion !== (replayVersions.get(id) ?? 0) || (force && run.run_kind === 'population' && recordsVersion !== refreshVersion)) return
      if (force && get().scenarioId === run.scenario_id) set({ runs: get().runs.map(r => r.run_id === id ? run : r) })
      const cached = get().replays[id]
      if (run.run_kind === 'population' && runIsActive(run) && cached && !runIsActive(cached.bundle.run)) get().invalidatePopulationReplay(id)
      const rx = await get().loadReplay(run, force)
      if (!rx || version !== selectionVersion || get().replays[id] !== rx) return
      clock.setHorizon(rx.tMax)
      clock.setFrontier(rx.tMax)
      const selection = get().selection
      const same = selection?.kind === 'resident' && rx.population?.profiles[selection.id] && get().populationDefinition?.population_id === run.population_id
      set({ primaryRunId: id, selection: get().primaryRunId === id || same ? selection : null })
    } catch (error) { if (version === selectionVersion) set({ error: String(error) }) }
  },

  async submitRun() {
    set({ error: 'Population scenarios use explicit JiuwenSwarm population execution, not transit compilation.' })
  },
})
