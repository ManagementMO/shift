import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder'
import { CreateLineSystem } from '@babylonjs/core/Meshes/Builders/linesBuilder'
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture'
import { Constants } from '@babylonjs/core/Engines/constants'
import type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh'
import { flightPose, geoPoint, pointGeo, orbitRadius, lockOrbit, LOCATIONS, type Location, type Orbit } from './flight'

const ASSET_ROOT = 'https://raw.githubusercontent.com/mrdoob/three.js/7300402f96c23bfa2174ffc0da01fb4e277d33da/examples/textures/planets'
const BORDERS = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson'

const vertex = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
uniform mat4 world;
uniform mat4 worldViewProjection;
varying vec3 vPosition;
varying vec3 vNormal;
varying vec2 vUV;
void main() {
  vPosition = (world * vec4(position, 1.0)).xyz;
  vNormal = normalize(mat3(world) * normal);
  vUV = uv;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`

const earthFragment = `
precision highp float;
varying vec3 vPosition;
varying vec3 vNormal;
varying vec2 vUV;
uniform sampler2D dayMap;
uniform sampler2D nightMap;
uniform vec3 cameraPosition;
uniform vec3 sunDirection;
uniform float tactical;
void main() {
  vec3 normal = normalize(vNormal);
  vec3 view = normalize(cameraPosition - vPosition);
  float sun = dot(normal, sunDirection);
  vec3 day = texture2D(dayMap, vUV).rgb;
  vec3 night = texture2D(nightMap, vUV).rgb;
  float light = 0.22 + 0.78 * smoothstep(-0.22, 0.9, sun);
  float grey = dot(day, vec3(0.299, 0.587, 0.114));
  vec3 color = mix(day * 0.94, vec3(pow(grey, 0.86) * 0.95 + 0.005), tactical);
  color *= light;
  color += night * (1.0 - smoothstep(-0.08, 0.32, sun)) * mix(0.8, 0.28, tactical);
  float rim = pow(1.0 - max(0.0, dot(normal, view)), 3.8);
  color += mix(vec3(0.055, 0.22, 0.33), vec3(0.10), tactical) * rim;
  gl_FragColor = vec4(color, 1.0);
}`

const atmosphereFragment = `
precision highp float;
varying vec3 vPosition;
varying vec3 vNormal;
uniform vec3 cameraPosition;
uniform float tactical;
void main() {
  float rim = pow(1.0 - max(0.0, dot(normalize(vNormal), normalize(cameraPosition - vPosition))), 3.2);
  vec3 color = mix(vec3(0.22, 0.28, 0.32), vec3(0.3), tactical);
  gl_FragColor = vec4(color, rim * 0.18);
}`

export interface GlobeCallbacks {
  select: (place: Location) => void
  imageryError: () => void
}

export class GlobeScene {
  readonly engine: Engine
  readonly scene: Scene
  readonly camera: ArcRotateCamera
  private readonly canvas: HTMLCanvasElement
  private readonly material: ShaderMaterial
  private readonly atmosphere: ShaderMaterial
  private readonly abort = new AbortController()
  private readonly textures: Texture[] = []
  private readonly markers: { point: Vector3; element: HTMLButtonElement }[]
  private borders: LinesMesh | null = null
  private flying = false
  private disposed = false
  private tactical = true
  private fittedRadius: number
  private lastInteraction = performance.now()
  private flight: { from: Orbit; place: Location; start: number; duration: number; progress: (t: number) => void; done: () => void } | null = null
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  private readonly resizeObserver: ResizeObserver
  private down: { x: number; y: number } | null = null

  constructor(canvas: HTMLCanvasElement, labels: Map<string, HTMLButtonElement>, callbacks: GlobeCallbacks) {
    this.canvas = canvas
    this.engine = new Engine(canvas, true, { antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' })
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 1.5))
    this.scene = new Scene(this.engine)
    this.scene.useRightHandedSystem = true
    this.scene.clearColor = new Color4(6 / 255, 6 / 255, 6 / 255, 1)
    this.fittedRadius = orbitRadius(canvas.clientWidth, canvas.clientHeight)
    this.camera = new ArcRotateCamera('orbit', -1.84, 1.01, this.fittedRadius, Vector3.Zero(), this.scene)
    this.camera.fov = 0.7
    this.camera.minZ = 0.001
    this.camera.maxZ = 100
    lockOrbit(this.camera, this.fittedRadius)
    this.camera.lowerBetaLimit = 0.04
    this.camera.upperBetaLimit = Math.PI - 0.04
    this.camera.panningSensibility = 0
    this.camera.angularSensibilityX = 650
    this.camera.angularSensibilityY = 650
    this.camera.inertia = 0.82
    this.camera.attachControl(canvas, true)
    const shaderOptions = { attributes: ['position', 'normal', 'uv'], uniforms: ['world', 'worldViewProjection', 'cameraPosition', 'sunDirection', 'tactical'], samplers: ['dayMap', 'nightMap'] }
    this.material = new ShaderMaterial('earth', this.scene, { vertexSource: vertex, fragmentSource: earthFragment }, shaderOptions)
    this.material.setVector3('sunDirection', new Vector3(-0.65, 0.6, -1).normalize())
    this.material.setFloat('tactical', 1)
    const dayFallback = RawTexture.CreateRGBATexture(new Uint8Array([24, 49, 65, 255]), 1, 1, this.scene)
    const nightFallback = RawTexture.CreateRGBATexture(new Uint8Array([0, 0, 0, 255]), 1, 1, this.scene)
    this.textures.push(dayFallback, nightFallback)
    this.material.setTexture('dayMap', dayFallback)
    this.material.setTexture('nightMap', nightFallback)
    const earth = CreateSphere('earth', { diameter: 2, segments: 72 }, this.scene)
    earth.material = this.material
    this.loadTexture('earth_day_4096.jpg', (texture) => this.material.setTexture('dayMap', texture), callbacks.imageryError)
    this.loadTexture('earth_night_4096.jpg', (texture) => this.material.setTexture('nightMap', texture))

    this.atmosphere = new ShaderMaterial('atmosphere', this.scene, { vertexSource: vertex, fragmentSource: atmosphereFragment }, { ...shaderOptions, needAlphaBlending: true })
    this.atmosphere.alphaMode = Constants.ALPHA_ADD
    this.atmosphere.disableDepthWrite = true
    this.atmosphere.setFloat('tactical', 1)
    const glow = CreateSphere('atmosphere', { diameter: 2.012, segments: 64 }, this.scene)
    glow.material = this.atmosphere
    glow.isPickable = false

    void this.loadBorders()

    this.markers = LOCATIONS.flatMap((place) => {
      const element = labels.get(place.id)
      return element ? [{ point: Vector3.FromArray(geoPoint(place.lat, place.lon, 1.009)), element }] : []
    })
    const pointerDown = (event: PointerEvent) => {
      this.lastInteraction = performance.now()
      if (event.button === 0 && !this.flying) this.down = { x: event.clientX, y: event.clientY }
    }
    const pointerUp = (event: PointerEvent) => {
      const down = this.down
      this.down = null
      if (!down || this.flying || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return
      const rect = canvas.getBoundingClientRect()
      const hit = this.scene.pick(event.clientX - rect.left, event.clientY - rect.top, (mesh) => mesh === earth)
      if (hit?.pickedPoint) {
        const geo = pointGeo(hit.pickedPoint.asArray())
        callbacks.select({ id: 'custom', name: 'Selected location', region: 'Globe selection', ...geo })
      }
    }
    const wheel = () => { this.lastInteraction = performance.now() }
    canvas.addEventListener('pointerdown', pointerDown)
    canvas.addEventListener('pointerup', pointerUp)
    canvas.addEventListener('wheel', wheel, { passive: true })
    this.scene.onDisposeObservable.addOnce(() => {
      canvas.removeEventListener('pointerdown', pointerDown)
      canvas.removeEventListener('pointerup', pointerUp)
      canvas.removeEventListener('wheel', wheel)
    })
    this.engine.runRenderLoop(() => {
      if (this.disposed) return
      const now = performance.now()
      if (this.flight) {
        const f = this.flight
        const t = Math.min(1, (now - f.start) / f.duration)
        Object.assign(this.camera, flightPose(f.from, f.place, t))
        f.progress(t)
        if (t === 1) { this.flight = null; f.done() }
      } else if (!this.flying && !this.reducedMotion && now - this.lastInteraction > 5500) {
        this.camera.alpha += Math.min(this.engine.getDeltaTime(), 50) * 0.000025
      }
      this.material.setVector3('cameraPosition', this.camera.position)
      this.atmosphere.setVector3('cameraPosition', this.camera.position)
      this.scene.render()
      this.projectMarkers()
    })
    this.resizeObserver = new ResizeObserver(() => {
      const radius = orbitRadius(canvas.clientWidth, canvas.clientHeight)
      this.fittedRadius = radius
      if (!this.flying) lockOrbit(this.camera, radius)
      this.engine.resize()
    })
    this.resizeObserver.observe(canvas)
  }

  setTactical(value: boolean): void {
    this.tactical = value
    this.material.setFloat('tactical', value ? 1 : 0)
    this.atmosphere.setFloat('tactical', value ? 1 : 0)
    if (this.borders) this.borders.alpha = value ? 0.25 : 0.18
  }

  fly(place: Location, progress: (t: number) => void, done: () => void): void {
    const { alpha, beta, radius } = this.camera
    this.flying = true
    this.camera.detachControl()
    this.camera.lowerRadiusLimit = 1.01
    this.camera.inertialAlphaOffset = this.camera.inertialBetaOffset = this.camera.inertialRadiusOffset = 0
    this.flight = { from: { alpha, beta, radius }, place, start: performance.now(), duration: this.reducedMotion ? 180 : 4300, progress, done }
  }

  cancel(): void {
    this.flight = null
    this.flying = false
    lockOrbit(this.camera, this.fittedRadius)
    this.camera.attachControl(this.canvas, true)
    this.lastInteraction = performance.now()
  }

  private projectMarkers(): void {
    const width = this.engine.getRenderWidth(), height = this.engine.getRenderHeight()
    const viewport = this.camera.viewport.toGlobal(width, height)
    const scale = this.engine.getHardwareScalingLevel()
    for (const { point, element } of this.markers) {
      const visible = !this.flying && Vector3.Dot(point, this.camera.position.subtract(point)) > 0.05
      const p = Vector3.Project(point, Matrix.IdentityReadOnly, this.scene.getTransformMatrix(), viewport)
      const onscreen = visible && p.x > 12 && p.y > 12 && p.x < width - 12 && p.y < height - 12
      element.style.visibility = onscreen ? 'visible' : 'hidden'
      element.style.transform = `translate(${p.x * scale}px, ${p.y * scale}px)`
      element.tabIndex = onscreen ? 0 : -1
    }
  }

  private loadTexture(name: string, ready: (texture: Texture) => void, failed?: () => void): void {
    const texture = new Texture(`${ASSET_ROOT}/${name}`, this.scene, false, false, Texture.TRILINEAR_SAMPLINGMODE, () => {
      if (!this.disposed) ready(texture)
    }, () => { if (!this.disposed) failed?.() })
    texture.anisotropicFilteringLevel = 8
    this.textures.push(texture)
  }

  private async loadBorders(): Promise<void> {
    try {
      const response = await fetch(BORDERS, { signal: this.abort.signal })
      if (!response.ok) return
      const data = await response.json() as GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>
      if (this.disposed) return
      const lines: Vector3[][] = []
      for (const feature of data.features) {
        const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates
        for (const polygon of polygons) for (const ring of polygon) {
          if (ring.length > 1) lines.push(ring.map(([lon, lat]) => Vector3.FromArray(geoPoint(lat, lon, 1.003))))
        }
      }
      this.borders = CreateLineSystem('country-borders', { lines }, this.scene)
      this.borders.color = new Color3(0.72, 0.72, 0.72)
      this.borders.alpha = this.tactical ? 0.25 : 0.18
      this.borders.isPickable = false
    } catch {
      return
    }
  }

  dispose(): void {
    this.disposed = true
    this.abort.abort()
    this.resizeObserver.disconnect()
    this.engine.stopRenderLoop()
    for (const texture of this.textures) texture.dispose()
    this.scene.dispose()
    this.engine.dispose()
  }
}
