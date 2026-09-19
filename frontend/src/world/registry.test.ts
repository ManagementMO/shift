import { afterEach, describe, expect, it, vi } from 'vitest'

import { cameraTo, registerMap, watchCameraMode, type SyncMap } from './registry'
import { TORONTO_CITY } from './camera'

const cleanup: (() => void)[] = []

function register(overrides: Partial<SyncMap> = {}) {
  const map: SyncMap = {
    cameraLocked: true,
    jumpTo: vi.fn(), easeTo: vi.fn(), flyTo: vi.fn(), on: vi.fn(), off: vi.fn(),
    isMoving: () => false, getCenter: () => ({ lng: -79.3848, lat: 43.6438 }),
    getZoom: () => 15, getPitch: () => 38, getBearing: () => 22,
    project: () => ({ x: 0, y: 0 }), ...overrides,
  }
  cleanup.push(registerMap('solo', map))
  return map
}

afterEach(() => {
  for (const off of cleanup.splice(0)) off()
})

describe('camera preset dispatch', () => {
  it('uses the bounded preset handler while keeping free camera movement locked', () => {
    const setCameraPreset = vi.fn()
    const onMode = vi.fn()
    const map = register({ setCameraPreset })
    cleanup.push(watchCameraMode(onMode))
    cameraTo(TORONTO_CITY, 'district')
    expect(setCameraPreset).toHaveBeenCalledExactlyOnceWith(TORONTO_CITY, 'district')
    expect(onMode).toHaveBeenCalledWith('district')
    expect(map.easeTo).not.toHaveBeenCalled()
    expect(map.flyTo).not.toHaveBeenCalled()
  })

  it('leaves locked renderers without a bounded preset handler unchanged', () => {
    const map = register()
    const onMode = vi.fn()
    cleanup.push(watchCameraMode(onMode))
    cameraTo(TORONTO_CITY, 'district')
    expect(map.easeTo).not.toHaveBeenCalled()
    expect(map.flyTo).not.toHaveBeenCalled()
    expect(onMode).not.toHaveBeenCalled()
  })

  it('uses preset framing without locking an otherwise free camera', () => {
    const setCameraPreset = vi.fn()
    const map = register({ cameraLocked: false, setCameraPreset })
    cameraTo(TORONTO_CITY, 'district')
    expect(setCameraPreset).toHaveBeenCalledExactlyOnceWith(TORONTO_CITY, 'district')
    expect(map.easeTo).not.toHaveBeenCalled()
    expect(map.cameraLocked).toBe(false)
  })

  it('keeps normal camera transitions available for unlocked renderers', () => {
    const map = register({ cameraLocked: false })
    cameraTo(TORONTO_CITY, 'district')
    expect(map.easeTo).toHaveBeenCalled()
  })
})
