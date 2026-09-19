/**
 * Engine, scene, sky, sun, strategic camera and post-processing for the Babylon world.  Keeps the imperative
 * Babylon lifecycle out of React: WorldCanvas mounts one `WorldScene` per canvas and disposes it on unmount.
 */

import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { CascadedShadowGenerator } from '@babylonjs/core/Lights/Shadows/cascadedShadowGenerator'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline'
import { SSAO2RenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/ssao2RenderingPipeline'
import '@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent'
import '@babylonjs/core/Rendering/depthRendererSceneComponent'
import '@babylonjs/core/Rendering/prePassRendererSceneComponent'
import '@babylonjs/core/Rendering/geometryBufferRendererSceneComponent'

import { WorldFrame } from './coords'
import { buildCity, type CityMeshes } from './city'
import { WorldCamera } from './camera'
import { RoadIndex } from './roadIndex'
import { Traffic } from './traffic'
import { buildSky } from './sky'
import { applyWorldAtmosphere } from './atmosphere'
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
  readonly shadows: CascadedShadowGenerator | null
  readonly canvas: HTMLCanvasElement
  readonly world: WorldData
  readonly roads: RoadIndex
  readonly traffic: Traffic
  /** Sim time (s) the traffic is drawn at; set by the playback clock each frame. */
  simT = 0
  private disposed = false

  constructor(canvas: HTMLCanvasElement, world: WorldData, opts: WorldSceneOptions = {}) {
    this.canvas = canvas
    this.world = world
    this.engine = new Engine(canvas, true, { antialias: true, stencil: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' }, true)
    this.engine.useReverseDepthBuffer = true
    this.scene = new Scene(this.engine)
    this.frame = new WorldFrame(world.crs)
    const scene = this.scene

    // --- atmosphere: warm late-afternoon haze
    const horizon = new Color3(0.86, 0.87, 0.9)
    scene.clearColor = new Color4(horizon.r, horizon.g, horizon.b, 1)
    scene.ambientColor = new Color3(0.3, 0.32, 0.36)
    const sky = buildSky(scene, horizon)

    // --- lights: sun from the south-west, cool sky fill
    // light travels from the south-west toward the north-east, so the south and west faces the opening camera sees are lit
    this.sun = new DirectionalLight('sun', new Vector3(0.5, -0.72, 0.42).normalize(), scene)
    this.sun.diffuse = new Color3(1.0, 0.93, 0.82)
    this.sun.specular = new Color3(0.6, 0.55, 0.5)
    this.sun.intensity = 1.15
    const fill = new HemisphericLight('sky', new Vector3(0, 1, 0), scene)
    fill.diffuse = new Color3(0.62, 0.7, 0.82)
    fill.groundColor = new Color3(0.42, 0.38, 0.33)
    fill.intensity = 0.5

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
    applyWorldAtmosphere(scene, world.crs.bounds_world, sky)

    // --- shadows (sun) over the buildings; cascaded so the 6 km city and a 50 m block both resolve
    if (opts.shadows ?? true) {
      const sg = new CascadedShadowGenerator(2048, this.sun)
      sg.numCascades = 3
      sg.lambda = 0.9
      sg.shadowMaxZ = 4500
      sg.autoCalcDepthBounds = false
      sg.stabilizeCascades = true
      sg.bias = 0.004
      sg.normalBias = 0.02
      sg.usePercentageCloserFiltering = true
      sg.filteringQuality = CascadedShadowGenerator.QUALITY_MEDIUM
      sg.cascadeBlendPercentage = 0.1
      for (const m of this.city.shadowCasters) sg.addShadowCaster(m, false)
      this.shadows = sg
    } else {
      this.shadows = null
    }

    // --- post: FXAA, subtle tone/vignette, SSAO for the tabletop-model feel
    const pipe = new DefaultRenderingPipeline('post', false, scene, [cam])
    pipe.fxaaEnabled = true
    pipe.imageProcessingEnabled = true
    pipe.imageProcessing.contrast = 1.12
    pipe.imageProcessing.exposure = 1.0
    pipe.imageProcessing.vignetteEnabled = true
    pipe.imageProcessing.vignetteWeight = 1.6
    pipe.imageProcessing.vignetteColor = new Color4(0.08, 0.1, 0.14, 0)
    pipe.imageProcessing.toneMappingEnabled = false
    if (opts.ssao ?? true) {
      const ssao = new SSAO2RenderingPipeline('ssao', scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, [cam])
      ssao.radius = 6
      ssao.totalStrength = 0.9
      ssao.base = 0.15
      ssao.samples = 12
      ssao.maxZ = 2500
      ssao.minZAspect = 0.5
      ssao.bypassBlur = false
    }

    for (const m of scene.materials) m.freeze()

    // --- replay traffic (created after the static materials are frozen: its own materials stay live)
    this.roads = new RoadIndex(world)
    this.traffic = new Traffic(scene, this.frame, this.shadows)
    scene.onBeforeRenderObservable.add(() => {
      const p = this.camera.cam.globalPosition
      this.traffic.update(this.simT, { x: p.x, y: p.y, z: p.z, radius: this.camera.cam.radius })
    })

    scene.autoClear = true
    scene.autoClearDepthAndStencil = true
    scene.skipPointerMovePicking = true

    this.engine.runRenderLoop(() => {
      if (!this.disposed) scene.render()
    })
    this.resize = this.resize.bind(this)
    window.addEventListener('resize', this.resize)
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
    this.traffic.dispose()
    this.city.dispose()
    this.scene.dispose()
    this.engine.dispose()
  }
}
