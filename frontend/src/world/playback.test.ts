import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clock, simClock } from './playback'

const defaultSpeed = clock.speed
let now = 0
let frame: FrameRequestCallback | null = null

function advance(seconds: number) {
  now += seconds * 1000
  const callback = frame
  frame = null
  callback?.(now)
}

beforeEach(() => {
  now = 0
  frame = null
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    frame = callback
    return 1
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn(() => { frame = null }))
  clock.pause()
  clock.setHorizon(2700)
  clock.seek(0)
  clock.setSpeed(defaultSpeed)
})

afterEach(() => {
  clock.pause()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('playback clock', () => {
  it('defaults to real-time playback', () => {
    expect(clock.speed).toBe(1)
    clock.play()
    advance(1)
    expect(clock.t).toBe(1)
  })

  it('advances at the selected speed and holds time while paused', () => {
    clock.setSpeed(2)
    clock.play()
    advance(1)
    expect(clock.t).toBe(2)
    clock.pause()
    advance(10)
    expect(clock.t).toBe(2)
    clock.setSpeed(4)
    clock.play()
    advance(1)
    expect(clock.t).toBe(6)
  })

  it('notifies controls immediately when speed changes while paused', () => {
    const listener = vi.fn()
    const off = clock.onUi(listener)
    clock.setSpeed(8)
    off()
    expect(listener).toHaveBeenCalledWith(0)
    expect(clock.playing).toBe(false)
  })

  it('stops at the horizon and restarts when played again', () => {
    clock.setSpeed(1)
    clock.setHorizon(2)
    clock.play()
    advance(3)
    expect(clock.t).toBe(2)
    expect(clock.playing).toBe(false)
    clock.play()
    expect(clock.t).toBe(0)
    advance(1)
    expect(clock.t).toBe(1)
  })
})

describe('simulation time', () => {
  it('keeps timeline labels compact', () => {
    expect(simClock(61)).toBe('22:31')
  })

  it('shows seconds on the live clock', () => {
    expect(simClock(1, true)).toBe('22:30:01')
    expect(simClock(61.9, true)).toBe('22:31:01')
  })

  it('wraps at midnight', () => {
    expect(simClock(5400, true)).toBe('00:00:00')
  })
})
