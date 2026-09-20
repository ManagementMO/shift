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
import { renderScale, type DisplaySettings } from './display'
import { fitShadowLight } from './shadows'
import { buildCity, Y, type CityMeshes } from './city'
import { buildTerrain, type Terrain } from './terrain'
import { BuildingIndex } from './buildingIndex'
import { WorldCamera } from './camera'
import { KeyboardPan } from './keyboardPan'
import { RoadIndex } from './roadIndex'
import { Traffic } from './traffic'
import { buildSky } from './sky'
import { applyWorldAtmosphere } from './atmosphere'
import type { WorldData } from './worldData'
import { buildStreetDetails } from './streetDetails'
import { loadLandmarkModels } from './landmarkModels'
import { StormSystem } from './tornado'

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
  /** WASD ground travel; attached to the window unless the camera is fixed. */
  readonly keys: KeyboardPan
  readonly sun: DirectionalLight
  readonly city: CityMeshes
  readonly terrain: Terrain
  readonly shadows: ShadowGenerator | null
  readonly canvas: HTMLCanvasElement
  readonly world: WorldData
  readonly roads: RoadIndex
  /** Every drawn building as pickable prisms, for pointer picking and info. */
  readonly buildings: BuildingIndex
  readonly traffic: Traffic
  readonly storm: StormSystem
  readonly fill: HemisphericLight
  readonly assetsReady: Promise<void>
  private readonly post: DefaultRenderingPipeline
  /** Sim time (s) the traffic is drawn at; set by the playback clock each frame. */
  simT = 0
  lighting: 'afternoon' | 'golden' = 'afternoon'
  private disposed = false
  private active = true
  private readonly balanced: boolean
  private readonly shadowHeight: number
  landmarkModelsLoaded = 0

  constructor(canvas: HTMLCanvasElement, world: WorldData, opts: WorldSceneOptions = {}) {
    this.canvas = canvas
    this.world = world
    const balanced = opts.quality === 'balanced'
    this.balanced = balanced
    this.shadowHeight = Math.max(100, ...world.buildings.map((b) => (b.base ?? 0) + b.h), ...world.landmarks.map((l) => l.h), ...(world.massing?.buildings.map((b) => b.h) ?? []))
    this.engine = new Engine(canvas, true, { antialias: true, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' }, true)
    this.engine.setHardwareScalingLevel(balanced ? 1 : renderScale(window.devicePixelRatio, false))
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
    this.sun.diffuse = new Color3(1.0, 0.95, 0.85)
    this.sun.specular = new Color3(0.6, 0.55, 0.5)
    this.sun.intensity = 2.3
    const fill = new HemisphericLight('sky', new Vector3(0, 1, 0), scene)
    this.fill = fill
    fill.diffuse = new Color3(0.62, 0.7, 0.82)
    fill.groundColor = new Color3(0.42, 0.38, 0.33)
    fill.specular = Color3.Black()
    fill.intensity = 0.42

    // --- city
    this.city = buildCity(scene, world, balanced ? 512 : 1024)
    const streets = buildStreetDetails(scene, world)
    this.city.chunks.push(...streets)
    this.city.shadowCasters.push(...streets.filter(m => m.name.startsWith('street-trees-')))
    // Placeholder countryside past the pack: grassland hills, the lake carried on, main roads to the horizon.
    this.terrain = buildTerrain(scene, world, this.city.materials, { cells: balanced ? 96 : 176, treeLimit: balanced ? 500 : 1500 })

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
    if (!opts.fixedCamera) cam.attachControl(false, true, 1)
    scene.onBeforeRenderObservable.add(() => {
      cam.panningSensibility = 45
    })
    this.camera = new WorldCamera(cam, world, opts.fixedCamera ?? false)
    this.keys = new KeyboardPan(this.camera, this.terrain.shape.farBounds, scene, (x, z) => Math.max(0, this.terrain.shape.surface(x, z)))
    if (!this.camera.fixed) {
      this.keys.attach(window)
      const cancelFlight = () => this.camera.cancel()
      canvas.addEventListener('pointerdown', cancelFlight)
      canvas.addEventListener('wheel', cancelFlight, { passive: true })
      scene.onDisposeObservable.addOnce(() => {
        canvas.removeEventListener('pointerdown', cancelFlight)
        canvas.removeEventListener('wheel', cancelFlight)
      })
    }
    applyWorldAtmosphere(scene, this.terrain.shape.farBounds, sky)

    // --- shadows (sun) use a fixed world-space frustum, independent of camera rotation and zoom.
    if (opts.shadows ?? true) {
      fitShadowLight(this.sun, world.crs.bounds_world, this.shadowHeight)
      const sg = new ShadowGenerator(Math.min(balanced ? 2048 : 4096, this.engine.getCaps().maxTextureSize), this.sun)
      sg.bias = 0.00002
      sg.normalBias = 0.3
      sg.setDarkness(0.18)
      sg.usePercentageCloserFiltering = true
      sg.filteringQuality = balanced ? ShadowGenerator.QUALITY_MEDIUM : ShadowGenerator.QUALITY_HIGH
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
    this.post = pipe
    pipe.samples = balanced ? 1 : Math.max(1, Math.min(2, this.engine.getCaps().maxMSAASamples))
    pipe.fxaaEnabled = balanced || pipe.samples < 2
    pipe.imageProcessingEnabled = true
    pipe.imageProcessing.contrast = 1.04
    pipe.imageProcessing.exposure = 1.05
    pipe.imageProcessing.vignetteEnabled = false
    pipe.imageProcessing.toneMappingEnabled = true

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
    this.buildings = new BuildingIndex(world)
    this.traffic = new Traffic(scene, this.frame, balanced ? null : this.shadows, world.surfaces ? Y.road : Y.path)
    this.storm = new StormSystem(scene, this.frame, world, this.city, balanced ? null : this.shadows)
    scene.onBeforeRenderObservable.add(() => {
      const p = this.camera.cam.globalPosition
      this.traffic.update(this.simT, { x: p.x, y: p.y, z: p.z, radius: this.camera.cam.radius })
      this.storm.update(this.simT)
    })

    scene.autoClear = true
    scene.autoClearDepthAndStencil = true
    scene.skipPointerMovePicking = true

    this.engine.runRenderLoop(() => {
      if (!this.disposed && this.active) scene.render()
    })
    this.resize = this.resize.bind(this)
    window.addEventListener('resize', this.resize)
    this.assetsReady = loadLandmarkModels(this)
  }

  setActive(active: boolean): void {
    this.active = active
    if (!active) {
      this.camera.cancel()
      this.keys.release()
    }
  }

  setDisplay(settings: DisplaySettings): void {
    const frozen = this.scene.materials.filter((m) => m.isFrozen)
    for (const m of frozen) m.unfreeze()
    this.scene.shadowsEnabled = settings.shadows
    this.scene.texturesEnabled = settings.textures
    this.engine.setHardwareScalingLevel(this.balanced ? 1 : renderScale(window.devicePixelRatio, settings.sharp))
    if (settings.projection !== this.camera.preferredProjection) this.camera.setPreferredProjection(settings.projection)
    if (settings.lighting !== this.lighting) this.setLighting(settings.lighting)
    this.engine.resize()
    this.invalidateShadows()
    for (const m of frozen) m.freeze()
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
    this.storm.dispose()
    this.traffic.dispose()
    this.terrain.dispose()
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
    fitShadowLight(this.sun, this.world.crs.bounds_world, this.shadowHeight)
    for (const m of this.scene.materials) { m.unfreeze(); m.markDirty() }
    this.invalidateShadows()
  }
}
