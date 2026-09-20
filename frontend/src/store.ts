import { create } from 'zustand'
import { api } from './api'
import { DEFAULT_HORIZON_S, developmentError as validateDevelopment, developmentKind, developmentPreset, validDevelopmentGeometry } from './development'
import { enterCity, live } from './live/session'
import { clock } from './world/playback'
import { cityPose, currentPose, developmentPose, type CameraMode } from './world/camera'
import { cameraTo, leadMap, watchCameraMode } from './world/registry'
import type { BuildingKind, CityPack, Corridor, Development, DevelopmentSpec, HazardTrack, Health, StopCandidate } from './types'

export type Selection =
  | { kind: 'bus'; id: string }
  | { kind: 'person'; id: string }
  | { kind: 'car'; id: string }
  | { kind: 'stop'; id: string }
  /** A closure in force in the live city (id = the close command); `at` is the clicked lon/lat so its card opens there. */
  | { kind: 'restriction'; id: string; at?: [number, number] }
  /** A development standing in the live city. */
  | { kind: 'development'; id: string }
  /** A base-city building or landmark picked on the map (ids are the pack's OSM way ids); facts come from `SyncMap.buildingFacts`. */
  | { kind: 'building'; id: string }
  | null

export type ToolId = 'area' | 'closure' | 'development' | 'population' | 'temperature'

/** What a tool is aiming at, drawn on the world before anything is applied: picked streets, stops, a hazard track. */
export type Ghost = {
  edges: string[]
  stops: StopCandidate[]
  hazard: HazardTrack | null
}

type State = {
  health: Health | null
  packs: { pack_id: string; name: string }[]
  pack: CityPack | null
  roads: GeoJSON.FeatureCollection | null
  /** Named streets of the pack (corridors.json): closure targets and the Corridor picker's regions. */
  corridors: Record<string, Corridor>
  /** UI-rate copy of the playback clock (≈10 Hz); the renderer reads `clock.t` directly. */
  t: number
  playing: boolean
  speed: number
  selection: Selection
  error: string | null
  // shell
  tool: ToolId | null
  ghost: Ghost | null
  /** Last camera framing asked for through `cameraTo`; 'agent' keeps the camera gliding after the selected entity. */
  cameraMode: CameraMode
  /** Area select is choosing a district / corridor: the city outlines regions and a click flies in, then this clears. */
  picking: boolean
  // development being placed (a live command once confirmed)
  developmentDraft: DevelopmentSpec | null
  developmentPlaced: boolean
  /** Cursor position over the map while a draft is still being aimed; the ghost outline follows it. */
  developmentHover: [number, number] | null
  developmentError: string | null
  /** Set when a city loads before any map is registered; the renderer consumes it on ready. */
  pendingDevelopmentFocus: string | null

  boot: (packId?: string) => Promise<void>
  selectPack: (packId: string) => Promise<void>
  select: (s: Selection) => void
  setError: (e: string | null) => void
  setTool: (t: ToolId | null) => void
  setGhost: (g: Ghost | null) => void
  setCameraMode: (m: CameraMode) => void
  setPicking: (p: boolean) => void
  chooseDevelopmentKind: (kind: BuildingKind) => void
  setDevelopmentHover: (position: [number, number] | null) => void
  /** Commit the aimed footprint: SUMO checks its street access straight away and the panel shows Confirm. */
  placeDevelopment: (position: [number, number]) => void
  previewDevelopment: () => Promise<void>
  /** Confirm the previewed building into the running city. */
  applyDevelopment: () => Promise<boolean>
  /** Fly the lead camera to a development standing in the city. Returns false if none. */
  focusDevelopment: (id?: string) => boolean
}

let packSelectionRequest = 0

/** Everything the shell needs about a city pack; a pack without corridors.json is still a usable city. */
async function loadPack(packId: string): Promise<{ pack: CityPack; roads: GeoJSON.FeatureCollection; corridors: Record<string, Corridor> }> {
  const [pack, roads, corridors] = await Promise.all([api.pack(packId), api.roads(packId), api.corridors(packId).catch(() => ({}))])
  return { pack, roads, corridors }
}

const EMPTY_DEVELOPMENT = { developmentDraft: null, developmentPlaced: false, developmentHover: null, developmentError: null }

/** Developments standing in the live city right now. */
export function liveDevelopments(): Development[] {
  return live.session?.developments ?? []
}

export const useStore = create<State>((set, get) => ({
  health: null,
  packs: [],
  pack: null,
  roads: null,
  corridors: {},
  t: clock.t,
  playing: clock.playing,
  speed: clock.speed,
  selection: null,
  error: null,
  tool: null,
  ghost: null,
  cameraMode: 'city',
  picking: false,
  ...EMPTY_DEVELOPMENT,
  pendingDevelopmentFocus: null,

  async boot(requestedPackId) {
    const request = ++packSelectionRequest
    try {
      const [health, packs] = await Promise.all([api.health(), api.packs()])
      if (request !== packSelectionRequest) return
      set({ health, packs })
      const packId = packs.find((p) => p.pack_id === requestedPackId)?.pack_id ?? packs.find((p) => p.pack_id === 'toronto')?.pack_id ?? packs[0]?.pack_id ?? 'toronto'
      const loaded = await loadPack(packId)
      if (request !== packSelectionRequest) return
      set(loaded)
      await enterCity(packId)
    } catch (e) {
      if (request === packSelectionRequest) set({ error: String(e) })
    }
  },

  async selectPack(packId) {
    const request = ++packSelectionRequest
    if (packId === get().pack?.pack_id) return
    try {
      const loaded = await loadPack(packId)
      if (request !== packSelectionRequest) return
      set({ ...loaded, selection: null, ghost: null, tool: null, cameraMode: 'city', picking: false, error: null, pendingDevelopmentFocus: null, ...EMPTY_DEVELOPMENT })
      cameraTo(cityPose(loaded.pack.pack_id, loaded.pack.center), 'city')
      await enterCity(packId)
    } catch (e) {
      if (request === packSelectionRequest) set({ error: String(e) })
    }
  },

  select: (selection) => set({ selection, ...(selection?.kind === 'development' ? EMPTY_DEVELOPMENT : {}) }),
  setError: (error) => set({ error }),
  // Picking a different tool ends an Area select pick (closing the panel does not: the pick runs with it closed),
  // drops the aim of any tool, and opening the development tool starts a fresh draft for the current city.
  setTool: (tool) => {
    const { pack } = get()
    if (tool !== get().tool) live.discard()
    set({ tool, ghost: null, ...EMPTY_DEVELOPMENT,
      picking: (tool === null || tool === 'area') && get().picking,
      selection: tool === 'development' ? null : get().selection,
      developmentDraft: tool === 'development' && pack ? developmentPreset(pack, live.session?.horizon_s ?? DEFAULT_HORIZON_S) : null,
    })
  },
  setGhost: (ghost) => set({ ghost }),
  setCameraMode: (cameraMode) => set({ cameraMode }),
  setPicking: (picking) => set({ picking }),

  chooseDevelopmentKind: (kind) => {
    const { pack, developmentDraft, developmentPlaced, tool } = get()
    if (tool !== 'development' || !pack) return
    const ordinal = liveDevelopments().filter((d) => developmentKind(d.spec) === kind).length + 1
    const preset = developmentPreset(pack, live.session?.horizon_s ?? DEFAULT_HORIZON_S, kind, ordinal)
    live.discard()
    set({ developmentDraft: { ...preset, position: developmentDraft?.position ?? preset.position }, developmentError: null })
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
    live.discard()
    set({ developmentDraft: { ...developmentDraft, position }, developmentPlaced: true, developmentHover: null, developmentError: null })
    void get().previewDevelopment()
  },
  async previewDevelopment() {
    const { developmentDraft, developmentPlaced } = get()
    const session = live.session
    if (!session || !developmentDraft || !developmentPlaced) return
    const problem = validateDevelopment(developmentDraft, session.horizon_s)
    if (problem) {
      set({ developmentError: problem })
      return
    }
    await live.preview({ kind: 'development', spec: developmentDraft })
    const { error } = live.getSnapshot()
    if (get().developmentDraft === developmentDraft) set({ developmentError: error })
  },
  async applyDevelopment() {
    const { developmentDraft } = get()
    const draft = live.getSnapshot().draft
    if (!developmentDraft || draft?.intervention.kind !== 'development') return false
    await live.apply()
    const { error } = live.getSnapshot()
    if (error) {
      set({ developmentError: error })
      return false
    }
    const added = liveDevelopments().at(-1)
    set({ tool: null, ...EMPTY_DEVELOPMENT, selection: added ? { kind: 'development', id: added.development_id } : null })
    return true
  },
  focusDevelopment(id) {
    const developments = liveDevelopments()
    const development = id ? developments.find((d) => d.development_id === id) ?? null : developments.at(-1) ?? null
    if (!development || !validDevelopmentGeometry(development.spec)) return false
    set({ selection: { kind: 'development', id: development.development_id }, ...EMPTY_DEVELOPMENT })
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
}))

clock.onUi((t) => useStore.setState({ t, playing: clock.playing, speed: clock.speed }))
// Every explicit camera framing (Follow, Frame, city arrival) records its mode here.
watchCameraMode((cameraMode) => useStore.setState({ cameraMode }))
