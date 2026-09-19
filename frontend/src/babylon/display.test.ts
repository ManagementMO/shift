import { afterEach, describe, expect, it } from 'vitest'
import { renderScale, useDisplay } from './display'

afterEach(() => useDisplay.getState().set({ shadows: true, textures: true, sharp: false, projection: 'perspective', lighting: 'afternoon' }))

describe('Display settings', () => {
  it('defaults to the cinematic perspective and supports the cityscape lighting presets', () => {
    expect(useDisplay.getState().projection).toBe('perspective')
    useDisplay.getState().set({ projection: 'isometric', lighting: 'golden' })
    expect(useDisplay.getState()).toMatchObject({ projection: 'isometric', lighting: 'golden', shadows: true })
  })

  it('caps retina rendering without reducing standard displays below native resolution', () => {
    expect(renderScale(1, false)).toBe(1)
    expect(renderScale(2, false)).toBeCloseTo(2 / 3)
    expect(renderScale(3, true)).toBe(0.5)
    expect(renderScale(0, false)).toBe(1)
  })

  it('updates one display setting without resetting other choices', () => {
    useDisplay.getState().set({ shadows: false })
    useDisplay.getState().set({ textures: false })
    expect(useDisplay.getState()).toMatchObject({ shadows: false, textures: false, sharp: false })
  })
})
