import { useCallback, useEffect, useRef } from 'react'

import { useStore } from '../store'
import { clock } from '../world/playback'
import { registerMap } from '../world/registry'
import { BabylonSyncMap } from './mapAdapter'
import { Overlay } from './overlay'
import type { WorldScene } from './scene'
import WorldCanvas from './WorldCanvas'
import './world.css'

const STOP_PICK_PX = 16
const DRAG_PX = 5

/**
 * Drop-in for `WorldMap`: the Babylon miniature Toronto driven by the same store, clock and shell.  Registers a
 * `SyncMap` adapter so camera modes, the agent bubble and compare sync work unchanged.
 */
export default function WorldBabylon({ runId, side }: { runId: string | null; side: 'solo' | 'left' | 'right' }) {
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
      const unregister = registerMap(side, map)

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
        marks(overlay, clock.t)
      }
      syncRef.current = sync
      sync()
      ws.simT = clock.t
      const offFrame = clock.onFrame((t) => {
        ws.simT = t
        marks(overlay, t)
      })
      const unsub = useStore.subscribe(sync)

      // Click (not drag) selects the nearest drawn traveller / vehicle, else the nearest stop.
      const canvas = ws.canvas
      let down: { x: number; y: number } | null = null
      const onDown = (e: PointerEvent): void => {
        if (e.button === 0) down = { x: e.clientX, y: e.clientY }
      }
      const onUp = (e: PointerEvent): void => {
        if (!down) return
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y)
        down = null
        if (moved > DRAG_PX) return
        const r = canvas.getBoundingClientRect()
        const sx = e.clientX - r.left
        const sy = e.clientY - r.top
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

      ws.scene.onDisposeObservable.addOnce(() => {
        canvas.removeEventListener('pointerdown', onDown)
        canvas.removeEventListener('pointerup', onUp)
        unsub()
        offFrame()
        unregister()
        overlay.dispose()
        map.dispose()
        syncRef.current = () => {}
        if (sceneRef.current === ws) sceneRef.current = null
        if (window.__cityshift?.babylon === ws) window.__cityshift.babylon = undefined
      })
    },
    [side],
  )

  if (!pack) return <div className={`world world-${side} bworld`} />
  return <WorldCanvas packId={pack.pack_id} onReady={onReady} className={`world world-${side} bworld`} />
}

/** Active closures, ghost proposal and focus corridor for sim time `t`, from the store. */
function marks(overlay: Overlay, t: number): void {
  const s = useStore.getState()
  const scenario = s.scenarios.find((x) => x.scenario_id === s.scenarioId)
  const closed: string[] = []
  for (const r of scenario?.restrictions ?? []) if (t >= r.start_s && t <= r.end_s) closed.push(...r.edge_ids)
  const focusId = s.selection?.kind === 'restriction' ? s.selection.id : null
  const focus = focusId ? scenario?.restrictions.find((r) => r.restriction_id === focusId)?.edge_ids ?? [] : []
  overlay.set({ closed, ghost: s.ghost?.edges ?? [], focus, ghostStops: s.ghost?.stops ?? [] })
}
