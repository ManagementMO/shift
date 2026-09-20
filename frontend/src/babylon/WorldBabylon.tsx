import { useCallback, useEffect, useRef } from 'react'
import '@babylonjs/core/Culling/ray'

import type { LiveChannel } from '../live/channel'
import { live, liveClosuresAt } from '../live/session'
import { useStore, type Selection } from '../store'
import type { Restriction } from '../types'
import { corridorPose, currentPose, districtPose } from '../world/camera'
import DevelopmentMarkers from '../world/DevelopmentMarkers'
import { clock } from '../world/playback'
import { cameraTo, registerMap } from '../world/registry'
import type { BuildingIndex } from './buildingIndex'
import { DevelopmentOverlay } from './developments'
import { BabylonSyncMap } from './mapAdapter'
import { CORRIDOR_PICK_PX, NavLabels, NavOverlay, type NavMode, type NavTarget } from './navigation'
import { Overlay } from './overlay'
import { RoadIndex } from './roadIndex'
import type { WorldScene } from './scene'
import type { Kind } from './traffic'
import WorldCanvas from './WorldCanvas'
import './world.css'

const STOP_PICK_PX = 16
const DRAG_PX = 5

/** Whatever is under the pointer: a replayed entity, a stop, an active closure, a picker region, a saved development or a building. */
type Target = { kind: Kind | 'stop' | 'incident' | 'district' | 'corridor' | 'development' | 'building'; id: string; name: string } | null

/** The ground part of a target (what `NavOverlay` draws); null for replayed entities and developments (drawn by `DevelopmentOverlay`). */
function ground(t: Target): NavTarget {
  return t && t.kind !== 'bus' && t.kind !== 'car' && t.kind !== 'person' && t.kind !== 'development' ? { kind: t.kind, id: t.id, name: t.name } : null
}

/** The closures standing in the live city at sim time `t`, named after the street they cover when there is one. */
function closuresAt(t: number): Restriction[] {
  const corridors = useStore.getState().corridors
  return liveClosuresAt(live.session, t, (edges) => Object.values(corridors).find((c) => c.edge_ids.every((e) => edges.includes(e)))?.label ?? null)
}

/** How many road segments a click on a street picks: the segment plus its opposite direction when there is one. */
function pickedRoad(streets: RoadIndex, x: number, z: number): string[] | null {
  const hit = streets.nearest(x, z, 24)
  if (!hit) return null
  const reverse = hit.road.id.startsWith('-') ? hit.road.id.slice(1) : `-${hit.road.id}`
  return streets.byId.has(reverse) ? [hit.road.id, reverse] : [hit.road.id]
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
 * pointer input into hover marks and selections: buildings, saved developments, buses, cars, people, stops and
 * active closures.  While a development is being aimed its ghost follows the cursor and a click places it.
 */
export default function WorldBabylon({ side, active = true, onWorldReady, onWorldError }: { side: 'solo' | 'left' | 'right'; /** false while the globe is shown or the city is still flying in: keyboard travel stays off */ active?: boolean; onWorldReady?: (scene: WorldScene) => void; onWorldError?: (message: string) => void }) {
  const pack = useStore((s) => s.pack)
  const sceneRef = useRef<WorldScene | null>(null)
  const labelsRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef(active)
  const syncRef = useRef<() => void>(() => {})
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
      const developments = new DevelopmentOverlay(ws.scene, ws.frame, ws.city)
      const buildings = ws.buildings
      const nav = new NavOverlay(ws.scene, ws.world, ws.roads, buildings)
      const streets = new RoadIndex(ws.world, (r) => r.allow.includes('car') || r.allow.includes('bus'))
      const unregister = registerMap(side, map)
      if (side !== 'left') {
        // a development branch that loaded before any map was registered still gets its framing
        const pending = useStore.getState().pendingDevelopmentFocus
        if (pending) useStore.getState().focusDevelopment(pending)
      }
      const canvas = ws.canvas
      const project = (x: number, y: number, z: number) => map.projectWorld(x, y, z)
      const labels = labelsRef.current ? new NavLabels(labelsRef.current, project) : null
      const onCamera = (): void => labels?.update()
      map.on('move', onCamera)
      window.addEventListener('resize', onCamera)

      // --- pointer.  Agents, stops and active closures outline on hover and open their info on click.  While a
      // District / Corridor pick is open the regions tint and name themselves on hover and a click flies in and
      // closes the pick.  Buildings never light up on hover, but a click outside a pick opens their info.  While a
      // development is being aimed (this pane leads) the ghost follows the cursor instead and a click places it.
      let down: { x: number; y: number } | null = null
      let last: { x: number; y: number } | null = null
      let hover: Target = null
      let navMode: NavMode = null
      let aiming = false
      let raf = 0
      const groundLonLat = (sx: number, sy: number): [number, number] | null => {
        const g = map.unprojectGround(sx, sy)
        return g ? ws.frame.worldToLonLat(g[0], g[1]) : null
      }
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
        const incident = nav.incidentAt(g[0], g[1], tol, new Set(closuresAt(clock.t).map((r) => r.restriction_id)))
        if (incident) return incident
        if (navMode) return nav.regionAt(g[0], g[1], tol)
        // saved developments are drawn as their own meshes; base buildings come from the prism index
        const dev = ws.scene.pick(sx, sy, (mesh) => !!mesh.metadata?.development_id)
        const devId = dev?.pickedMesh?.metadata?.development_id
        if (devId) return { kind: 'development', id: String(devId), name: String(devId) }
        const b = buildings.pick(map.pickRay(sx, sy))
        return b && !ws.city.isHidden(b.info.id) ? { kind: 'building', id: b.info.id, name: b.info.name ?? b.info.id } : null
      }
      const applyHover = (t: Target): void => {
        hover = t
        const g = ground(t)
        ws.traffic.hoverId = t && !g && t.kind !== 'development' ? t.id : null
        // buildings are clickable everywhere but only marked once clicked; everything else previews on hover
        nav.setHover(g?.kind === 'building' ? null : g)
        const a = nav.anchor(g)
        labels?.set(a ? [a] : [])
        // a crosshair says "choosing an area" or "placing a building"; otherwise the pointer marks what can be opened
        canvas.style.cursor = navMode || aiming ? 'crosshair' : t && t.kind !== 'building' ? 'pointer' : ''
      }
      const refreshHover = (): void => {
        raf = 0
        if (!last || down) return
        if (aiming) {
          // one ground pick per frame at most: the ghost outline follows the cursor
          useStore.getState().setDevelopmentHover(groundLonLat(last.x, last.y))
          if (hover) applyHover(null)
          return
        }
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
        if (aiming) useStore.getState().setDevelopmentHover(null)
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
        const s = useStore.getState()
        if (s.developmentDraft && side !== 'left') {
          // a click lands the footprint (or moves an already placed one); access is checked straight away
          const at = groundLonLat(p.x, p.y)
          if (at) s.placeDevelopment(at)
          else useStore.setState({ developmentError: 'Choose a land surface beside an existing network edge.' })
          return
        }
        const t = targetAt(p.x, p.y)
        if (s.tool === 'closure' && t?.kind !== 'incident') {
          // the Road closures tool is open: a click on a drivable street selects it (both directions) for closing,
          // ahead of any car or person standing on it; an existing closure still opens its card below
          const g = map.unprojectGround(p.x, p.y)
          const edges = g ? pickedRoad(streets, g[0], g[1]) : null
          if (edges) {
            live.discard()
            s.setGhost({ edges, stops: [], hazard: null })
            return
          }
        }
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
        } else if (t.kind === 'incident') {
          // the closure's card opens where it was clicked, not at the corridor's centre
          const g = map.unprojectGround(p.x, p.y)
          useStore.getState().select({ kind: 'restriction', id: t.id, at: g ? ws.frame.worldToLonLat(g[0], g[1]) : undefined })
        } else useStore.getState().select({ kind: t.kind, id: t.id } as Selection)
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

      // --- store + live session -> scene
      let attached: LiveChannel | null | undefined
      let closureKey = ''
      let corridors: unknown = null
      const sync = (): void => {
        const s = useStore.getState()
        const channel = live.getSnapshot().primary
        if (attached !== channel) {
          attached = channel
          // frames from another city's network would put people on the wrong streets
          const compatible = !channel || channel.state.network_fingerprint === ws.world.network_fingerprint
          ws.traffic.setLiveSource(compatible ? channel : null)
          if (channel && !compatible) s.setError('This recording uses a different city network. Open its matching city pack.')
        }
        const sel = s.selection
        ws.traffic.selectedId = sel && (sel.kind === 'bus' || sel.kind === 'car' || sel.kind === 'person') ? sel.id : null
        ws.traffic.dimOthers = sel?.kind === 'person'
        const closures = closuresAt(clock.t)
        const key = closures.map((r) => `${r.restriction_id}:${r.edge_ids.length}`).join('|')
        if (key !== closureKey) {
          closureKey = key
          nav.setIncidents(closures)
        }
        if (s.corridors !== corridors) {
          corridors = s.corridors
          nav.setCorridors(s.corridors)
        }
        const mode: NavMode = s.picking && (s.cameraMode === 'district' || s.cameraMode === 'corridor') ? s.cameraMode : null
        const aim = side !== 'left' && !!s.developmentDraft && !s.developmentPlaced
        if (mode !== navMode || aim !== aiming) {
          navMode = mode
          aiming = aim
          nav.setMode(mode)
          applyHover(null)
          if (last && !raf) raf = requestAnimationFrame(refreshHover)
        }
        nav.setSelected(selectedGround(sel, nav, buildings))
        marks(ws, overlay, developments, clock.t, side)
      }
      syncRef.current = sync
      sync()
      ws.simT = clock.t
      const offFrame = clock.onFrame((t) => {
        ws.simT = t
        marks(ws, overlay, developments, t, side)
      })
      const unsub = useStore.subscribe(sync)
      const unsubLive = live.subscribe(sync)

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
        unsubLive()
        offFrame()
        unregister()
        nav.dispose()
        developments.dispose()
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
      <DevelopmentMarkers side={side} />
    </>
  )
}

/** Standing closures, the tool's aim, the focused closure and the developments of the live city at sim time `t`. */
function marks(ws: WorldScene, overlay: Overlay, developments: DevelopmentOverlay, t: number, side: string): void {
  const s = useStore.getState()
  const view = live.getSnapshot()
  const closures = closuresAt(t)
  const closed = closures.flatMap((r) => r.edge_ids)
  // a selected closure is outlined by the navigation overlay; its barricades stay visible, so no focus ribbon here
  const focus: string[] = []
  const change = view.draft?.intervention
  // a previewed closure / reopening ghosts its streets; otherwise the streets picked for the Road closures tool
  const ghost = change?.kind === 'close_road' || change?.kind === 'reopen_road' ? change.edge_ids : s.ghost?.edges ?? []
  const access = change?.kind === 'development' ? view.draft?.access?.map((a) => a.edge_id) ?? [] : []
  overlay.set({ closed, ghost: side === 'left' ? [] : [...ghost, ...access], focus, ghostStops: side === 'left' ? [] : s.ghost?.stops ?? [] })
  const draft = side !== 'left' ? s.developmentDraft : null
  developments.set({ developments: view.primary?.state.developments ?? [], draft, placed: s.developmentPlaced,
    ghostPosition: draft ? s.developmentPlaced ? draft.position : s.developmentHover : null, invalidDraft: !!s.developmentError && s.developmentPlaced,
    focusedId: s.selection?.kind === 'development' ? s.selection.id : null, zones: s.pack?.zones ?? [], t })
  ws.storm.setHazards(s.ghost?.hazard ? [s.ghost.hazard] : [])
}
