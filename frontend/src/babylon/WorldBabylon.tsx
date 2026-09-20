import { useCallback, useEffect, useRef } from 'react'
import '@babylonjs/core/Culling/ray'

import { useStore } from '../store'
import { scenarioForView } from '../development'
import DevelopmentMarkers from '../world/DevelopmentMarkers'
import { clock } from '../world/playback'
import { registerMap } from '../world/registry'
import { BabylonSyncMap } from './mapAdapter'
import { Overlay } from './overlay'
import { DevelopmentOverlay } from './developments'
import type { WorldScene } from './scene'
import WorldCanvas from './WorldCanvas'
import './world.css'

const STOP_PICK_PX = 16
const DRAG_PX = 5

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
      const developments = new DevelopmentOverlay(ws.scene, ws.frame)
      const unregister = registerMap(side, map)
      if (side !== 'left') {
        const pending = useStore.getState().pendingDevelopmentFocus
        if (pending) useStore.getState().focusDevelopment(pending)
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
        ws.traffic.selectedId = sel && ['bus', 'car', 'person'].includes(sel.kind)
          ? sel.kind === 'person' && rx?.bundle.compile?.mode_assignment[sel.id] === 'car' ? `car_${sel.id}` : sel.id : null
        ws.traffic.dimOthers = sel?.kind === 'person'
        ws.canvas.style.cursor = s.developmentDraft && side !== 'left' ? 'crosshair' : 'default'
        marks(overlay, developments, clock.t, runIdRef.current, side)
      }
      syncRef.current = sync
      sync()
      ws.simT = clock.t
      const offFrame = clock.onFrame((t) => {
        ws.simT = t
        marks(overlay, developments, t, runIdRef.current, side)
      })
      const unsub = useStore.subscribe(sync)

      // Click (not drag) selects the nearest drawn traveller / vehicle, else the nearest stop.
      const canvas = ws.canvas
      let down: { x: number; y: number } | null = null
      const onDown = (e: PointerEvent): void => {
        if (e.button === 0) down = { x: e.clientX, y: e.clientY }
      }
      // While a building is being aimed, its ghost follows the cursor over the ground (one pick per frame at most).
      let hoverRaf = 0
      let hoverAt: { x: number; y: number } | null = null
      const groundAt = (sx: number, sy: number): [number, number] | null => {
        const ground = ws.scene.pick(sx, sy, (mesh) => mesh === ws.city.ground)
        return ground?.pickedPoint ? ws.frame.worldToLonLat(ground.pickedPoint.x, ground.pickedPoint.z) : null
      }
      const onMove = (e: PointerEvent): void => {
        const state = useStore.getState()
        if (!state.developmentDraft || state.developmentPlaced || side === 'left') return
        const r = canvas.getBoundingClientRect()
        hoverAt = { x: e.clientX - r.left, y: e.clientY - r.top }
        if (hoverRaf) return
        hoverRaf = requestAnimationFrame(() => {
          hoverRaf = 0
          if (hoverAt) useStore.getState().setDevelopmentHover(groundAt(hoverAt.x, hoverAt.y))
        })
      }
      const onLeave = (): void => {
        hoverAt = null
        useStore.getState().setDevelopmentHover(null)
      }
      const onUp = (e: PointerEvent): void => {
        if (!down) return
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
        down = null
        if (moved > DRAG_PX) return
        const r = canvas.getBoundingClientRect()
        const sx = e.clientX - r.left
        const sy = e.clientY - r.top
        const state = useStore.getState()
        if (state.developmentDraft && side !== 'left') {
          const at = groundAt(sx, sy)
          if (at) state.placeDevelopment(at)
          else useStore.setState({ developmentError: 'Choose a land surface beside an existing network edge.' })
          return
        }
        const building = ws.scene.pick(sx, sy, (mesh) => !!mesh.metadata?.development_id)
        if (building?.pickedMesh?.metadata?.development_id) {
          state.setTool('development')
          state.select({ kind: 'development', id: building.pickedMesh.metadata.development_id })
          return
        }
        const project = (x: number, y: number, z: number) => map.projectWorld(x, y, z)
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
        if (best) useStore.getState().select({ kind: 'stop', id: best })
      }
      canvas.addEventListener('pointerdown', onDown)
      canvas.addEventListener('pointerup', onUp)
      canvas.addEventListener('pointermove', onMove)
      canvas.addEventListener('pointerleave', onLeave)

      onWorldReady?.(ws)
      ws.scene.onDisposeObservable.addOnce(() => {
        canvas.removeEventListener('pointerdown', onDown)
        canvas.removeEventListener('pointerup', onUp)
        canvas.removeEventListener('pointermove', onMove)
        canvas.removeEventListener('pointerleave', onLeave)
        if (hoverRaf) cancelAnimationFrame(hoverRaf)
        unsub()
        offFrame()
        unregister()
        overlay.dispose()
        developments.dispose()
        map.dispose()
        syncRef.current = () => {}
        if (sceneRef.current === ws) sceneRef.current = null
        if (window.__cityshift?.babylon === ws) window.__cityshift.babylon = undefined
      })
    },
    [side, onWorldReady],
  )

  if (!pack) return <div className={`world world-${side} bworld`} />
  return <div className={`world world-${side} bworld`}>
    <WorldCanvas packId={pack.pack_id} onReady={onReady} onError={onWorldError} quality={side === 'solo' ? 'high' : 'balanced'} />
    <DevelopmentMarkers runId={runId} side={side} />
  </div>
}

/** Active closures, ghost proposal and focus corridor for sim time `t`, from the store. */
function marks(overlay: Overlay, developments: DevelopmentOverlay, t: number, runId: string | null, side: string): void {
  const s = useStore.getState()
  const bundle = runId ? s.replays[runId]?.bundle ?? null : null
  const scenario = scenarioForView(s.scenarios, s.scenarioId, bundle, side)
  const closed: string[] = []
  for (const r of scenario?.restrictions ?? []) if (t >= r.start_s && t <= r.end_s) closed.push(...r.edge_ids)
  const focusId = s.selection?.kind === 'restriction' ? s.selection.id : null
  const focus = focusId ? scenario?.restrictions.find((r) => r.restriction_id === focusId)?.edge_ids ?? [] : []
  const draft = side !== 'left' ? s.developmentDraft : null
  const access = draft && s.developmentPlaced ? s.developmentPreview?.development.access.map((a) => a.edge_id) ?? [] : []
  overlay.set({ closed, ghost: side === 'left' ? [] : [...(s.ghost?.edges ?? []), ...access], focus, ghostStops: side === 'left' ? [] : s.ghost?.stops ?? [] })
  developments.set({ developments: scenario?.developments ?? [], draft, placed: s.developmentPlaced,
    ghostPosition: draft ? s.developmentPlaced ? draft.position : s.developmentHover : null, invalidDraft: !!s.developmentError && s.developmentPlaced,
    focusedId: s.selection?.kind === 'development' ? s.selection.id : null, zones: s.pack?.zones ?? [], t })
}
