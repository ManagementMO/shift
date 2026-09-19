/**
 * Engine, scene, sky, sun, strategic camera and post-processing for the Babylon world.  Keeps the imperative
 * Babylon lifecycle out of React: WorldCanvas mounts one `WorldScene` per canvas and disposes it on unmount.
 */

import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline'
import { SSAO2RenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline'
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent'
import '@babylonjs/core/Rendering/depthRendererSceneComponent'
import '@babylonjs/core/Rendering/prePassRendererSceneComponent'
import '@babylonjs/core/Rendering/geometryBufferRendererSceneComponent'

import { WorldFrame } from './coords'
import { renderScale, type DisplaySettings } from './display'
import { fitShadowLight } from './shadows'
import { buildCity, Y, type CityMeshes } from './city'
import { WorldCamera } from './camera'
import { RoadIndex } from './roadIndex'
import { Traffic } from './traffic'
import type { WorldData } from './worldData'

export interface WorldSceneOptions {
  shadows?: boolean
  ssao?: boolean
}

export class WorldScene {
  readonly engine: Engine
  readonly scene: Scene
  readonly frame: WorldFrame
  readonly camera: WorldCamera
  readonly sun: DirectionalLight
  readonly city: CityMeshes
  readonly shadows: ShadowGenerator | null
  readonly canvas: HTMLCanvasElement
  readonly world: WorldData
  readonly roads: RoadIndex
  readonly traffic: Traffic
  /** Sim time (s) the traffic is drawn at; set by the playback clock each frame. */
  simT = 0
  private disposed = false
  private active = true

  constructor(canvas: HTMLCanvasElement, world: WorldData, opts: WorldSceneOptions = {}) {
    this.canvas = canvas
    this.world = world
    this.engine = new Engine(canvas, true, { antialias: true, stencil: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' }, true)
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 1.5))
    this.engine.useReverseDepthBuffer = true
    this.scene = new Scene(this.engine)
    this.frame = new WorldFrame(world.crs)
    const scene = this.scene

    // --- atmosphere: warm late-afternoon haze
    const horizon = new Color3(0.86, 0.87, 0.9)
    scene.clearColor = new Color4(horizon.r, horizon.g, horizon.b, 1)
    scene.ambientColor = new Color3(0.04, 0.05, 0.06)
    scene.fogMode = Scene.FOGMODE_EXP2
    scene.fogColor = horizon
    scene.fogDensity = 0.00011
    buildSky(scene, horizon)

    // --- lights: sun from the south-west, cool sky fill
    // light travels from the south-west toward the north-east, so the south and west faces the opening camera sees are lit
    this.sun = new DirectionalLight('sun', new Vector3(0.5, -0.72, 0.42).normalize(), scene)
    this.sun.diffuse = new Color3(1.0, 0.97, 0.92)
    this.sun.specular = new Color3(0.35, 0.36, 0.38)
    this.sun.intensity = 0.85
    const fill = new HemisphericLight('sky', new Vector3(0, 1, 0), scene)
    fill.diffuse = new Color3(0.78, 0.85, 0.94)
    fill.groundColor = new Color3(0.38, 0.4, 0.43)
    fill.specular = Color3.Black()
    fill.intensity = 0.65

    // --- city
    this.city = buildCity(scene, world)

    // --- camera
    const cam = new ArcRotateCamera('cam', -1.95, 0.98, 1500, new Vector3(380, 0, -520), scene)
    cam.minZ = 2
    cam.maxZ = 40000
    cam.lowerRadiusLimit = 45
    cam.upperRadiusLimit = 9000
    cam.lowerBetaLimit = 0.08
    cam.upperBetaLimit = 1.5
    cam.wheelDeltaPercentage = 0.035
    cam.pinchDeltaPercentage = 0.01
    cam.angularSensibilityX = 900
    cam.angularSensibilityY = 900
    cam.panningAxis = new Vector3(1, 0, 1)
    cam.mapPanning = true
    cam.panningInertia = 0.82
    cam.inertia = 0.84
    cam.useNaturalPinchZoom = true
    cam.attachControl(canvas, true)
    scene.onBeforeRenderObservable.add(() => {
      cam.panningSensibility = Math.max(4, 3200 / cam.radius) * 1.0
    })
    this.camera = new WorldCamera(cam, world)

    // --- shadows (sun) use a fixed world-space frustum, independent of camera rotation and zoom.
    if (opts.shadows ?? true) {
      const height = Math.max(100, ...world.buildings.map((b) => (b.base ?? 0) + b.h), ...world.landmarks.map((l) => l.h))
      fitShadowLight(this.sun, world.crs.bounds_world, height)
      const sg = new ShadowGenerator(Math.min(4096, this.engine.getCaps().maxTextureSize), this.sun)
      sg.bias = 0.00002
      sg.normalBias = 0.3
      sg.setDarkness(0.18)
      sg.usePercentageCloserFiltering = true
      sg.filteringQuality = ShadowGenerator.QUALITY_HIGH
      for (const m of this.city.shadowCasters) sg.addShadowCaster(m, false)
      this.shadows = sg
    } else {
      this.shadows = null
    }

    // --- post: FXAA, subtle tone/vignette, SSAO for the tabletop-model feel
    if (opts.ssao ?? false) {
      const ssao = new SSAO2RenderingPipeline('ssao', scene, { ssaoRatio: 0.5, blurRatio: 1 }, [cam])
      ssao.radius = 0.8
      ssao.totalStrength = 0.35
      ssao.base = 0.5
      ssao.samples = 16
      ssao.maxZ = 600
      ssao.minZAspect = 0.2
      ssao.bypassBlur = false
    }
    const pipe = new DefaultRenderingPipeline('post', true, scene, [cam])
    pipe.fxaaEnabled = true
    pipe.imageProcessingEnabled = true
    pipe.imageProcessing.contrast = 1.04
    pipe.imageProcessing.exposure = 1.0
    pipe.imageProcessing.vignetteEnabled = false
    pipe.imageProcessing.toneMappingEnabled = true

    for (const m of scene.materials) m.freeze()

    // --- replay traffic (created after the static materials are frozen: its own materials stay live)
    this.roads = new RoadIndex(world)
    this.traffic = new Traffic(scene, this.frame, this.shadows, world.surfaces ? Y.road : Y.path)
    scene.onBeforeRenderObservable.add(() => {
      const p = this.camera.cam.globalPosition
      this.traffic.update(this.simT, { x: p.x, y: p.y, z: p.z, radius: this.camera.cam.radius })
    })

    scene.autoClear = true
    scene.autoClearDepthAndStencil = true
    scene.skipPointerMovePicking = true

    this.engine.runRenderLoop(() => {
      if (!this.disposed && this.active) scene.render()
    })
    this.resize = this.resize.bind(this)
    window.addEventListener('resize', this.resize)
  }

  setActive(active: boolean): void {
    this.active = active
    if (!active) this.camera.cancel()
  }

  setDisplay(settings: DisplaySettings): void {
    const frozen = this.scene.materials.filter((m) => m.isFrozen)
    for (const m of frozen) m.unfreeze()
    this.scene.shadowsEnabled = settings.shadows
    this.scene.texturesEnabled = settings.textures
    this.engine.setHardwareScalingLevel(renderScale(window.devicePixelRatio, settings.sharp))
    this.engine.resize()
    for (const m of frozen) m.freeze()
  }

  resize(): void {
    this.engine.resize()
  }

  get fps(): number {
    return this.engine.getFps()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('resize', this.resize)
    this.engine.stopRenderLoop()
    this.camera.cancel()
    this.traffic.dispose()
    this.city.dispose()
    this.scene.dispose()
    this.engine.dispose()
  }
}

/** Gradient sky dome: pale warm horizon rising to a soft blue, unlit and always behind everything. */
function buildSky(scene: Scene, horizon: Color3): Mesh {
  const zenith = new Color3(0.47, 0.62, 0.84)
  const rings = 12
  const segs = 24
  const r = 30000
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  for (let j = 0; j <= rings; j++) {
    const t = j / rings // 0 = horizon (slightly below), 1 = zenith
    const el = -0.08 + t * (Math.PI / 2 + 0.08)
    const y = Math.sin(el) * r
    const rr = Math.cos(el) * r
    const c = Color3.Lerp(horizon, zenith, Math.pow(Math.max(0, t), 0.7))
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2
      positions.push(Math.cos(a) * rr, y, Math.sin(a) * rr)
      colors.push(c.r, c.g, c.b, 1)
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segs; i++) {
      const i2 = (i + 1) % segs
      const a = j * segs + i
      const b = j * segs + i2
      const c = (j + 1) * segs + i
      const d = (j + 1) * segs + i2
      indices.push(a, b, c, b, d, c)
    }
  }
  const sky = new Mesh('sky', scene)
  const vd = new VertexData()
  vd.positions = new Float32Array(positions)
  vd.colors = new Float32Array(colors)
  vd.indices = new Uint16Array(indices)
  vd.applyToMesh(sky)
  const m = new StandardMaterial('sky', scene)
  m.disableLighting = true
  m.emissiveColor = Color3.White()
  m.backFaceCulling = false
  m.fogEnabled = false
  sky.material = m
  sky.infiniteDistance = true
  sky.isPickable = false
  sky.applyFog = false
  sky.renderingGroupId = 0
  return sky
}
