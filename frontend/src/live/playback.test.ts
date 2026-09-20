import { afterEach, describe, expect, it, vi } from 'vitest'

import { PlaybackClock } from '../world/playback'

afterEach(() => vi.unstubAllGlobals())

describe('Recorded-frontier playback', () => {
  it('waits at the recorded frontier without inventing future time or losing play intent', () => {
    let callback: FrameRequestCallback = () => {}
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { callback = cb; return 1 })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const clock = new PlaybackClock()
    clock.setHorizon(100)
    clock.setFrontier(2)
    clock.setSpeed(1)
    clock.play()
    callback(3000)
    expect(clock.t).toBe(2)
    expect(clock.playing).toBe(true)
    expect(clock.buffering).toBe(true)
    clock.setFrontier(5)
    callback(4000)
    expect(clock.t).toBe(3)
    expect(clock.buffering).toBe(false)
    clock.pause()
    vi.restoreAllMocks()
  })

  it('clamps seeking to measured history while leaving legacy full replays unchanged', () => {
    const clock = new PlaybackClock()
    clock.setHorizon(100)
    clock.setFrontier(12)
    clock.seek(70)
    expect(clock.t).toBe(12)
    clock.seek(4)
    expect(clock.t).toBe(4)
    clock.setFrontier(null)
    clock.seek(70)
    expect(clock.t).toBe(70)
  })
})
