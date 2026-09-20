import { useCallback, useEffect, useRef } from 'react'

import { useStore, type Selection } from '../store'
import { corridorPose, currentPose, districtPose } from '../world/camera'
import { clock } from '../world/playback'
import { cameraTo, registerMap } from '../world/registry'
import type { BuildingIndex } from './buildingIndex'
import { BabylonSyncMap } from './mapAdapter'
import { CORRIDOR_PICK_PX, NavLabels, NavOverlay, type NavMode, type NavTarget } from './navigation'
import { Overlay } from './overlay'
import type { WorldScene } from './scene'
import type { Kind } from './traffic'
import WorldCanvas from './WorldCanvas'
import './world.css'

const STOP_PICK_PX = 16
const DRAG_PX = 5

/** Whatever is under the pointer: a replayed entity, a stop, an active closure, a picker region or a building. */
type Target = { kind: Kind | 'stop' | 'incident' | 'district' | 'corridor' | 'building'; id: string; name: string } | null

/** The ground part of a target (what `NavOverlay` draws); null for replayed entities. */
function ground(t: Target): NavTarget {
  return t && t.kind !== 'bus' && t.kind !== 'car' && t.kind !== 'person' ? { kind: t.kind, id: t.id, name: t.name } : null
}

/** Restrictions whose window covers sim time `t`: the closures drawn in red right now. */
function activeRestrictions(t: number): Set<string> {
  const s = useStore.getState()
  const scenario = s.scenarios.find((x) => x.scenario_id === s.scenarioId)
  return new Set((scenario?.restrictions ?? []).filter((r) => t >= r.start_s && t <= r.end_s).map((r) => r.restriction_id))
}

/** The store's selection as a ground target for the overlay (entities are marked by `Traffic`). */
function selectedGround(sel: Selection, nav: NavOverlay, buildings: BuildingIndex): NavTarget {
  if (sel?.kind === 'stop') {
    const stop = nav.stop(sel.id)
    return stop ? { kind: 'stop', id: stop.id, name: stop.name } : null
  }
  if (sel?.kind === 'restriction') {
    const shape = nav.incident(sel.id)
    return shape ? { kind: 'incident', id: shape.id, name: shape.name } : null
  }
  if (sel?.kind === 'building') {
    const b = buildings.building(sel.id)
    return b ? { kind: 'building', id: b.id, name: b.name ?? b.id } : null
  }
  return null
}

/** Any manual camera move ends the agent follow, so the follow glide never fights the hand on the controls. */
function stopFollowing(map: BabylonSyncMap): void {
  const s = useStore.getState()
  if (s.cameraMode !== 'agent') return
  s.setCameraMode('city')
  map.setCameraMode('city')
}

/**
 * Drop-in for `WorldMap`: the Babylon miniature Toronto driven by the same store, clock and shell.  Registers a
 * `SyncMap` adapter so programmatic camera moves, the info bubble and compare sync work unchanged, and turns
 * pointer input into hover marks and selections: buildings, buses, cars, people, stops and active closures.
 */
export default function WorldBabylon({ runId, side, active = true, onWorldReady, onWorldError }: { runId: string | null; side: 'solo' | 'left' | 'right'; /** false while the globe is shown or the city is still flying in: keyboard travel stays off */ active?: boolean; onWorldReady?: (scene: WorldScene) => void; onWorldError?: (message: string) => void }) {
  const pack = useStore((s) => s.pack)
  const sceneRef = useRef<WorldScene | null>(null)
  const labelsRef = useRef<HTMLDivElement>(null)
  const runIdRef = useRef(runId)
  const activeRef = useRef(active)
  const syncRef = useRef<() => void>(() => {})
  useEffect(() => {
    runIdRef.current = runId
    syncRef.current()
  }, [runId])
  useEffect(() => {
    activeRef.current = active
    sceneRef.current?.keys.setEnabled(active)
  }, [active])

  const onReady = useCallback(
    (ws: WorldScene) => {
      sceneRef.current = ws
      if (window.__cityshift) window.__cityshift.babylon = ws
      ws.keys.setEnabled(activeRef.current)
      const map = new BabylonSyncMap(ws)
      const overlay = new Overlay(ws.scene, ws.roads, ws.frame)
      const buildings = ws.buildings
      const nav = new NavOverlay(ws.scene, ws.world, ws.roads, buildings)
      const unregister = registerMap(side, map)
      const canvas = ws.canvas
      const project = (x: number, y: number, z: number) => map.projectWorld(x, y, z)
      const labels = labelsRef.current ? new NavLabels(labelsRef.current, project) : null
      const onCamera = (): void => labels?.update()
      map.on('move', onCamera)
      window.addEventListener('resize', onCamera)

      // --- pointer.  Agents, stops and active closures outline on hover and open their info on click.  While a
      // District / Corridor pick is open the regions tint and name themselves on hover and a click flies in and
      // closes the pick.  Buildings never light up on hover, but a click outside a pick opens their info.
      let down: { x: number; y: number } | null = null
      let last: { x: number; y: number } | null = null
      let hover: Target = null
      let navMode: NavMode = null
      let raf = 0
      const targetAt = (sx: number, sy: number): Target => {
        const hit = ws.traffic.pick(sx, sy, project)
        if (hit) return { kind: hit.kind, id: hit.id, name: hit.id }
        let best: { id: string; name: string } | null = null
        let bestD = STOP_PICK_PX * STOP_PICK_PX
        for (const st of ws.world.stops) {
          const p = project(st.x, 0, st.z)
          const d = (p.x - sx) * (p.x - sx) + (p.y - sy) * (p.y - sy)
          if (d < bestD) {
            bestD = d
            best = st
          }
        }
        if (best) return { kind: 'stop', id: best.id, name: best.name }
        const g = map.unprojectGround(sx, sy)
        if (!g) return null
        const tol = CORRIDOR_PICK_PX * map.metresPerPixel(sx, sy)
        const incident = nav.incidentAt(g[0], g[1], tol, activeRestrictions(clock.t))
        if (incident) return incident
        if (navMode) return nav.regionAt(g[0], g[1], tol)
        const b = buildings.pick(map.pickRay(sx, sy))
        return b ? { kind: 'building', id: b.info.id, name: b.info.name ?? b.info.id } : null
      }
      const applyHover = (t: Target): void => {
        hover = t
        const g = ground(t)
        ws.traffic.hoverId = t && !g ? t.id : null
        // buildings are clickable everywhere but only marked once clicked; everything else previews on hover
        nav.setHover(g?.kind === 'building' ? null : g)
        const a = nav.anchor(g)
        labels?.set(a ? [a] : [])
        // a crosshair says "choosing an area" for the whole pick; otherwise the pointer marks what can be opened
        canvas.style.cursor = navMode ? 'crosshair' : t && t.kind !== 'building' ? 'pointer' : ''
      }
      const refreshHover = (): void => {
        raf = 0
        if (!last || down) return
        applyHover(targetAt(last.x, last.y))
      }
      const local = (e: PointerEvent): { x: number; y: number } => {
        const r = canvas.getBoundingClientRect()
        return { x: e.clientX - r.left, y: e.clientY - r.top }
      }
      const onMove = (e: PointerEvent): void => {
        last = local(e)
        if (down) {
          if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_PX) {
            if (hover) applyHover(null)
            stopFollowing(map)
          }
          return
        }
        if (!raf) raf = requestAnimationFrame(refreshHover)
      }
      const onLeave = (): void => {
        last = null
        applyHover(null)
      }
      const onDown = (e: PointerEvent): void => {
        if (e.button === 0) down = { x: e.clientX, y: e.clientY }
        else stopFollowing(map)
      }
      const onUp = (e: PointerEvent): void => {
        if (!down) return
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
        down = null
        const p = local(e)
        if (moved > DRAG_PX) {
          if (!raf) raf = requestAnimationFrame(refreshHover)
          return
        }
        const t = targetAt(p.x, p.y)
        applyHover(t)
        if (!t) return
        if (t.kind === 'district' || t.kind === 'corridor') {
          // the pick is made: fly in and close the picker, which also drops the tint and the tag
          if (t.kind === 'district') {
            const cell = nav.cell(t.id)
            if (cell) cameraTo(districtPose(ws.frame.worldToLonLat(cell.x, cell.z), currentPose(map)), 'district')
          } else {
            const shape = nav.corridor(t.id)
            if (shape) cameraTo(corridorPose(shape.axis.map(([x, z]) => ws.frame.worldToLonLat(x, z)), currentPose(map)), 'corridor')
          }
          useStore.getState().setPicking(false)
        } else useStore.getState().select({ kind: t.kind === 'incident' ? 'restriction' : t.kind, id: t.id } as Selection)
      }
      // A drag released off the canvas must not leave hover disarmed.
      const onWindowUp = (): void => {
        if (!down) return
        down = null
        if (!raf) raf = requestAnimationFrame(refreshHover)
      }
      // Escape closes whatever is open (the picker first, then the info bubble); WASD, like a drag, ends an agent follow.
      const onKey = (e: KeyboardEvent): void => {
        const target = e.target instanceof HTMLElement ? e.target : null
        if (e.defaultPrevented || target?.isContentEditable || target?.closest('input, textarea, select')) return
        if (e.key === 'Escape') {
          const s = useStore.getState()
          if (s.picking) s.setPicking(false)
          else s.select(null)
        } else if (!e.ctrlKey && !e.metaKey && !e.altKey && /^Key[WASDEQ]$/.test(e.code) && activeRef.current) stopFollowing(map)
      }
      canvas.addEventListener('pointerdown', onDown)
      canvas.addEventListener('pointerup', onUp)
      canvas.addEventListener('pointermove', onMove)
      canvas.addEventListener('pointerleave', onLeave)
      window.addEventListener('pointerup', onWindowUp)
      window.addEventListener('pointercancel', onWindowUp)
      window.addEventListener('keydown', onKey)

      // --- store -> scene
      let rxKey: string | null = null
      let restrictions: unknown = null
      let corridors: unknown = null
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
        ws.traffic.selectedId = sel && (sel.kind === 'bus' || sel.kind === 'car' || sel.kind === 'person') ? sel.id : null
        ws.traffic.dimOthers = sel?.kind === 'person'
        const scenario = s.scenarios.find((x) => x.scenario_id === s.scenarioId)
        if (scenario?.restrictions !== restrictions) {
          restrictions = scenario?.restrictions
          nav.setIncidents(scenario?.restrictions ?? [])
        }
        if (s.corridors !== corridors) {
          corridors = s.corridors
          nav.setCorridors(s.corridors)
        }
        const mode: NavMode = s.picking && (s.cameraMode === 'district' || s.cameraMode === 'corridor') ? s.cameraMode : null
        if (mode !== navMode) {
          navMode = mode
          nav.setMode(mode)
          if (hover) applyHover(null)
          if (last && !raf) raf = requestAnimationFrame(refreshHover)
        }
        nav.setSelected(selectedGround(sel, nav, buildings))
        marks(ws, overlay, clock.t)
      }
      syncRef.current = sync
      sync()
      ws.simT = clock.t
      const offFrame = clock.onFrame((t) => {
        ws.simT = t
        marks(ws, overlay, t)
      })
      const unsub = useStore.subscribe(sync)

      onWorldReady?.(ws)
      ws.scene.onDisposeObservable.addOnce(() => {
        canvas.removeEventListener('pointerdown', onDown)
        canvas.removeEventListener('pointerup', onUp)
        canvas.removeEventListener('pointermove', onMove)
        canvas.removeEventListener('pointerleave', onLeave)
        window.removeEventListener('pointerup', onWindowUp)
        window.removeEventListener('pointercancel', onWindowUp)
        window.removeEventListener('keydown', onKey)
        window.removeEventListener('resize', onCamera)
        map.off('move', onCamera)
        if (raf) cancelAnimationFrame(raf)
        canvas.style.cursor = ''
        labels?.dispose()
        unsub()
        offFrame()
        unregister()
        nav.dispose()
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
    <>
      <WorldCanvas packId={pack.pack_id} onReady={onReady} onError={onWorldError} quality={side === 'solo' ? 'high' : 'balanced'} className={`world world-${side} bworld`} />
      <div ref={labelsRef} className="nav-labels" aria-hidden="true" />
    </>
  )
}

/** Active closures, ghost proposal and focus corridor for sim time `t`, from the store. */
function marks(ws: WorldScene, overlay: Overlay, t: number): void {
  const s = useStore.getState()
  const scenario = s.scenarios.find((x) => x.scenario_id === s.scenarioId)
  const closed: string[] = []
  for (const r of scenario?.restrictions ?? []) if (t >= r.start_s && t <= r.end_s) closed.push(...r.edge_ids)
  const focusId = s.selection?.kind === 'restriction' ? s.selection.id : null
  const focus = focusId ? scenario?.restrictions.find((r) => r.restriction_id === focusId)?.edge_ids ?? [] : []
  overlay.set({ closed, ghost: s.ghost?.edges ?? [], focus, ghostStops: s.ghost?.stops ?? [] })
  const hazards = [...(scenario?.hazards ?? [])]
  const ghost = s.ghost?.hazard
  if (ghost && !hazards.some((h) => h.track_id === ghost.track_id)) hazards.push(ghost)
  ws.storm.setHazards(hazards)
}
