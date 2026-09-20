import { afterEach, describe, expect, it } from 'vitest'
import { renderScale, useDisplay } from './display'

afterEach(() => useDisplay.getState().set({ shadows: true, textures: true, sharp: true, projection: 'perspective', lighting: 'afternoon' }))

describe('Display settings', () => {
  it('defaults to the cinematic perspective and supports the cityscape lighting presets', () => {
    expect(useDisplay.getState()).toMatchObject({ projection: 'perspective', sharp: true, textures: true })
    useDisplay.getState().set({ projection: 'isometric', lighting: 'golden' })
    expect(useDisplay.getState()).toMatchObject({ projection: 'isometric', lighting: 'golden', shadows: true })
  })

  it('uses life-size agents by default and keeps enlargement opt-in', () => {
    expect(useDisplay.getState().swarmScale).toBe(1)
    useDisplay.getState().set({ swarmScale: 2.2 })
    expect(useDisplay.getState().swarmScale).toBe(2.2)
    useDisplay.getState().set({ swarmScale: 1 })
  })

  it('caps retina rendering without reducing standard displays below native resolution', () => {
    expect(renderScale(1, false)).toBe(1)
    expect(renderScale(2, false)).toBeCloseTo(2 / 3)
    expect(renderScale(3, true)).toBe(0.5)
    expect(renderScale(0, false)).toBe(1)
  })

  it('supersamples standard displays and renders a 1080p viewport at true 4K in HD mode', () => {
    expect(renderScale(1, true, 1440, 900)).toBe(0.5)
    expect(renderScale(2, true, 1920, 1080)).toBe(0.5)
    expect(renderScale(1, false, 1920, 1080)).toBe(1)
  })

  it('bounds high-DPI GPU load at 4K without rendering below the viewport resolution', () => {
    expect(renderScale(2, true, 2560, 1440)).toBeCloseTo(2 / 3)
    expect(renderScale(2, true, 3840, 2160)).toBe(1)
    expect(renderScale(3, true, 7680, 4320)).toBe(1)
  })

  it('updates one display setting without resetting other choices', () => {
    useDisplay.getState().set({ shadows: false })
    useDisplay.getState().set({ textures: false })
    expect(useDisplay.getState()).toMatchObject({ shadows: false, textures: false, sharp: true })
  })
})
