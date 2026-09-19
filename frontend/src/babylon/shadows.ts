import type { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'

export function fitShadowLight(light: DirectionalLight, bounds: readonly number[], height: number): void {
  const [x0, z0, x1, z1] = bounds
  const center = new Vector3((x0 + x1) / 2, height / 2, (z0 + z1) / 2)
  const radius = Math.hypot((x1 - x0) / 2, (z1 - z0) / 2, height / 2) + 80
  light.position = center.subtract(light.direction.normalizeToNew().scale(radius * 2))
  light.shadowFrustumSize = 0
  light.orthoLeft = light.orthoBottom = -radius
  light.orthoRight = light.orthoTop = radius
  light.shadowOrthoScale = 0
  light.shadowMinZ = radius * 0.5
  light.shadowMaxZ = radius * 3.5
  light.autoUpdateExtends = false
  light.autoCalcShadowZBounds = false
}
