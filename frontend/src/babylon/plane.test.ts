import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture'
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent'
import type { Pose } from './camera'
import { FLYOVER_DURATION_S, PlaneFlyover, planeAltitude, planeFlight, planePose, planeShadowHeight } from './plane'
import { fitShadowLight } from './shadows'

const bounds = [-3200, -2450, 3200, 2450]
const view: Pose = { target: [0, 0], radius: 1250, heading: -28, elevation: 43, y: 75 }

describe('plane flyover route', () => {
  it('frames the flyover above the tallest roof without mutating the existing camera pose', () => {
    const before = structuredClone(view)
    const flight = planeFlight(bounds, 553, view, 16 / 9)
    expect(flight.altitude).toBe(planeAltitude(553))
    expect(flight.altitude).toBeGreaterThan(630)
    expect(flight.view.radius).toBeGreaterThan(view.radius)
    expect(flight.view.heading).toBe(view.heading)
    expect(flight.view.target).toEqual(view.target)
    expect(view).toEqual(before)
    for (let t = 0; t < FLYOVER_DURATION_S; t += 0.25) {
      const pose = planePose(flight, t)!
      expect(Object.values(pose).every(Number.isFinite)).toBe(true)
      expect(pose.y).toBeGreaterThan(630)
      expect(Math.abs(pose.roll)).toBeLessThan(0.15)
    }
  })

  it('crosses the view smoothly from left to right and finishes instead of looping or teleporting', () => {
    const flight = planeFlight(bounds, 553, view, 16 / 9)
    const a = planePose(flight, 0)!, b = planePose(flight, FLYOVER_DURATION_S - 0.001)!
    const heading = view.heading * Math.PI / 180
    expect((b.x - a.x) * Math.cos(heading) - (b.z - a.z) * Math.sin(heading)).toBeGreaterThan(2000)
    const near = planePose(flight, 10)!, next = planePose(flight, 10.016)!
    expect(Math.hypot(next.x - near.x, next.y - near.y, next.z - near.z)).toBeLessThan(5)
    expect(planePose(flight, -1)).toBeNull()
    expect(planePose(flight, FLYOVER_DURATION_S)).toBeNull()
  })

  it.each([320 / 568, 16 / 9, 3440 / 1440])('allows the enlarged aircraft to enter and exit offscreen at aspect %s', aspect => {
    const flight = planeFlight(bounds, 553, view, aspect)
    expect(flight.halfSpan - flight.view.radius * 0.44 * aspect).toBeGreaterThan(800)
  })

  it('keeps off-city and street-level views focused on the city, including narrow screens', () => {
    const flight = planeFlight(bounds, 60, { target: [30000, -30000], radius: 50, elevation: -10, heading: 80 }, 320 / 568)
    expect(flight.view.target[0]).toBeLessThan(bounds[2])
    expect(flight.view.target[1]).toBeGreaterThan(bounds[1])
    expect(flight.view.elevation).toBeGreaterThanOrEqual(48)
    expect(flight.view.radius).toBeGreaterThanOrEqual(1800)
    expect(flight.halfSpan).toBeGreaterThan(500)
  })
})

describe('3D plane and its real sun shadow', () => {
  let engine: NullEngine, scene: Scene, shadows: ShadowGenerator, plane: PlaneFlyover
  beforeEach(() => {
    engine = new NullEngine()
    engine.useReverseDepthBuffer = true
    scene = new Scene(engine)
    new ArcRotateCamera('camera', 0, 0.8, 2000, Vector3.Zero(), scene)
    const sun = new DirectionalLight('sun', new Vector3(0.5, -0.72, 0.42).normalize(), scene)
    fitShadowLight(sun, bounds, planeShadowHeight(553))
    shadows = new ShadowGenerator(1024, sun)
    plane = new PlaneFlyover(scene, shadows, bounds, 553)
  })
  afterEach(() => {
    plane.dispose()
    scene.dispose()
    engine.dispose()
  })

  it('allocates only on demand and builds an opaque, three-dimensional aircraft with batched geometry', () => {
    expect(plane.active).toBe(false)
    expect(scene.meshes).toHaveLength(0)
    plane.start(view, 16 / 9)
    expect(plane.active).toBe(true)
    const meshes = scene.meshes.filter(m => m.name.startsWith('plane-'))
    expect(meshes.length).toBeGreaterThanOrEqual(3)
    expect(meshes.length).toBeLessThanOrEqual(5)
    for (const mesh of meshes) {
      expect(mesh.getVerticesData('position')!.every(Number.isFinite)).toBe(true)
      expect(mesh.getTotalVertices()).toBeGreaterThan(0)
      expect(mesh.isPickable).toBe(false)
      expect(mesh.material!.alpha).toBe(1)
      expect(shadows.getShadowMap()!.renderList).toContain(mesh)
      expect(mesh.receiveShadows).toBe(true)
    }
    const root = scene.getTransformNodeByName('plane-flyover')!
    expect(root.scaling.asArray()).toEqual([22, 22, 22])
    root.computeWorldMatrix(true)
    const box = root.getHierarchyBoundingVectors(true)
    expect(box.max.y - box.min.y).toBeGreaterThan(150)
    expect(box.max.x - box.min.x).toBeGreaterThan(800)
    expect(box.max.z - box.min.z).toBeGreaterThan(800)
    expect(box.min.y).toBeGreaterThan(553)
    expect(box.max.y).toBeLessThan(planeShadowHeight(553))
  })

  it('moves on render time even without SUMO and invalidates cached shadows each frame', () => {
    shadows.getShadowMap()!.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE
    const refresh = vi.spyOn(shadows.getShadowMap()!, 'resetRefreshCounter')
    plane.start(view, 16 / 9)
    const root = scene.getTransformNodeByName('plane-flyover')!
    const before = root.position.clone()
    plane.update(0.1)
    expect(Vector3.Distance(before, root.position)).toBeGreaterThan(1)
    expect(refresh).toHaveBeenCalled()
    for (let i = 0; i < 130; i++) plane.update(0.1)
    root.computeWorldMatrix(true)
    const projected = Vector3.TransformCoordinates(root.position, shadows.getTransformMatrix())
    expect(Math.abs(projected.x)).toBeLessThan(1)
    expect(Math.abs(projected.y)).toBeLessThan(1)
    expect(Math.abs(projected.z)).toBeLessThanOrEqual(1)
  })

  it('restarts a single plane on repeated commands without accumulating meshes or shadow casters', () => {
    plane.start(view, 16 / 9)
    const meshCount = scene.meshes.length, materialCount = scene.materials.length
    for (let i = 0; i < 4; i++) {
      plane.update(0.1)
      plane.start(view, 16 / 9)
      expect(scene.meshes).toHaveLength(meshCount)
      expect(scene.materials).toHaveLength(materialCount)
      expect(shadows.getShadowMap()!.renderList).toHaveLength(meshCount)
      expect(scene.transformNodes).toHaveLength(1)
    }
  })

  it('removes the aircraft and its shadow after the pass without touching the city', () => {
    const city = new Mesh('existing-city', scene)
    shadows.addShadowCaster(city)
    const materialsBefore = scene.materials.length
    plane.start(view, 16 / 9)
    for (let i = 0; i <= FLYOVER_DURATION_S * 10 + 1; i++) plane.update(0.1)
    expect(plane.active).toBe(false)
    expect(scene.meshes).toEqual([city])
    expect(scene.transformNodes).toHaveLength(0)
    expect(scene.materials).toHaveLength(materialsBefore)
    expect(shadows.getShadowMap()!.renderList).toHaveLength(1)
    expect(shadows.getShadowMap()!.renderList![0]).toBe(city)
  })

  it('clears safely on leaving or replacing the city, including repeated disposal', () => {
    plane.start(view, 16 / 9)
    plane.clear()
    plane.update(0.1)
    plane.clear()
    plane.dispose()
    expect(plane.active).toBe(false)
    expect(scene.meshes).toHaveLength(0)
    expect(scene.materials).toHaveLength(0)
    expect(shadows.getShadowMap()!.renderList).toHaveLength(0)
  })
})
