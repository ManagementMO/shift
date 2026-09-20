import { describe, expect, it } from 'vitest'
import { bubblePlacement } from '../util'

describe('resident bubble placement', () => {
  it('moves a tall bubble beside the selected entity instead of clipping above the viewport', () => {
    const box = { width: 300, height: 348 }
    const viewport = { width: 1512, height: 744 }
    const placement = bubblePlacement({ x: 756, y: 372 }, box, viewport)
    expect(placement.shifted).toBe(true)
    expect(placement.top).toBeGreaterThanOrEqual(76)
    expect(placement.top + box.height).toBeLessThanOrEqual(viewport.height - 140)
    expect(placement.left + box.width / 2).toBeLessThan(756)
  })

  it('keeps an ordinary above-entity bubble anchored when it fits', () => {
    const placement = bubblePlacement({ x: 600, y: 500 }, { width: 260, height: 160 }, { width: 1512, height: 744 })
    expect(placement).toEqual({ left: 600, top: 314, shifted: false })
  })

  it('keeps edge projections inside the viewport', () => {
    for (const x of [-100, 1500]) {
      const placement = bubblePlacement({ x, y: -10 }, { width: 300, height: 300 }, { width: 1512, height: 744 })
      expect(placement.left - 150).toBeGreaterThanOrEqual(12)
      expect(placement.left + 150).toBeLessThanOrEqual(1500)
      expect(placement.top).toBeGreaterThanOrEqual(76)
    }
  })
})
