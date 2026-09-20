/**
 * Scenario marks drawn over the static city: closed edges (active restriction), ghost edges / stops of an
 * unconfirmed proposal, and focus corridors.  Rebuilt only when the set of marked ids changes.
 */

import { Constants } from '@babylonjs/core/Engines/constants'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import type { Scene } from '@babylonjs/core/scene'

import type { HazardDraft, HazardTrack } from '../types'
import { hex, meshFromBatch, vertexColorMaterial, Y } from './city'
import type { WorldFrame } from './coords'
import { Batch, type RGB } from './geometry'
import type { RoadIndex } from './roadIndex'

export const MARK: Record<'closed' | 'ghost' | 'focus' | 'ghostStop' | 'hazard' | 'hover', RGB> = {
  closed: hex('#d7263d'),
  ghost: hex('#22b8cf'),
  focus: hex('#eca840'),
  ghostStop: hex('#22b8cf'),
  hazard: hex('#d97732'),
  hover: hex('#ffffff'),
}

export interface Marks {
  closed: Iterable<string>
  ghost: Iterable<string>
  focus: Iterable<string>
  ghostStops: { lon: number; lat: number }[]
  hazards?: HazardTrack[]
  ghostHazard?: HazardTrack | null
  sketch?: HazardDraft | null
  /** Weather event under the pointer: outlined bright so it reads as clickable/draggable. */
  hoverHazard?: HazardTrack | null
  /** The unconfirmed draft is under the pointer. */
  hoverSketch?: boolean
  /** Placement cursor: the footprint (or next corner) that a click would drop where the pointer is. */
  cursor?: CursorGhost | null
}

export type CursorGhost =
  | { kind: 'circle'; x: number; z: number; radius: number }
  | { kind: 'corner'; x: number; z: number; from: [number, number] | null; close: [number, number] | null }
  | { kind: 'ring'; ring: number[] }

function circleRing(x: number, z: number, r: number, segments = 64): number[] {
  return Array.from({ length: segments + 1 }, (_, i) => {
    const a = (i / segments) * Math.PI * 2
    return [x + Math.cos(a) * r, z + Math.sin(a) * r]
  }).flat()
}

const Y_MARK = Y.junction + 0.08

export class Overlay {
  private readonly scene: Scene
  private readonly roads: RoadIndex
  private readonly frame: WorldFrame
  private readonly mat: StandardMaterial
  private readonly zoneMat: StandardMaterial
  private mesh: Mesh | null = null
  private zoneFill: Mesh | null = null
  private zoneOutline: Mesh | null = null
  private key = ''

  constructor(scene: Scene, roads: RoadIndex, frame: WorldFrame) {
    this.scene = scene
    this.roads = roads
    this.frame = frame
    // Marks are UI, not scenery: unlit so they render their exact colours under any sun, fade or tone mapping.
    this.mat = vertexColorMaterial('overlay-mat', scene, 0)
    this.mat.disableLighting = true
    this.mat.ambientColor.set(0, 0, 0)
    this.mat.emissiveColor.set(1, 1, 1)
    this.mat.depthFunction = Constants.ALWAYS
    this.zoneMat = vertexColorMaterial('hazard-fill-mat', scene, 0)
    this.zoneMat.disableLighting = true
    this.zoneMat.ambientColor.set(0, 0, 0)
    this.zoneMat.emissiveColor.set(1, 1, 1)
    this.zoneMat.alpha = 0.22
    this.zoneMat.disableDepthWrite = true
    this.zoneMat.depthFunction = Constants.ALWAYS
  }

  set(m: Marks): void {
    const closed = [...new Set(m.closed)].sort()
    const ghost = [...new Set(m.ghost)].sort()
    const focus = [...new Set(m.focus)].sort()
    const key = JSON.stringify([closed, ghost, focus, m.ghostStops, m.hazards ?? [], m.ghostHazard ?? null, m.sketch ?? null, m.hoverHazard?.track_id ?? null, !!m.hoverSketch, m.cursor ?? null])
    if (key === this.key) return
    this.key = key
    this.mesh?.dispose()
    this.zoneFill?.dispose()
    this.zoneOutline?.dispose()
    this.mesh = this.zoneFill = this.zoneOutline = null
    const b = new Batch()
    const drawn = new Set<string>()
    const edges = (ids: string[], c: RGB, extra: number, lift: number): void => {
      for (const id of ids) {
        if (drawn.has(id)) continue
        drawn.add(id)
        const r = this.roads.byId.get(id)
        if (r) b.ribbon(r.shape, r.w + extra, Y_MARK + lift, c)
      }
    }
    edges(focus, MARK.focus, 1.5, 0.08)
    edges(ghost, MARK.ghost, 2.5, 0.04)
    edges(closed, MARK.closed, 2.5, 0)
    for (const s of m.ghostStops) {
      const [x, z] = this.frame.lonLatToWorld(s.lon, s.lat)
      b.disc(x, z, 5, Y.stop + 0.05, MARK.ghostStop, 16)
    }
    if (b.vertexCount) {
      this.mesh = meshFromBatch('overlay', b, this.scene, this.mat)
      this.mesh.renderingGroupId = 1
    }
    const fill = new Batch()
    const outline = new Batch()
    // Applied events draw their own weather and nothing else: no boundary ring. Only the unconfirmed preview is
    // outlined (cyan), and whatever is under the pointer gets the hover ring below.
    if (m.ghostHazard) {
      for (const ring of (m.ghostHazard.footprint ?? []).map((r) => r.flatMap(([lon, lat]) => this.frame.lonLatToWorld(lon, lat)))) {
        outline.ribbon(ring, 3.5, Y_MARK + 0.04, MARK.ghost)
      }
    }
    // Placement guide (before the backend resolves the exact footprint): drawn-area corners, a circle, or a swept corridor.
    if (m.sketch?.kind !== 'fire' && m.sketch?.shape === 'polygon' && m.sketch.waypoints.length) {
      const points = m.sketch.waypoints.map(([lon, lat]) => this.frame.lonLatToWorld(lon, lat))
      const color = m.hoverSketch ? MARK.hover : MARK.ghost
      const closed = points.length >= 3
      const path = (closed ? [...points, points[0]] : points).flat()
      if (points.length > 1) outline.ribbon(path, m.hoverSketch ? 7 : 2.5, Y_MARK + (m.hoverSketch ? 0.06 : 0.04), color)
      if (!closed) for (const [x, z] of points) outline.disc(x, z, 4, Y_MARK + 0.05, color, 16)
    } else if (m.sketch?.kind !== 'fire' && m.sketch?.waypoints.length && Number.isFinite(m.sketch.radius_m) && m.sketch.radius_m > 0) {
      const points = m.sketch.waypoints.map(([lon, lat]) => this.frame.lonLatToWorld(lon, lat))
      fill.ribbon(points.flat(), m.sketch.radius_m * 2, Y_MARK + 0.02, MARK.ghost)
      outline.ribbon(points.flat(), 2, Y_MARK + 0.04, MARK.ghost)
      for (const [x, z] of points) {
        fill.disc(x, z, m.sketch.radius_m, Y_MARK + 0.02, MARK.ghost, 64)
        outline.disc(x, z, 5, Y_MARK + 0.04, MARK.ghost, 16)
        const ring = Array.from({ length: 65 }, (_, i) => {
          const angle = i * Math.PI / 32
          return [x + Math.cos(angle) * m.sketch!.radius_m, z + Math.sin(angle) * m.sketch!.radius_m]
        }).flat()
        outline.ribbon(ring, m.hoverSketch ? 7 : 2, Y_MARK + (m.hoverSketch ? 0.06 : 0.04), m.hoverSketch ? MARK.hover : MARK.ghost)
      }
    }
    // Placement cursor: a bright outline of what a click would drop here, following the pointer.
    const cursor = m.cursor
    if (cursor?.kind === 'circle' && Number.isFinite(cursor.radius) && cursor.radius > 0) {
      fill.disc(cursor.x, cursor.z, cursor.radius, Y_MARK + 0.03, MARK.ghost, 64)
      outline.ribbon(circleRing(cursor.x, cursor.z, cursor.radius), 3, Y_MARK + 0.07, MARK.ghost)
      outline.disc(cursor.x, cursor.z, 4, Y_MARK + 0.07, MARK.ghost, 16)
    } else if (cursor?.kind === 'ring' && cursor.ring.length >= 6) {
      fill.polygon(cursor.ring, [], Y_MARK + 0.03, MARK.ghost)
      outline.ribbon([...cursor.ring, cursor.ring[0], cursor.ring[1]], 3, Y_MARK + 0.07, MARK.ghost)
    } else if (cursor?.kind === 'corner') {
      outline.disc(cursor.x, cursor.z, 4.5, Y_MARK + 0.07, MARK.ghost, 16)
      if (cursor.from) outline.ribbon([cursor.from[0], cursor.from[1], cursor.x, cursor.z], 2.5, Y_MARK + 0.07, MARK.ghost)
      if (cursor.close) outline.ribbon([cursor.x, cursor.z, cursor.close[0], cursor.close[1]], 1.2, Y_MARK + 0.07, MARK.ghost)
    }
    // Hover outline: a wide bright ring around the event under the pointer, drawn above every other mark.
    if (m.hoverHazard) {
      for (const ring of (m.hoverHazard.footprint ?? []).map((r) => r.flatMap(([lon, lat]) => this.frame.lonLatToWorld(lon, lat)))) {
        if (ring.length >= 6 && ring.every(Number.isFinite)) outline.ribbon(ring, 7, Y_MARK + 0.06, MARK.hover)
      }
    }
    if (fill.vertexCount) {
      this.zoneFill = meshFromBatch('hazard-fill', fill, this.scene, this.zoneMat)
      this.zoneFill.renderingGroupId = 1
    }
    if (outline.vertexCount) {
      this.zoneOutline = meshFromBatch('hazard-outline', outline, this.scene, this.mat)
      this.zoneOutline.renderingGroupId = 1
    }
  }

  dispose(): void {
    this.mesh?.dispose()
    this.zoneFill?.dispose()
    this.zoneOutline?.dispose()
    this.mat.dispose()
    this.zoneMat.dispose()
  }
}
