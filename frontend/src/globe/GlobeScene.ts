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
import { flightPose, focusPose, geoPoint, orbitRadius, lockOrbit, ENTRY_DURATION, GLOBE_FOV, LOCATIONS, type Location, type Orbit } from './flight'

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
  float light = 0.52 + 0.56 * smoothstep(-0.3, 0.95, sun);
  float grey = dot(day, vec3(0.299, 0.587, 0.114));
  vec3 natural = day * vec3(0.92, 1.04, 1.13) + vec3(0.012, 0.027, 0.044);
  vec3 color = mix(natural, vec3(pow(grey, 0.86) * 0.95 + 0.02), tactical) * light;
  color += night * (1.0 - smoothstep(-0.08, 0.32, sun)) * mix(0.4, 0.2, tactical);
  float ocean = 1.0 - smoothstep(0.06, 0.19, day.r);
  float reflection = pow(max(0.0, dot(reflect(-sunDirection, normal), view)), 24.0);
  color += vec3(0.78, 0.86, 0.96) * reflection * ocean * 0.16;
  float rim = pow(1.0 - max(0.0, dot(normal, view)), 3.8);
  color += mix(vec3(0.24, 0.48, 0.76), vec3(0.3), tactical) * rim;
  gl_FragColor = vec4(color, 1.0);
}`

const atmosphereFragment = `
precision highp float;
varying vec3 vPosition;
varying vec3 vNormal;
uniform vec3 cameraPosition;
uniform vec3 sunDirection;
uniform float tactical;
void main() {
  vec3 normal = normalize(vNormal);
  float facing = max(0.0, dot(normal, normalize(cameraPosition - vPosition)));
  float rim = pow(1.0 - facing, 5.0);
  float light = smoothstep(-0.2, 0.8, dot(normal, sunDirection));
  vec3 sky = mix(vec3(0.46, 0.72, 1.0), vec3(1.0, 0.96, 0.9), light * 0.85);
  vec3 color = mix(sky, vec3(0.87, 0.91, 0.96), tactical);
  gl_FragColor = vec4(color, rim * (0.22 + light * 0.12));
}`

export interface GlobeCallbacks {
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
  private tactical = false
  private fittedRadius: number
  private lastInteraction = performance.now()
  private turn: { from: Orbit; place: Location; start: number; duration: number } | null = null
  private flight: { from: Orbit; place: Location; start: number; duration: number; progress: (t: number) => void; done: () => void } | null = null
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  private readonly resizeObserver: ResizeObserver

  constructor(canvas: HTMLCanvasElement, labels: Map<string, HTMLButtonElement>, callbacks: GlobeCallbacks) {
    this.canvas = canvas
    this.engine = new Engine(canvas, true, { alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' })
    this.engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, 1.5))
    this.scene = new Scene(this.engine)
    this.scene.useRightHandedSystem = true
    this.scene.clearColor = new Color4(0, 0, 0, 0)
    this.fittedRadius = orbitRadius(canvas.clientWidth, canvas.clientHeight)
    this.camera = new ArcRotateCamera('orbit', -1.62, 1.12, this.fittedRadius, Vector3.Zero(), this.scene)
    this.camera.fov = GLOBE_FOV
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
    this.material.setFloat('tactical', 0)
    const dayFallback = RawTexture.CreateRGBATexture(new Uint8Array([35, 72, 112, 255]), 1, 1, this.scene)
    const nightFallback = RawTexture.CreateRGBATexture(new Uint8Array([0, 0, 0, 255]), 1, 1, this.scene)
    this.textures.push(dayFallback, nightFallback)
    this.material.setTexture('dayMap', dayFallback)
    this.material.setTexture('nightMap', nightFallback)
    const earth = CreateSphere('earth', { diameter: 2, segments: 96 }, this.scene)
    earth.material = this.material
    earth.isPickable = false
    this.loadTexture('earth_day_4096.jpg', (texture) => this.material.setTexture('dayMap', texture), callbacks.imageryError)
    this.loadTexture('earth_night_4096.jpg', (texture) => this.material.setTexture('nightMap', texture))

    this.atmosphere = new ShaderMaterial('atmosphere', this.scene, { vertexSource: vertex, fragmentSource: atmosphereFragment }, { ...shaderOptions, needAlphaBlending: true })
    this.atmosphere.alphaMode = Constants.ALPHA_COMBINE
    this.atmosphere.disableDepthWrite = true
    this.atmosphere.setFloat('tactical', 0)
    const glow = CreateSphere('atmosphere', { diameter: 2.016, segments: 96 }, this.scene)
    glow.material = this.atmosphere
    glow.isPickable = false

    void this.loadBorders()

    this.markers = LOCATIONS.flatMap((place) => {
      const element = labels.get(place.id)
      return element ? [{ point: Vector3.FromArray(geoPoint(place.lat, place.lon, 1.009)), element }] : []
    })
    const interact = () => {
      this.lastInteraction = performance.now()
      this.turn = null
    }
    canvas.addEventListener('pointerdown', interact)
    canvas.addEventListener('keydown', interact)
    canvas.addEventListener('wheel', interact, { passive: true })
    this.scene.onDisposeObservable.addOnce(() => {
      canvas.removeEventListener('pointerdown', interact)
      canvas.removeEventListener('keydown', interact)
      canvas.removeEventListener('wheel', interact)
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
      } else if (this.turn) {
        const t = Math.min(1, (now - this.turn.start) / this.turn.duration)
        const pose = focusPose(this.turn.from, this.turn.place, t)
        this.camera.alpha = pose.alpha
        this.camera.beta = pose.beta
        if (t === 1) this.turn = null
      } else if (!this.flying && !this.reducedMotion && now - this.lastInteraction > 10000) {
        this.camera.alpha += Math.min(this.engine.getDeltaTime(), 50) * 0.000004
      }
      const view = this.camera.position.normalizeToNew()
      const right = Vector3.Cross(Vector3.UpReadOnly, view).normalize()
      const sun = view.scale(0.85).add(right.scale(0.55)).add(new Vector3(0, 0.65, 0)).normalize()
      this.material.setVector3('cameraPosition', this.camera.position)
      this.material.setVector3('sunDirection', sun)
      this.atmosphere.setVector3('cameraPosition', this.camera.position)
      this.atmosphere.setVector3('sunDirection', sun)
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
    if (this.borders) this.borders.setEnabled(value)
  }

  focus(place: Location): void {
    if (this.flying) return
    const { alpha, beta, radius } = this.camera
    this.lastInteraction = performance.now()
    this.camera.inertialAlphaOffset = this.camera.inertialBetaOffset = 0
    if (this.reducedMotion) Object.assign(this.camera, focusPose({ alpha, beta, radius }, place, 1))
    else this.turn = { from: { alpha, beta, radius }, place, start: this.lastInteraction, duration: 1100 }
  }

  fly(place: Location, progress: (t: number) => void, done: () => void): void {
    const { alpha, beta, radius } = this.camera
    this.turn = null
    this.flying = true
    this.camera.detachControl()
    this.camera.lowerRadiusLimit = 1.01
    this.camera.inertialAlphaOffset = this.camera.inertialBetaOffset = this.camera.inertialRadiusOffset = 0
    this.flight = { from: { alpha, beta, radius }, place, start: performance.now(), duration: this.reducedMotion ? 180 : ENTRY_DURATION, progress, done }
  }

  cancel(): void {
    this.flight = null
    this.turn = null
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
      this.borders.color = new Color3(0.8, 0.87, 0.94)
      this.borders.alpha = 0.16
      this.borders.setEnabled(this.tactical)
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
