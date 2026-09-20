import { useCallback, useEffect, useRef } from 'react'
import { PointerEventTypes, type PointerInfoPre } from '@babylonjs/core/Events/pointerEvents'
import { Matrix } from '@babylonjs/core/Maths/math.vector'
import { Plane } from '@babylonjs/core/Maths/math.plane'
import '@babylonjs/core/Culling/ray'

import { canEditScenario, containsHazardPoint, hazardFootprint, pointInRing, scenarioForReplay } from '../replay'
import HazardMapLabels from '../world/HazardMapLabels'
import { useStore } from '../store'
import { distanceToStroke } from '../hazardGeometry'
import type { HazardTrack, ScenarioSpec } from '../types'
import { clock } from '../world/playback'
import { registerMap } from '../world/registry'
import type { WorldFrame } from './coords'
import { guideTrack, HazardEffects } from './hazardEffects'
import { BabylonSyncMap } from './mapAdapter'
import { Overlay, type CursorGhost } from './overlay'
import type { WorldScene } from './scene'
import WorldCanvas from './WorldCanvas'
import './world.css'

const STOP_PICK_PX = 16
const DRAG_PX = 5
/** Minimum wall-clock gap between store updates while dragging a weather event. */
const DRAG_UPDATE_MS = 40

type Hit = { kind: 'draft' } | { kind: 'zone'; hazard: HazardTrack }
type Hover = Hit | { kind: 'agent'; id: string }

/** Pointer affordances shared with `marks()` so the overlay can outline whatever is under the pointer. */
interface Pointer {
  hover: Hover | null
  /** Ground position under the pointer (world x, z) while it is over the canvas. */
  ground: [number, number] | null
  dragging: boolean
}
/** Cursor positions are quantised to this many metres so the overlay is not rebuilt for sub-pixel jitter. */
const CURSOR_STEP_M = 0.5

/**
 * Drop-in for `WorldMap`: the Babylon miniature Toronto driven by the same store, clock and shell.  Registers a
 * `SyncMap` adapter so camera modes, the agent bubble and compare sync work unchanged.
 */
export default function WorldBabylon({ runId, side, onWorldReady, onWorldError }: { runId: string | null; side: 'solo' | 'left' | 'right'; onWorldReady?: (scene: WorldScene) => void; onWorldError?: (message: string) => void }) {
  const pack = useStore((s) => s.pack)
  const sceneRef = useRef<WorldScene | null>(null)
  const runIdRef = useRef(runId)
  const syncRef = useRef<() => void>(() => {})
  useEffect(() => {
    runIdRef.current = runId
    syncRef.current()
  }, [runId])

  const onReady = useCallback(
    (ws: WorldScene) => {
      sceneRef.current = ws
      if (window.__cityshift) window.__cityshift.babylon = ws
      const map = new BabylonSyncMap(ws)
      const overlay = new Overlay(ws.scene, ws.roads, ws.frame)
      const effects = new HazardEffects(ws.scene, ws.frame)
      const project = (x: number, y: number, z: number) => map.projectWorld(x, y, z)
      map.hazardAnchor = (id) => effects.anchorFor(id, project)
      const unregister = registerMap(side, map)
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const animator = ws.scene.onBeforeRenderObservable.add(() => {
        if (!reducedMotion) effects.animate(Math.min(ws.engine.getDeltaTime(), 100) / 1000)
      })

      const currentScenario = (): ScenarioSpec | null => {
        const s = useStore.getState()
        const rid = runIdRef.current
        return scenarioForReplay(s.scenarios, s.scenarioId, rid ? s.replays[rid] ?? null : null)
      }
      const groundAt = (sx: number, sy: number): [number, number] | null => {
        const ray = ws.scene.createPickingRay(sx, sy, Matrix.Identity(), ws.camera.cam)
        const distance = ray.intersectsPlane(new Plane(0, 1, 0, 0))
        if (distance === null) return null
        const p = ray.origin.add(ray.direction.scale(distance))
        return [p.x, p.z]
      }
      /** The weather event under a world point: the unconfirmed draft first, then confirmed events. */
      const hazardUnder = (wx: number, wz: number): Hit | null => {
        const s = useStore.getState()
        const scenario = currentScenario()
        const editing = canEditScenario(scenario, s.scenarioId, side)
        const sketch = editing && s.tool === 'weather' ? s.hazardSketch : null
        const c = sketch?.draft.waypoints[0]
        const point = ws.frame.worldToLonLat(wx, wz)
        if (c && sketch) {
          if (sketch.draft.shape === 'polygon') {
            if (sketch.draft.waypoints.length >= 3 && pointInRing(sketch.draft.waypoints, point)) return { kind: 'draft' }
          } else {
            const path = sketch.draft.waypoints.map(([lon, lat]) => ws.frame.lonLatToWorld(lon, lat))
            if (distanceToStroke([wx, wz], path) <= sketch.draft.radius_m) return { kind: 'draft' }
          }
        }
        const hidden = s.pendingHazardRemoval?.scenarioId === scenario?.scenario_id ? s.pendingHazardRemoval?.trackId : null
        const h = scenario?.hazards.find((h) => h.track_id !== sketch?.replaces && h.track_id !== hidden && clock.t >= h.start_s && clock.t < h.end_s && containsHazardPoint(h, point))
        return h ? { kind: 'zone', hazard: h } : null
      }
      const cloudUnder = (sx: number, sy: number): Hit | null => {
        const id = effects.pickCloud(sx, sy, project)
        if (!id) return null
        const state = useStore.getState()
        if (id === 'weather-guide' || id === state.ghost?.hazard?.track_id) return { kind: 'draft' }
        const hazard = currentScenario()?.hazards.find((h) => h.track_id === id)
        return hazard ? { kind: 'zone', hazard } : null
      }
      /** Dragging is allowed on the editable side, when no other tool owns the pointer and nothing is compiling. */
      const canDrag = (hit: Hit): boolean => {
        const s = useStore.getState()
        if (!canEditScenario(currentScenario(), s.scenarioId, side) || s.building || (hit.kind === 'zone' && hit.hazard.kind === 'fire')) return false
        return hit.kind === 'draft' || s.tool === 'weather' || s.tool === null
      }
      const hazardAt = (wx: number, wz: number): Hit | null => {
        const hit = hazardUnder(wx, wz)
        return hit && canDrag(hit) ? hit : null
      }
      const centerWorld = (hit: Hit): [number, number] => {
        if (hit.kind === 'draft') {
          const c = useStore.getState().hazardSketch!.draft.waypoints[0]
          return ws.frame.lonLatToWorld(c[0], c[1])
        }
        const fp = hazardFootprint(hit.hazard, 0, true)
        const c = fp?.center ?? hit.hazard.waypoints[0]
        return ws.frame.lonLatToWorld(c[0], c[1])
      }

      const pointer: Pointer = { hover: null, ground: null, dragging: false }
      let drag: { hit: Hit; ox: number; oz: number; gx: number; gz: number; moved: boolean; sx: number; sy: number; lastUpdate: number } | null = null
      /** Move the draft under the pointer: circles re-centre, drawn areas translate every corner together. */
      const dragTo = (g: [number, number]): void => {
        if (!drag) return
        const s = useStore.getState()
        if (s.hazardSketch?.draft.shape === 'polygon' || s.hazardSketch?.shape === 'corridor') {
          const from = ws.frame.worldToLonLat(drag.gx, drag.gz)
          const to = ws.frame.worldToLonLat(g[0], g[1])
          s.translateHazardSketch(to[0] - from[0], to[1] - from[1])
        } else {
          s.placeHazardPoint(ws.frame.worldToLonLat(g[0] - drag.ox, g[1] - drag.oz))
        }
        drag.gx = g[0]
        drag.gz = g[1]
      }
      // We own the cursor: otherwise Babylon resets it to its (empty) default on every pointer move.
      ws.scene.doNotHandleCursors = true
      const updateCursor = (): void => {
        const s = useStore.getState()
        const h = pointer.hover
        const placing = canEditScenario(currentScenario(), s.scenarioId, side) && s.tool === 'weather' && s.hazardSketch?.placing
        // Applied events select their removal control; unconfirmed drafts can be dragged.
        ws.canvas.style.cursor = drag ? 'grabbing' : h?.kind === 'agent' || h?.kind === 'zone' ? 'pointer' : h ? (canDrag(h) ? 'grab' : 'pointer') : placing ? 'crosshair' : 'default'
      }
      const sameHover = (a: Hover | null, b: Hover | null): boolean =>
        a === b || (!!a && !!b && a.kind === b.kind && (a.kind === 'draft' || (a.kind === 'agent' ? a.id === (b as { id: string }).id : a.hazard === (b as { hazard: HazardTrack }).hazard)))
      /** Store what is under the pointer; returns whether anything changed. */
      const assignPointer = (next: Hover | null, ground: [number, number] | null): boolean => {
        const quantised: [number, number] | null = ground && [Math.round(ground[0] / CURSOR_STEP_M) * CURSOR_STEP_M, Math.round(ground[1] / CURSOR_STEP_M) * CURSOR_STEP_M]
        const groundChanged = (quantised?.[0] ?? null) !== (pointer.ground?.[0] ?? null) || (quantised?.[1] ?? null) !== (pointer.ground?.[1] ?? null)
        if (sameHover(pointer.hover, next) && !groundChanged) return false
        pointer.hover = next
        pointer.ground = quantised
        ws.traffic.hoverId = next?.kind === 'agent' ? next.id : null
        return true
      }
      /** Recompute what is under the pointer; outlines agents/events and moves the placement cursor. */
      const setPointer = (next: Hover | null, ground: [number, number] | null): void => {
        if (!assignPointer(next, ground)) return
        updateCursor()
        marks(overlay, effects, ws.frame, clock.t, runIdRef.current, side, pointer)
      }
      let lastScreen: [number, number] | null = null
      const pointerAt = (sx: number, sy: number): { hover: Hover | null; ground: [number, number] | null } => {
        const g = groundAt(sx, sy)
        const cloud = cloudUnder(sx, sy)
        if (cloud) return { hover: cloud, ground: g }
        const agent = ws.traffic.pick(sx, sy, project)
        if (agent) return { hover: { kind: 'agent', id: agent.id }, ground: g }
        return { hover: g ? hazardUnder(g[0], g[1]) : null, ground: g }
      }

      let rxKey: string | null = null
      const sync = (): void => {
        const s = useStore.getState()
        const rid = runIdRef.current
        const rx = rid ? s.replays[rid] ?? null : null
        const key = rid && rx ? rid : null
        if (key !== rxKey) {
          rxKey = key
          ws.traffic.setReplay(rx)
        }
        const sel = s.selection
        ws.traffic.selectedId = sel && sel.kind !== 'restriction' && sel.kind !== 'stop' ? sel.id : null
        ws.traffic.dimOthers = sel?.kind === 'person'
        // The world under a resting pointer may have changed (e.g. a click just placed an event beneath it).
        if (lastScreen && !drag) {
          const at = pointerAt(lastScreen[0], lastScreen[1])
          assignPointer(at.hover, at.ground)
        }
        updateCursor()
        marks(overlay, effects, ws.frame, clock.t, runIdRef.current, side, pointer)
      }
      syncRef.current = sync
      sync()
      ws.simT = clock.t
      const offFrame = clock.onFrame((t) => {
        ws.simT = t
        marks(overlay, effects, ws.frame, t, runIdRef.current, side, pointer)
      })
      const unsub = useStore.subscribe(sync)

      // Pointer handling runs before the camera sees the event, so dragging a weather event never pans the map.
      // Click (not drag) selects the nearest drawn traveller / vehicle, else the nearest stop, else a restriction.
      let down: { x: number; y: number } | null = null
      const pre = ws.scene.onPrePointerObservable.add((pi: PointerInfoPre) => {
        const ev = pi.event as PointerEvent
        const sx = pi.localPosition.x
        const sy = pi.localPosition.y
        if (pi.type === PointerEventTypes.POINTERDOWN) {
          drag = null
          if (ev.button !== 0) return
          down = { x: sx, y: sy }
          const g = groundAt(sx, sy)
          const candidate = cloudUnder(sx, sy) ?? (g && hazardAt(g[0], g[1]))
          const hit = candidate && canDrag(candidate) ? candidate : null
          if (!g || !hit) return
          const [cx, cz] = centerWorld(hit)
          drag = { hit, ox: g[0] - cx, oz: g[1] - cz, gx: g[0], gz: g[1], moved: false, sx, sy, lastUpdate: 0 }
          pointer.dragging = true
          pi.skipOnPointerObservable = true
          updateCursor()
        } else if (pi.type === PointerEventTypes.POINTERMOVE) {
          if (!drag) {
            lastScreen = [sx, sy]
            const at = pointerAt(sx, sy)
            setPointer(at.hover, at.ground)
            return
          }
          pi.skipOnPointerObservable = true
          if (!drag.moved) {
            if (Math.hypot(sx - drag.sx, sy - drag.sy) < DRAG_PX) return
            // A confirmed event only becomes a move once the pointer really travels, so plain clicks stay clicks.
            if (drag.hit.kind === 'zone' && !useStore.getState().beginHazardMove(drag.hit.hazard.track_id)) {
              drag = null
              pointer.dragging = false
              updateCursor()
              return
            }
            drag.moved = true
          }
          const now = performance.now()
          if (now - drag.lastUpdate < DRAG_UPDATE_MS) return
          drag.lastUpdate = now
          const g = groundAt(sx, sy)
          if (g) dragTo(g)
        } else if (pi.type === PointerEventTypes.POINTERUP) {
          const d = drag
          drag = null
          pointer.dragging = false
          if (d) {
            pi.skipOnPointerObservable = true
            updateCursor()
            if (d.moved) {
              drag = d
              const g = groundAt(sx, sy)
              if (g) dragTo(g)
              drag = null
              down = null
              return
            }
          }
          if (!down) return
          const moved = Math.hypot(sx - down.x, sy - down.y)
          down = null
          if (moved > DRAG_PX) return
          click(sx, sy)
        }
      })

      const click = (sx: number, sy: number): void => {
        const ground = groundAt(sx, sy)
        const state = useStore.getState()
        const scenario = currentScenario()
        const editing = canEditScenario(scenario, state.scenarioId, side)
        // One click selects an event; only its floating removal button commits a removal.
        const event = cloudUnder(sx, sy) ?? (ground && hazardUnder(ground[0], ground[1]))
        if (event?.kind === 'zone') {
          state.select(null)
          state.setHazardInfo(event.hazard.track_id)
          return
        }
        state.setHazardInfo(null)
        if (editing && state.tool === 'weather' && state.hazardSketch?.placing && ground) {
          // Clicking open ground (re)places the draft; the draft itself is moved by dragging. Applied events
          // are selected above without deleting them.
          const hit = hazardAt(ground[0], ground[1])
          if (!hit) {
            state.placeHazardPoint(ws.frame.worldToLonLat(ground[0], ground[1]))
            return
          }
          if (hit.kind === 'draft') return
        }
        const hit = ws.traffic.pick(sx, sy, project)
        if (hit) {
          useStore.getState().select({ kind: hit.kind, id: hit.id })
          return
        }
        let best: string | null = null
        let bestD = STOP_PICK_PX * STOP_PICK_PX
        for (const st of ws.world.stops) {
          const p = project(st.x, 0, st.z)
          const d = (p.x - sx) * (p.x - sx) + (p.y - sy) * (p.y - sy)
          if (d < bestD) {
            bestD = d
            best = st.id
          }
        }
        if (best) {
          state.select({ kind: 'stop', id: best })
        }
      }

      const canvas = ws.canvas
      const onLeave = (): void => {
        lastScreen = null
        setPointer(null, null)
      }
      const onCancel = (): void => {
        drag = null
        down = null
        pointer.dragging = false
        updateCursor()
      }
      canvas.addEventListener('pointerleave', onLeave)
      canvas.addEventListener('pointercancel', onCancel)

      onWorldReady?.(ws)
      ws.scene.onDisposeObservable.addOnce(() => {
        canvas.removeEventListener('pointerleave', onLeave)
        canvas.removeEventListener('pointercancel', onCancel)
        ws.scene.onPrePointerObservable.remove(pre)
        unsub()
        offFrame()
        unregister()
        ws.scene.onBeforeRenderObservable.remove(animator)
        effects.dispose()
        overlay.dispose()
        map.dispose()
        syncRef.current = () => {}
        if (sceneRef.current === ws) sceneRef.current = null
        if (window.__cityshift?.babylon === ws) window.__cityshift.babylon = undefined
      })
    },
    [side, onWorldReady],
  )

  if (!pack) return <div className={`world world-${side} bworld`} />
  return (
    <WorldCanvas packId={pack.pack_id} onReady={onReady} onError={onWorldError} quality={side === 'solo' ? 'high' : 'balanced'} className={`world world-${side} bworld`}>
      <HazardMapLabels runId={runId} side={side} />
    </WorldCanvas>
  )
}

/** Active closures, ghost proposal, weather visuals and focus corridor for sim time `t`, from the store. */
function marks(overlay: Overlay, effects: HazardEffects, frame: WorldFrame, t: number, runId: string | null, side: string, pointer: Pointer): void {
  const s = useStore.getState()
  const scenario = scenarioForReplay(s.scenarios, s.scenarioId, runId ? s.replays[runId] ?? null : null)
  const editing = canEditScenario(scenario, s.scenarioId, side)
  const ghost = editing ? s.ghost : null
  const sketch = editing && s.tool === 'weather' ? s.hazardSketch : null
  const replaced = sketch?.replaces ?? ghost?.replaces ?? null
  const hidden = s.pendingHazardRemoval?.scenarioId === scenario?.scenario_id ? s.pendingHazardRemoval?.trackId : null
  const hazards = (scenario?.hazards ?? []).filter((h) => h.track_id !== replaced && h.track_id !== hidden)
  const hoveredId = pointer.hover?.kind === 'zone' ? pointer.hover.hazard.track_id : null
  const hovered = hazards.find((h) => h.track_id === hoveredId && t >= h.start_s && t < h.end_s) ?? null
  const closed: string[] = []
  for (const r of scenario?.restrictions ?? []) if (t >= r.start_s && t < r.end_s && (!hidden || r.source_claim_id !== `hazard:${hidden}`)) closed.push(...r.edge_ids)
  const focusId = s.selection?.kind === 'restriction' ? s.selection.id : null
  const focus = focusId ? scenario?.restrictions.find((r) => r.restriction_id === focusId)?.edge_ids ?? [] : []
  // Placement cursor: while the tool is placing and the pointer is over open ground, show what a click drops.
  let cursor: CursorGhost | null = null
  if (sketch?.placing && pointer.ground && !pointer.hover && !pointer.dragging && !s.building) {
    const [x, z] = pointer.ground
    cursor = { kind: 'circle', x, z, radius: sketch.draft.radius_m }
  }
  overlay.set({
    closed, ghost: ghost?.edges ?? [], focus, ghostStops: ghost?.stops ?? [],
    hazards: hazards.filter((h) => t >= h.start_s && t < h.end_s),
    ghostHazard: ghost?.hazard ?? null,
    sketch: sketch && !ghost?.hazard ? sketch.draft : null,
    hoverHazard: hovered ?? (pointer.hover?.kind === 'draft' ? ghost?.hazard ?? null : null),
    hoverSketch: pointer.hover?.kind === 'draft' && !ghost?.hazard,
    cursor,
  })
  // Removal previews keep the existing visual so the user sees what would disappear; new/moved events are muted.
  const previewHazard = ghost?.hazard && ghost.proposal?.kind !== 'remove_hazard' ? ghost.hazard : null
  const guide = !previewHazard && sketch ? guideTrack(sketch.draft, frame) : null
  const visible = hazards.slice()
  if (previewHazard) visible.push(previewHazard)
  else if (guide) visible.push(guide)
  effects.set(visible, t, previewHazard?.track_id ?? guide?.track_id ?? null)
}
