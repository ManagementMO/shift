import { describe, expect, it, vi } from 'vitest'
import { suspendCamera } from './placementControls'
import type { WorldScene } from './scene'

function fixture(controls = true, travel = true) {
  const cam = { inputs: { attachedToElement: controls }, detachControl: vi.fn(), attachControl: vi.fn(), movement: { resetPanVelocity: vi.fn() }, inertialAlphaOffset: 1, inertialBetaOffset: 1, inertialRadiusOffset: 1, inertialPanningX: 1, inertialPanningY: 1 }
  return { canvas: { style: { cursor: 'grab' } }, camera: { cam, cancel: vi.fn(), fixed: false }, keys: { enabled: travel, setEnabled: vi.fn() }, scene: { isDisposed: false } }
}

describe('shared event placement controls', () => {
  it('suspends pointer and keyboard travel, drains residual movement and restores the existing pan binding', () => {
    const world = fixture()
    const restore = suspendCamera(world as unknown as WorldScene)
    expect(world.keys.setEnabled).toHaveBeenCalledWith(false)
    expect(world.camera.cam.detachControl).toHaveBeenCalledOnce()
    expect(world.camera.cam.movement.resetPanVelocity).toHaveBeenCalledOnce()
    expect(world.camera.cam.inertialAlphaOffset).toBe(0)
    expect(world.canvas.style.cursor).toBe('crosshair')
    restore()
    expect(world.camera.cam.attachControl).toHaveBeenCalledExactlyOnceWith(false, true, 1)
    expect(world.keys.setEnabled).toHaveBeenLastCalledWith(true)
    expect(world.canvas.style.cursor).toBe('grab')
  })

  it('does not enable controls which were already disabled or touch a disposed scene', () => {
    const world = fixture(false, false)
    suspendCamera(world as unknown as WorldScene)()
    expect(world.keys.setEnabled).toHaveBeenLastCalledWith(false)
    expect(world.camera.cam.attachControl).not.toHaveBeenCalled()
    const disposed = fixture()
    const restore = suspendCamera(disposed as unknown as WorldScene)
    disposed.scene.isDisposed = true
    restore()
    expect(disposed.camera.cam.attachControl).not.toHaveBeenCalled()
    expect(disposed.keys.setEnabled).toHaveBeenCalledExactlyOnceWith(false)
  })
})
