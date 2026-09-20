import type { WorldScene } from './scene'

export function suspendCamera(scene: WorldScene): () => void {
  const canvas = scene.canvas, camera = scene.camera.cam
  const cursor = canvas.style.cursor
  const controls = camera.inputs.attachedToElement
  const travel = scene.keys.enabled
  scene.camera.cancel()
  scene.keys.setEnabled(false)
  camera.detachControl()
  camera.inertialAlphaOffset = camera.inertialBetaOffset = camera.inertialRadiusOffset = 0
  camera.inertialPanningX = camera.inertialPanningY = 0
  camera.movement.resetPanVelocity()
  canvas.style.cursor = 'crosshair'
  return () => {
    canvas.style.cursor = cursor
    if (!scene.scene.isDisposed) {
      scene.keys.setEnabled(travel)
      if (controls && !scene.camera.fixed) camera.attachControl(false, true, 1)
    }
  }
}
