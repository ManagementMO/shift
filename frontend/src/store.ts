import { create } from 'zustand'
import { api } from './api'
import { buildIndex, type ReplayIndex } from './replay'
import { clock } from './world/playback'
import { cityPose, type CameraMode } from './world/camera'
import { cameraTo } from './world/registry'
import type {
  CityPack,
  HazardDraft,
  HazardKind,
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
  /** replace_hazard: existing event hidden while its replacement is previewed. */
  replaces?: string | null
}

export type HazardSketch = {
  draft: HazardDraft
  /** point: one centre buffered by radius (all weather types); corridor: a polyline buffered by radius. */
  shape: 'point' | 'corridor'
  placing: boolean
  /** Track id of an existing weather event being moved/resized; confirm replaces it in one edit. */
  replaces: string | null
}

export const HAZARD_KIND_LABEL: Record<HazardKind, string> = { rain: 'Rain', fire: 'Fire (legacy)', storm: 'Storm', flood: 'Flood (legacy)' }
/** Every weather event lasts this long (simulated seconds) from the moment it is placed, then clears automatically. */
export const WEATHER_DURATION_S = 600

/** Window for a new event placed at sim time `now`: `WEATHER_DURATION_S` long, kept inside the horizon. */
export function weatherWindow(now: number, horizon: number): { start_s: number; end_s: number } {
  const end = Math.max(1, Math.floor(horizon))
  const start_s = Math.max(0, Math.min(Math.floor(Number.isFinite(now) ? now : 0), end - 1))
  return { start_s, end_s: Math.min(end, start_s + WEATHER_DURATION_S) }
}

/** Centroid of a lon/lat ring. */
function ringCentroid(points: [number, number][]): [number, number] {
  return [points.reduce((a, p) => a + p[0], 0) / points.length, points.reduce((a, p) => a + p[1], 0) / points.length]
}

export function newHazardSketch(horizon: number, kind: HazardKind = 'storm', now = clock.t): HazardSketch {
  if (kind === 'flood' || kind === 'fire') kind = 'storm'
  return {
    shape: 'point', placing: true, replaces: null,
    draft: {
      waypoints: [], radius_m: 150, ...weatherWindow(now, horizon), modes: ['passenger', 'bus'], kind,
      shape: 'buffer', label: HAZARD_KIND_LABEL[kind],
    },
  }
}

/** Switch a sketch to another weather type without losing its placement or size. */
export function sketchForKind(sketch: HazardSketch, kind: HazardKind): HazardSketch {
  const draft = sketch.draft
  const label = Object.values(HAZARD_KIND_LABEL).includes(draft.label) ? HAZARD_KIND_LABEL[kind] : draft.label
  return { ...sketch, draft: { ...draft, kind, label } }
}

type PlaybackPosition = { t: number; playing: boolean; speed: number }

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
  pendingPlayback: (PlaybackPosition & { scenarioId: string }) | null
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
  hazardSketch: HazardSketch | null
  /** Weather event whose info card is open (from the event list; closed explicitly). */
  hazardInfoId: string | null
  pendingHazardRemoval: { scenarioId: string; trackId: string } | null
  lens: LensTab | null
  developer: boolean
  cameraMode: CameraMode
  building: string | null // "freeze → build → reload" banner text while a branch is compiled

  boot: (packId?: string) => Promise<void>
  selectPack: (packId: string) => Promise<void>
  selectScenario: (sid: string, position?: PlaybackPosition) => Promise<void>
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
  setHazardSketch: (sketch: HazardSketch | null) => void
  placeHazardPoint: (point: [number, number]) => void
  /** Shift every point of the draft (dragging a drawn area or a placed circle) by a lon/lat delta. */
  translateHazardSketch: (dlon: number, dlat: number) => void
  /** Pick up an existing weather event so dragging/resizing it previews a single replace edit. */
  beginHazardMove: (trackId: string) => boolean
  setHazardInfo: (trackId: string | null) => void
  /** One-click removal: preview + apply into a child scenario; the parent keeps the event. */
  deleteHazard: (trackId: string) => Promise<ScenarioSpec | null>
  setLens: (l: LensTab | null) => void
  setDeveloper: (d: boolean) => void
  setCameraMode: (m: CameraMode) => void
  applyGhost: () => Promise<ScenarioSpec | null>
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
  pendingPlayback: null,
  t: clock.t,
  playing: clock.playing,
  speed: clock.speed,
  selection: null,
  investigation: null,
  error: null,
  tool: null,
  ghost: null,
  hazardSketch: null,
  hazardInfoId: null,
  pendingHazardRemoval: null,
  lens: null,
  developer: false,
  cameraMode: 'city',
  building: null,

  async boot(requestedPackId) {
    const request = ++packSelectionRequest
    try {
      const [health, scenarios, packs] = await Promise.all([
        api.health().then((health) => { if (request === packSelectionRequest) set({ health }); return health }), api.scenarios(), api.packs(),
      ])
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
        loadingReplay: null, pendingPlayback: null, selection: null, ghost: null, hazardSketch: null, hazardInfoId: null, investigation: null, tool: null, cameraMode: 'city', error: null,
      })
      cameraTo(cityPose(pack.pack_id, pack.center), 'city')
      const own = get().scenarios.filter((s) => s.pack_id === packId)
      if (own.length) await get().selectScenario(own[own.length - 1].scenario_id)
    } catch (e) {
      if (request === packSelectionRequest) set({ error: String(e) })
    }
  },

  async selectScenario(sid, position) {
    const request = ++scenarioSelectionRequest
    const sc = get().scenarios.find((s) => s.scenario_id === sid)
    if (sc && sc.pack_id !== get().pack?.pack_id) {
      const [pack, roads] = await Promise.all([api.pack(sc.pack_id), api.roads(sc.pack_id)])
      if (request !== scenarioSelectionRequest) return
      set({ pack, roads })
      cameraTo(cityPose(pack.pack_id, pack.center), 'city')
    }
    clock.pause()
    if (sc) clock.setHorizon(sc.constraints.horizon_s)
    clock.seek(position?.t ?? 0)
    if (position) clock.setSpeed(position.speed)
    set({ scenarioId: sid, plans: [], runs: [], travelers: {}, primaryRunId: null, loadingReplay: null, pendingPlayback: position ? { ...position, scenarioId: sid } : null, selection: null, ghost: null, hazardSketch: null, hazardInfoId: null })
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
    const request = scenarioSelectionRequest
    if (!sid) return
    const runs = await api.runs(sid)
    if (get().scenarioId !== sid || request !== scenarioSelectionRequest) return
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
    const request = scenarioSelectionRequest
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
      if (get().scenarioId !== scenarioId || get().loadingReplay !== rid || request !== scenarioSelectionRequest) return
      const scenario = get().scenarios.find((s) => s.scenario_id === scenarioId)
      const pending = get().pendingPlayback
      const position = pending?.scenarioId === scenarioId ? pending : null
      clock.setHorizon(Math.max(scenario?.constraints.horizon_s ?? 0, rx.tMax))
      if (position) clock.setSpeed(position.speed)
      clock.seek(position?.t ?? rx.activityStart ?? 0)
      set({ primaryRunId: rid, selection: null, pendingPlayback: null })
      if (!position || position.playing) clock.play()
    } catch (e) {
      if (get().scenarioId === scenarioId && get().loadingReplay === rid && request === scenarioSelectionRequest) set({ error: String(e) })
    } finally {
      if (get().loadingReplay === rid && request === scenarioSelectionRequest) set({ loadingReplay: null })
    }
  },

  select: (selection) => set({ selection }),
  setInvestigation: (investigation) => set({ investigation }),
  setError: (error) => set({ error }),
  setTool: (tool) => set({ tool, ghost: tool === get().tool ? get().ghost : null, hazardSketch: tool === 'weather' ? get().hazardSketch : null }),
  setGhost: (ghost) => {
    if (ghost?.proposal && ghost.proposal.base_scenario_id !== get().scenarioId) return
    set({ ghost })
  },
  setHazardSketch: (hazardSketch) => set({ hazardSketch, ghost: null }),
  placeHazardPoint: (point) => {
    const { pack, hazardSketch, tool, building } = get()
    if (!pack || !hazardSketch?.placing || tool !== 'weather' || building) return
    const [west, south, east, north] = pack.bbox
    if (!point.every(Number.isFinite) || point[0] < west || point[0] > east || point[1] < south || point[1] > north) {
      set({ error: 'Place the hazard inside this city pack’s supported area.' })
      return
    }
    const horizon = get().scenarios.find((s) => s.scenario_id === get().scenarioId)?.constraints.horizon_s ?? hazardSketch.draft.end_s
    // A new event starts now and lasts WEATHER_DURATION_S; moving an existing one keeps its window.
    const timed = hazardSketch.replaces ? hazardSketch : { ...hazardSketch, draft: { ...hazardSketch.draft, ...weatherWindow(clock.t, horizon) } }
    const previous = timed.draft.waypoints
    if (timed.shape === 'corridor' && previous.length >= 64) {
      set({ error: 'A corridor supports at most 64 points. Undo a point before adding another.' })
      return
    }
    if (previous.length && previous[previous.length - 1][0] === point[0] && previous[previous.length - 1][1] === point[1]) return
    const waypoints = timed.shape === 'point' ? [point] : [...previous, point]
    set({ hazardSketch: { ...timed, draft: { ...timed.draft, waypoints } }, ghost: null, error: null })
  },
  translateHazardSketch: (dlon, dlat) => {
    const { pack, hazardSketch, tool, building } = get()
    if (!pack || !hazardSketch || tool !== 'weather' || building || !hazardSketch.draft.waypoints.length) return
    if (!Number.isFinite(dlon) || !Number.isFinite(dlat) || (dlon === 0 && dlat === 0)) return
    const [west, south, east, north] = pack.bbox
    const waypoints = hazardSketch.draft.waypoints.map(([lon, lat]) => [lon + dlon, lat + dlat] as [number, number])
    if (waypoints.some(([lon, lat]) => lon < west || lon > east || lat < south || lat > north)) {
      set({ error: 'Keep the event inside this city pack’s supported area.' })
      return
    }
    set({ hazardSketch: { ...hazardSketch, draft: { ...hazardSketch.draft, waypoints } }, ghost: null, error: null })
  },
  beginHazardMove: (trackId) => {
    const { scenarios, scenarioId, building } = get()
    const scenario = scenarios.find((s) => s.scenario_id === scenarioId)
    const h = scenario?.hazards.find((x) => x.track_id === trackId)
    if (!h || building || h.kind === 'fire') return false
    const fp = h.footprint?.[0]
    const center: [number, number] = fp?.length ? ringCentroid(fp) : h.waypoints[0]
    const draft: HazardDraft = {
      waypoints: h.waypoints.length > 1 ? h.waypoints.map((p) => [p[0], p[1]] as [number, number]) : [center],
      radius_m: h.radius_m, start_s: h.start_s, end_s: h.end_s, modes: h.modes, kind: h.kind ?? 'storm', shape: h.shape ?? 'buffer', label: h.label,
    }
    set({
      tool: 'weather', ghost: null, hazardInfoId: null,
      hazardSketch: { shape: h.waypoints.length > 1 ? 'corridor' : 'point', placing: true, replaces: trackId, draft },
    })
    return true
  },
  setHazardInfo: (hazardInfoId) => set({ hazardInfoId }),
  async deleteHazard(trackId) {
    const { scenarioId, scenarios, building, pendingHazardRemoval } = get()
    if (!scenarioId || building || pendingHazardRemoval || !scenarios.find((s) => s.scenario_id === scenarioId)?.hazards.some((h) => h.track_id === trackId)) return null
    const removal = { scenarioId, trackId }
    const selectionRequest = scenarioSelectionRequest
    const stillSelected = () => get().scenarioId === scenarioId && selectionRequest === scenarioSelectionRequest
    let child: ScenarioSpec | null = null
    set({ pendingHazardRemoval: removal, building: 'Removing weather event · saving…', error: null, selection: null, hazardInfoId: null, ghost: null, hazardSketch: null, tool: null })
    try {
      const proposal = await api.previewHazardRemoval(scenarioId, trackId)
      if (!stillSelected()) return null
      child = await api.applyEdit(scenarioId, proposal)
      const saved = child
      set({ scenarios: [...get().scenarios.filter((s) => s.scenario_id !== saved.scenario_id), saved] })
      if (stillSelected()) {
        const pending = get().pendingPlayback
        const position = pending?.scenarioId === scenarioId ? pending : { t: clock.t, playing: clock.playing, speed: clock.speed }
        await get().selectScenario(saved.scenario_id, position)
      }
      return saved
    } catch (e) {
      if (get().scenarioId === (child?.scenario_id ?? scenarioId)) set({ error: child ? `Event removed, but loading its scenario failed: ${String(e)}` : `Could not remove event: ${String(e)}` })
      return child
    } finally {
      if (get().pendingHazardRemoval === removal) set({ pendingHazardRemoval: null, building: null })
    }
  },
  setLens: (lens) => set({ lens }),
  setDeveloper: (developer) => set({ developer }),
  setCameraMode: (cameraMode) => set({ cameraMode }),

  /** Confirm a ghost: the backend applies the typed proposal to a NEW scenario id (parent stays immutable). */
  async applyGhost() {
    const { ghost, scenarioId } = get()
    if (!ghost?.proposal || !scenarioId) return null
    if (get().building || get().pendingHazardRemoval) return null
    if (ghost.proposal.base_scenario_id !== scenarioId || ghost.proposal.ambiguous || ghost.proposal.kind === 'unsupported') return null
    const request = scenarioSelectionRequest
    const pending = get().pendingPlayback
    const position = ghost.hazard ? (pending?.scenarioId === scenarioId ? pending : { t: clock.t, playing: clock.playing, speed: clock.speed }) : undefined
    if (position) clock.pause()
    set({ building: 'Freezing scenario · compiling branch…', error: null })
    try {
      const s = await api.applyEdit(scenarioId, ghost.proposal)
      const scenarios = await api.scenarios()
      set({ scenarios })
      if (get().scenarioId !== scenarioId || get().ghost !== ghost || request !== scenarioSelectionRequest) return null
      const keepTool = get().tool === 'weather' && ghost.hazard && ghost.proposal.kind !== 'remove_hazard'
      set({ tool: keepTool ? 'weather' : null, building: `Branch ${s.scenario_id} compiled · loading world…` })
      await get().selectScenario(s.scenario_id, position)
      return s
    } catch (e) {
      set({ error: String(e) })
      if (position && get().scenarioId === scenarioId && request === scenarioSelectionRequest && position.playing && !get().pendingPlayback) clock.play()
      return null
    } finally {
      set({ building: null })
    }
  },
}))

clock.onUi((t) => useStore.setState({ t, playing: clock.playing, speed: clock.speed }))
