import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rememberedSharp, rememberSharp, shouldDropHd } from './adaptiveQuality'

// the unit environment has no DOM storage; a plain map stands in for the browser's
beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) })
})
afterEach(() => vi.unstubAllGlobals())

describe('adaptive HD', () => {
  it('drops HD only on a sustained low median, never on a single hitch', () => {
    expect(shouldDropHd([12, 14, 13, 15, 12])).toBe(true)
    expect(shouldDropHd([60, 58, 9, 59, 60])).toBe(false)
    expect(shouldDropHd([20, 22])).toBe(false) // not enough samples yet
    expect(shouldDropHd([27, 27, 27, 27, 27])).toBe(true)
    expect(shouldDropHd([28, 30, 29, 31, 28])).toBe(false)
  })

  it('remembers the decision on this browser', () => {
    expect(rememberedSharp()).toBeNull()
    rememberSharp(false)
    expect(rememberedSharp()).toBe(false)
    rememberSharp(true)
    expect(rememberedSharp()).toBe(true)
  })
})
