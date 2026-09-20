import { Constants } from '@babylonjs/core/Engines/constants'
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial'
import type { Scene } from '@babylonjs/core/scene'
import '@babylonjs/core/Shaders/ShadersInclude/instancesDeclaration'
import '@babylonjs/core/Shaders/ShadersInclude/instancesVertex'
import type { Batch } from './geometry'

const vertexSource = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 viewProjection;
uniform mat4 view;
uniform float time;
uniform float particleMode;
varying vec2 vUV;
varying vec4 vTint;
varying float vSeed;
#include<instancesDeclaration>
void main() {
  #include<instancesVertex>
  vec3 origin = finalWorld[3].xyz;
  float width = length(finalWorld[0].xyz);
  float height = length(finalWorld[1].xyz);
  vec3 right = normalize(vec3(view[0][0], view[1][0], view[2][0]));
  vec3 up = particleMode > 1.5 ? normalize(vec3(view[0][1], view[1][1], view[2][1])) : vec3(0.0, 1.0, 0.0);
  vSeed = fract(sin(dot(origin.xz, vec2(12.9898, 78.233))) * 43758.5453);
  float bend = sin(time * 4.0 + vSeed * 31.0 + uv.y * 5.0) * uv.y * uv.y * 0.18;
  vec3 offset = right * (position.x + bend) * width + up * position.y * height;
  vUV = uv;
  vTint = vec4(1.0);
  #ifdef INSTANCESCOLOR
  vTint = instanceColor;
  #endif
  gl_Position = viewProjection * vec4(origin + offset, 1.0);
}
`

const fragmentSource = `
precision highp float;
uniform float time;
uniform float opacity;
uniform float particleMode;
varying vec2 vUV;
varying vec4 vTint;
varying float vSeed;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float turbulence(vec2 p) {
  return noise(p) * 0.58 + noise(p * 2.03 + 19.2) * 0.28 + noise(p * 4.01 + 7.7) * 0.14;
}
void main() {
  vec2 uv = vUV;
  float alpha;
  vec3 tint;
  if (particleMode > 1.5) {
    float n = turbulence(uv * 4.0 + vec2(vSeed * 20.0, -time * 0.2));
    float edge = length((uv - 0.5) * vec2(1.0, 0.95));
    alpha = (1.0 - smoothstep(0.2, 0.5, edge)) * (0.45 + 0.55 * n);
    tint = mix(vec3(0.10, 0.095, 0.085), vec3(0.34, 0.33, 0.31), n);
  } else {
    float n = turbulence(vec2(uv.x * 4.3, uv.y * 5.8 - time * 3.3) + vSeed * 27.0);
    float x = uv.x * 2.0 - 1.0;
    float bend = sin(uv.y * 7.0 - time * 5.0 + vSeed * 30.0) * uv.y * 0.18;
    float width = (1.0 - pow(uv.y, 0.72)) * 0.65 + n * 0.3;
    float body = 1.0 - smoothstep(width * 0.55, width, abs(x + bend));
    float tip = 1.0 - smoothstep(0.62 + n * 0.26, 1.0, uv.y);
    alpha = body * tip * smoothstep(0.0, 0.05, uv.y);
    float heat = clamp(1.1 - uv.y - abs(x) * 0.8 + n * 0.4, 0.0, 1.0);
    tint = mix(vec3(1.0, 0.055, 0.006), vec3(1.0, 0.48, 0.035), heat);
    tint = mix(tint, vec3(1.0, 0.95, 0.64), pow(heat, particleMode > 0.5 ? 2.0 : 5.0));
  }
  alpha *= vTint.a * opacity;
  if (alpha < 0.006) discard;
  gl_FragColor = vec4(pow(tint, vec3(2.2)), alpha);
}
`

export function fireParticleMaterial(name: string, scene: Scene, mode: 'flame' | 'flameCore' | 'smoke', preview: boolean): ShaderMaterial {
  const material = new ShaderMaterial(name, scene, { vertexSource, fragmentSource }, {
    attributes: ['position', 'uv'],
    uniforms: ['world', 'view', 'viewProjection', 'time', 'opacity', 'particleMode'],
    needAlphaBlending: true,
  })
  material.backFaceCulling = false
  material.disableDepthWrite = true
  material.depthFunction = Constants.ALWAYS
  material.alphaMode = mode === 'flameCore' ? Constants.ALPHA_ADD : Constants.ALPHA_COMBINE
  material.setFloat('time', 0)
  material.setFloat('opacity', preview ? 0.65 : 1)
  material.setFloat('particleMode', mode === 'smoke' ? 2 : mode === 'flameCore' ? 1 : 0)
  return material
}

export function fireParticleQuad(b: Batch): void {
  const a = b.vertex(-1, 0, 0, 0, 0, -1, [1, 1, 1], 0, 0)
  const c = b.vertex(1, 0, 0, 0, 0, -1, [1, 1, 1], 1, 0)
  const d = b.vertex(1, 1, 0, 0, 0, -1, [1, 1, 1], 1, 1)
  const e = b.vertex(-1, 1, 0, 0, 0, -1, [1, 1, 1], 0, 1)
  b.indices.push(a, c, d, a, d, e)
}
