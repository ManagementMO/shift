/**
 * Orange marks on the city.  Two sources: the District / Corridor pickers (while one is open the regions are
 * outlined and the one under the pointer is tinted and named), and clicks on the things that carry info —
 * a stop's ring, a closure's ribbon, a building's roof caps and footprint edge.  Buses, cars and people are
 * marked by `Traffic` instead.  Meshes are rebuilt only when the mode, hover or selection changes.
 */

import { Color3 } from '@babylonjs/core/Maths/math.color'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { Scene } from '@babylonjs/core/scene'

import type { Corridor } from '../types'
import type { BuildingIndex } from './buildingIndex'
import { hex, meshFromBatch, Y } from './city'
import { Batch, type RGB } from './geometry'
import { corridorShapes, districtSites, nearestCorridor, nearestSite, voronoiCells, type CorridorShape, type DistrictCell } from './regions'
import type { RoadIndex } from './roadIndex'
import type { WorldData, WorldStop } from './worldData'

/** Which picker is open, if any. */
export type NavMode = 'district' | 'corridor' | null

/**
 * A ground target: hovered or clicked.  Districts and corridors exist only while their picker is open;
 * incidents are a scenario's active restrictions (closures).  Entities are marked by `Traffic`.
 */
export type NavTarget = { kind: 'district' | 'corridor' | 'stop' | 'incident' | 'building'; id: string; name: string } | null

/** The meshes of one orange mark: translucent caps / floor, dark edge band, orange edge. */
interface Mark {
  fill: Mesh | null
  under: Mesh | null
  line: Mesh | null
}

/** Pointer tolerance around a corridor's or closed street's centre-line, CSS px. */
export const CORRIDOR_PICK_PX = 18

export const HOVER: RGB = hex('#f5891f')
/** Light marks sit on dark asphalt (corridors); dark marks sit on the pale pavement (district edges). */
const LIGHT: RGB = hex('#eeede9')
const DARK: RGB = hex('#141414')
/** Above every scenario mark the `Overlay` draws, so navigation never z-fights closures or ghosts. */
const Y_NAV = Y.junction + 0.3
const OUTLINE_W = 6
const HOVER_OUTLINE_W = 6
const HOVER_OUTLINE_UNDER_W = 14
const CORRIDOR_EXTRA = 3
const HOVER_CORRIDOR_EXTRA = 6
const STOP_RING_R = 9
/** Above the drawn roof and its parapet (`architecture.ts` adds 0.65 m), below the rooftop plant. */
const CAP_LIFT = 0.9

/** Vertex colours drawn as-is: overlay marks read as interface, not as lit geometry. */
function unlit(name: string, scene: Scene, alpha: number): StandardMaterial {
  const m = new StandardMaterial(name, scene)
  m.disableLighting = true
  m.emissiveColor = Color3.White()
  m.ambientColor = Color3.Black()
  m.diffuseColor = Color3.Black()
  m.specularColor = Color3.Black()
  m.alpha = alpha
  return m
}

export class NavOverlay {
  readonly cells: DistrictCell[]
  private shapes: CorridorShape[] = []
  private incidents: CorridorShape[] = []
  private readonly scene: Scene
  private readonly world: WorldData
  private readonly roads: RoadIndex
  private readonly buildings: BuildingIndex
  private readonly baseMat: StandardMaterial
  private readonly fillMat: StandardMaterial
  private readonly lineMat: StandardMaterial
  private base: Mesh | null = null
  private hoverMark: Mark = { fill: null, under: null, line: null }
  private selectedMark: Mark = { fill: null, under: null, line: null }
  private mode: NavMode = null
  private hover: NavTarget = null
  private selected: NavTarget = null

  constructor(scene: Scene, world: WorldData, roads: RoadIndex, buildings: BuildingIndex) {
    this.scene = scene
    this.world = world
    this.roads = roads
    this.buildings = buildings
    this.cells = voronoiCells(districtSites(world), world.crs.bounds_world)
    this.baseMat = unlit('nav-base', scene, 0.7)
    this.fillMat = unlit('nav-fill', scene, 0.5)
    this.lineMat = unlit('nav-line', scene, 1)
  }

  setCorridors(corridors: Record<string, Corridor>): void {
    this.shapes = corridorShapes(corridors, this.roads.byId)
    if (this.mode === 'corridor') this.rebuildBase()
  }

  /** The scenario's restrictions, resolved to roads once; which of them count as incidents depends on the clock. */
  setIncidents(restrictions: { restriction_id: string; label: string; edge_ids: string[] }[]): void {
    this.incidents = corridorShapes(Object.fromEntries(restrictions.map((r) => [r.restriction_id, { label: r.label, edge_ids: r.edge_ids }])), this.roads.byId)
  }

  /** Open or close a picker: its regions are outlined faintly; region marks of another mode are dropped. */
  setMode(mode: NavMode): void {
    if (mode === this.mode) return
    this.mode = mode
    this.rebuildBase()
    const stale = (t: NavTarget) => t && (t.kind === 'district' || t.kind === 'corridor') && t.kind !== mode
    if (stale(this.hover)) this.setHover(null)
    if (stale(this.selected)) this.setSelected(null)
  }

  /** The target under the pointer: marked while the pointer stays, unless it is already the selected one. */
  setHover(hover: NavTarget): void {
    if (sameTarget(hover, this.hover)) return
    this.hover = hover
    this.hoverMark = this.rebuildMark(this.hoverMark, sameTarget(hover, this.selected) ? null : hover, 'hover')
  }

  /** The clicked target: its mark stays until something else is chosen. */
  setSelected(selected: NavTarget): void {
    if (sameTarget(selected, this.selected)) return
    this.selected = selected
    this.selectedMark = this.rebuildMark(this.selectedMark, selected, 'selected')
    if (sameTarget(selected, this.hover)) this.hoverMark = this.rebuildMark(this.hoverMark, null, 'hover')
  }

  private rebuildMark(mark: Mark, target: NavTarget, name: string): Mark {
    mark.fill?.dispose()
    mark.under?.dispose()
    mark.line?.dispose()
    const out: Mark = { fill: null, under: null, line: null }
    if (!target) return out
    const fill = new Batch()
    const under = new Batch()
    const line = new Batch()
    if (target.kind === 'district') {
      const cell = this.cell(target.id)
      if (cell) {
        // a tinted floor with a two-tone edge: the dark band keeps the edge legible where it crosses pavement
        fill.polygon(cell.ring, undefined, Y_NAV - 0.04, HOVER)
        under.ribbon(closed(cell.ring), HOVER_OUTLINE_UNDER_W, Y_NAV + 0.04, DARK)
        line.ribbon(closed(cell.ring), HOVER_OUTLINE_W, Y_NAV + 0.08, HOVER)
      }
    } else if (target.kind === 'corridor' || target.kind === 'incident') {
      const shape = target.kind === 'corridor' ? this.corridor(target.id) : this.incident(target.id)
      for (const r of shape?.roads ?? []) line.ribbon(r.shape, r.w + HOVER_CORRIDOR_EXTRA, Y_NAV + 0.04, HOVER)
    } else if (target.kind === 'building') {
      // roof caps on every section plus a two-tone edge around each footprint on the ground
      for (const p of this.buildings.building(target.id)?.prisms ?? []) {
        for (const roof of p.roofs) fill.polygon(roof.ring, roof.holes, p.y1 + CAP_LIFT, HOVER)
        under.ribbon(closed(p.ring), HOVER_OUTLINE_UNDER_W - 3, Y_NAV + 0.04, DARK)
        line.ribbon(closed(p.ring), HOVER_OUTLINE_W - 1, Y_NAV + 0.08, HOVER)
      }
    } else {
      const stop = this.stop(target.id)
      if (stop) line.annulus(stop.x, stop.z, STOP_RING_R, 1.6, Y.stop + 0.1, HOVER, 32)
    }
    if (fill.vertexCount) out.fill = meshFromBatch(`nav-${name}-fill`, fill, this.scene, this.fillMat)
    if (under.vertexCount) out.under = meshFromBatch(`nav-${name}-under`, under, this.scene, this.baseMat)
    if (line.vertexCount) out.line = meshFromBatch(`nav-${name}-line`, line, this.scene, this.lineMat)
    return out
  }

  /** Where a region's name tag sits: the district centre, or a point on the corridor near its middle. */
  anchor(target: NavTarget): NavLabelItem | null {
    if (target?.kind === 'district') {
      const c = this.cell(target.id)
      return c ? { id: c.id, name: c.name, x: c.x, z: c.z } : null
    }
    if (target?.kind === 'corridor') {
      const s = this.corridor(target.id)
      return s ? { id: s.id, name: s.name, ...midpointOn(s) } : null
    }
    return null
  }

  cell(id: string): DistrictCell | undefined {
    return this.cells.find((c) => c.id === id)
  }

  corridor(id: string): CorridorShape | undefined {
    return this.shapes.find((s) => s.id === id)
  }

  incident(id: string): CorridorShape | undefined {
    return this.incidents.find((s) => s.id === id)
  }

  stop(id: string): WorldStop | undefined {
    return this.world.stops.find((s) => s.id === id)
  }

  /** The region of the open picker under a ground point; `tol` is the corridor pick distance in metres. */
  regionAt(x: number, z: number, tol: number): NavTarget {
    const [x0, z0, x1, z1] = this.world.crs.bounds_world
    if (x < x0 || x > x1 || z < z0 || z > z1) return null
    if (this.mode === 'district') {
      const cell = nearestSite(this.cells, x, z)
      return cell ? { kind: 'district', id: cell.id, name: cell.name } : null
    }
    if (this.mode === 'corridor') {
      const shape = nearestCorridor(this.shapes, x, z, tol)
      return shape ? { kind: 'corridor', id: shape.id, name: shape.name } : null
    }
    return null
  }

  /** The active restriction (one of `activeIds`) whose closed edges pass within `tol` metres of a ground point. */
  incidentAt(x: number, z: number, tol: number, activeIds: ReadonlySet<string>): NavTarget {
    const shape = nearestCorridor(this.incidents.filter((s) => activeIds.has(s.id)), x, z, tol)
    return shape ? { kind: 'incident', id: shape.id, name: shape.name } : null
  }

  private rebuildBase(): void {
    this.base?.dispose()
    this.base = null
    const b = new Batch()
    if (this.mode === 'district') for (const c of this.cells) b.ribbon(closed(c.ring), OUTLINE_W, Y_NAV, DARK)
    else if (this.mode === 'corridor') for (const s of this.shapes) for (const r of s.roads) b.ribbon(r.shape, r.w + CORRIDOR_EXTRA, Y_NAV, LIGHT)
    if (b.vertexCount) this.base = meshFromBatch('nav-base', b, this.scene, this.baseMat)
  }

  dispose(): void {
    this.base?.dispose()
    for (const m of [this.hoverMark, this.selectedMark]) {
      m.fill?.dispose()
      m.under?.dispose()
      m.line?.dispose()
    }
    this.baseMat.dispose()
    this.fillMat.dispose()
    this.lineMat.dispose()
  }
}

function sameTarget(a: NavTarget, b: NavTarget): boolean {
  return a === b || (!!a && !!b && a.kind === b.kind && a.id === b.id)
}

/** A ring as a polyline that returns to its first vertex, so a ribbon along it closes. */
function closed(ring: number[]): number[] {
  return ring.length >= 4 ? [...ring, ring[0], ring[1]] : ring
}

/** The corridor vertex nearest the middle of its axis: a label anchor that sits on the street, even on a curve. */
function midpointOn(shape: CorridorShape): { x: number; z: number } {
  const mx = (shape.axis[0][0] + shape.axis[1][0]) / 2
  const mz = (shape.axis[0][1] + shape.axis[1][1]) / 2
  let best = { x: mx, z: mz }
  let bestD = Infinity
  for (const r of shape.roads) {
    for (let i = 0; i + 1 < r.shape.length; i += 2) {
      const d = (r.shape[i] - mx) ** 2 + (r.shape[i + 1] - mz) ** 2
      if (d < bestD) {
        bestD = d
        best = { x: r.shape[i], z: r.shape[i + 1] }
      }
    }
  }
  return best
}

export interface NavLabelItem {
  id: string
  name: string
  x: number
  z: number
}

/**
 * Name tag floating over the hovered picker region (a district centre, a point on a corridor).  Plain DOM
 * positioned from the world projection; nothing here is interactive — the ground underneath takes the click.
 */
export class NavLabels {
  private readonly root: HTMLElement
  private readonly project: (x: number, y: number, z: number) => { x: number; y: number }
  private items: NavLabelItem[] = []
  private nodes = new Map<string, HTMLElement>()

  constructor(root: HTMLElement, project: (x: number, y: number, z: number) => { x: number; y: number }) {
    this.root = root
    this.project = project
  }

  set(items: NavLabelItem[]): void {
    this.items = items
    for (const [id, node] of this.nodes) if (!items.some((i) => i.id === id)) {
      node.remove()
      this.nodes.delete(id)
    }
    for (const item of items) {
      let node = this.nodes.get(item.id)
      if (!node) {
        node = document.createElement('div')
        node.className = 'nav-label'
        this.root.append(node)
        this.nodes.set(item.id, node)
      }
      node.textContent = item.name
    }
    this.update()
  }

  /** Re-place every label from the current camera; labels off the canvas are hidden. */
  update(): void {
    const w = this.root.clientWidth
    const h = this.root.clientHeight
    for (const item of this.items) {
      const node = this.nodes.get(item.id)
      if (!node) continue
      const p = this.project(item.x, 0, item.z)
      const visible = Number.isFinite(p.x) && Number.isFinite(p.y) && p.x > -40 && p.x < w + 40 && p.y > 0 && p.y < h
      node.hidden = !visible
      if (visible) node.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -100%)`
    }
  }

  dispose(): void {
    for (const node of this.nodes.values()) node.remove()
    this.nodes.clear()
    this.items = []
  }
}
