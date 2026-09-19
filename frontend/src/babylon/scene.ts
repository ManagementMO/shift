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
import { HDRCubeTexture } from '@babylonjs/core/Materials/Textures/hdrCubeTexture'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture'

import { WorldFrame } from './coords'
import { buildCity, type CityMeshes } from './city'
import { WorldCamera } from './camera'
import { RoadIndex } from './roadIndex'
import { Traffic } from './traffic'
import { buildSky } from './sky'
import { applyWorldAtmosphere } from './atmosphere'
import type { WorldData } from './worldData'
import { buildStreetDetails } from './streetDetails'
import { loadLandmarkModels } from './landmarkModels'

export interface WorldSceneOptions {
  shadows?: boolean
  ssao?: boolean
  fixedCamera?: boolean
  quality?: 'high' | 'balanced'
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
  readonly fill: HemisphericLight
  readonly assetsReady: Promise<void>
  private readonly post: DefaultRenderingPipeline
  /** Sim time (s) the traffic is drawn at; set by the playback clock each frame. */
  simT = 0
  lighting: 'afternoon' | 'golden' = 'afternoon'
  private disposed = false
  landmarkModelsLoaded = 0

  constructor(canvas: HTMLCanvasElement, world: WorldData, opts: WorldSceneOptions = {}) {
    this.canvas = canvas
    this.world = world
    const balanced = opts.quality === 'balanced'
    this.engine = new Engine(canvas, true, { antialias: true, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' }, true)
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, balanced ? 1 : 2))
    this.engine.useReverseDepthBuffer = true
    this.scene = new Scene(this.engine)
    this.frame = new WorldFrame(world.crs)
    const scene = this.scene

    // --- atmosphere: warm late-afternoon haze
    const horizon = new Color3(0.79, 0.84, 0.86)
    scene.clearColor = new Color4(horizon.r, horizon.g, horizon.b, 1)
    scene.ambientColor = new Color3(0.3, 0.32, 0.36)
    const sky = buildSky(scene, horizon)
    scene.environmentTexture = new HDRCubeTexture('/assets/city/afternoon-sky.hdr', scene, 128, false, true, false, true)
    scene.environmentIntensity = 0.8

    // --- lights: sun from the south-west, cool sky fill
    // light travels from the south-west toward the north-east, so the south and west faces the opening camera sees are lit
    this.sun = new DirectionalLight('sun', new Vector3(0.5, -0.72, 0.42).normalize(), scene)
    this.sun.diffuse = new Color3(1.0, 0.93, 0.82)
    this.sun.specular = new Color3(0.6, 0.55, 0.5)
    this.sun.intensity = 2.3
    const fill = new HemisphericLight('sky', new Vector3(0, 1, 0), scene)
    this.fill = fill
    fill.diffuse = new Color3(0.62, 0.7, 0.82)
    fill.groundColor = new Color3(0.42, 0.38, 0.33)
    fill.intensity = 0.42

    // --- city
    this.city = buildCity(scene, world, balanced ? 512 : 1024)
    const streets = buildStreetDetails(scene, world)
    this.city.chunks.push(...streets)
    this.city.shadowCasters.push(...streets.filter(m => m.name.startsWith('street-trees-')))

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
    if (!opts.fixedCamera) cam.attachControl(canvas, true)
    scene.onBeforeRenderObservable.add(() => {
      cam.panningSensibility = 45
    })
    this.camera = new WorldCamera(cam, world, opts.fixedCamera ?? false)
    if (!this.camera.fixed) {
      const cancelFlight = () => this.camera.cancel()
      canvas.addEventListener('pointerdown', cancelFlight)
      canvas.addEventListener('wheel', cancelFlight, { passive: true })
      scene.onDisposeObservable.addOnce(() => {
        canvas.removeEventListener('pointerdown', cancelFlight)
        canvas.removeEventListener('wheel', cancelFlight)
      })
    }
    applyWorldAtmosphere(scene, world.crs.bounds_world, sky)

    // --- shadows (sun) over the buildings; cascaded so the 6 km city and a 50 m block both resolve
    if (opts.shadows ?? true) {
      const sg = new CascadedShadowGenerator(balanced ? 1024 : 3072, this.sun)
      sg.numCascades = 2
      sg.lambda = 0.9
      sg.shadowMaxZ = 4500
      sg.autoCalcDepthBounds = false
      sg.stabilizeCascades = true
      sg.bias = 0.004
      sg.normalBias = 0.02
      sg.usePercentageCloserFiltering = true
      sg.filteringQuality = balanced ? CascadedShadowGenerator.QUALITY_LOW : CascadedShadowGenerator.QUALITY_MEDIUM
      sg.customAllowRendering = submesh => {
        const mesh = submesh.getMesh()
        if (!mesh.name.includes('trees-')) return true
        const box = mesh.getBoundingInfo().boundingBox
        const p = this.camera.cam.target
        const dx = Math.max(box.minimumWorld.x - p.x, 0, p.x - box.maximumWorld.x)
        const dz = Math.max(box.minimumWorld.z - p.z, 0, p.z - box.maximumWorld.z)
        return dx * dx + dz * dz < (balanced ? 650 : 1000) ** 2
      }
      for (const m of this.city.shadowCasters) sg.addShadowCaster(m, false)
      this.shadows = sg
      if (balanced) {
        sg.getShadowMap()!.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE
        cam.onViewMatrixChangedObservable.add(() => this.invalidateShadows())
      }
    } else {
      this.shadows = null
    }

    // --- post: FXAA, subtle tone/vignette, SSAO for the tabletop-model feel
    const pipe = new DefaultRenderingPipeline('post', true, scene, [cam])
    this.post = pipe
    pipe.samples = balanced ? 1 : Math.max(1, Math.min(2, this.engine.getCaps().maxMSAASamples))
    pipe.fxaaEnabled = balanced || pipe.samples < 2
    pipe.imageProcessingEnabled = true
    pipe.imageProcessing.contrast = 1.08
    pipe.imageProcessing.exposure = 1.05
    pipe.imageProcessing.vignetteEnabled = true
    pipe.imageProcessing.vignetteWeight = 0.65
    pipe.imageProcessing.vignetteColor = new Color4(0.08, 0.1, 0.14, 0)
    pipe.imageProcessing.toneMappingEnabled = true
    if (opts.ssao ?? !balanced) {
      const ssao = new SSAO2RenderingPipeline('ssao', scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, [cam])
      ssao.radius = 3
      ssao.totalStrength = 0.65
      ssao.base = 0.15
      ssao.samples = 8
      ssao.maxZ = 2500
      ssao.minZAspect = 0.5
      ssao.bypassBlur = false
    }

    const water = scene.getMaterialByName('city-water') as PBRMaterial | null
    const ripples = water?.bumpTexture as Texture | null
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    scene.onBeforeRenderObservable.add(() => {
      if (ripples && !reducedMotion) {
        ripples.uOffset += Math.min(this.engine.getDeltaTime(), 50) * 0.000003
        ripples.vOffset += Math.min(this.engine.getDeltaTime(), 50) * 0.000001
      }
    })
    for (const m of scene.materials) if (m !== water) m.freeze()

    // --- replay traffic (created after the static materials are frozen: its own materials stay live)
    this.roads = new RoadIndex(world)
    this.traffic = new Traffic(scene, this.frame, balanced ? null : this.shadows)
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
    this.assetsReady = loadLandmarkModels(this)
  }

  resize(): void {
    this.engine.resize()
    this.camera.resize(this.engine.getAspectRatio(this.camera.cam))
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

  invalidateShadows(): void {
    this.shadows?.getShadowMap()?.resetRefreshCounter()
  }

  setLighting(mode: 'afternoon' | 'golden'): void {
    this.lighting = mode
    this.sun.direction = (mode === 'golden' ? new Vector3(0.8, -0.48, 0.32) : new Vector3(0.5, -0.72, 0.42)).normalize()
    this.sun.diffuse = mode === 'golden' ? new Color3(1, 0.79, 0.56) : new Color3(1, 0.95, 0.85)
    this.sun.intensity = mode === 'golden' ? 2.0 : 2.3
    this.fill.intensity = mode === 'golden' ? 0.34 : 0.42
    this.post.imageProcessing.exposure = mode === 'golden' ? 1.12 : 1.05
    for (const m of this.scene.materials) { m.unfreeze(); m.markDirty() }
    this.invalidateShadows()
  }
}
