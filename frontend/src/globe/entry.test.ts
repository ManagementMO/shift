import { describe, expect, it } from 'vitest'
import { cityClickAction, ENTRY_CLEAR, ENTRY_HAZE, ENTRY_REVEAL, entryVisuals, flightPose, GLOBE_FILL, GLOBE_FOV, orbitRadius } from './flight'

describe('Seamless city entry', () => {
  it('descends toward the city for most of the flight', () => {
    const from = { alpha: -1.6, beta: 1.1, radius: 3.6 }
    const early = flightPose(from, { lat: 43, lon: -79 }, 0.1)
    expect(early.radius).toBe(from.radius)
    for (const progress of [0.3, 0.55, 0.8, 1]) {
      const pose = flightPose(from, { lat: 43, lon: -79 }, progress)
      expect(pose.radius).toBeLessThan(from.radius)
      expect(pose.radius).toBeGreaterThan(1)
    }
  })

  it('peaks the light mid-flight and only then dissolves the homepage', () => {
    expect(entryVisuals(0)).toEqual({ ui: 1, haze: 0, opacity: 1 })
    expect(entryVisuals(ENTRY_REVEAL).opacity).toBe(1)
    expect(entryVisuals(1).opacity).toBe(0)
    expect(entryVisuals(1).haze).toBeCloseTo(0, 10)
    let peak = 0
    let previous = entryVisuals(0)
    for (let step = 1; step <= 100; step++) {
      const progress = step / 100
      const next = entryVisuals(progress)
      expect(next.haze).toBeGreaterThanOrEqual(0)
      expect(next.haze).toBeLessThanOrEqual(ENTRY_HAZE)
      expect(next.opacity).toBeLessThanOrEqual(previous.opacity)
      expect(next.ui).toBeLessThanOrEqual(previous.ui)
      if (progress <= ENTRY_REVEAL) expect(next.opacity).toBe(1)
      if (next.haze > peak) peak = next.haze
      previous = next
    }
    expect(peak).toBeCloseTo(ENTRY_HAZE, 5)
    expect(entryVisuals(ENTRY_REVEAL).haze).toBeGreaterThan(ENTRY_HAZE * 0.95)
  })

  it('clears the bar and the side panels before the globe starts descending', () => {
    expect(entryVisuals(0).ui).toBe(1)
    expect(entryVisuals(ENTRY_CLEAR).ui).toBe(0)
    expect(entryVisuals(0.15).ui).toBeLessThan(0.85)
    expect(entryVisuals(ENTRY_CLEAR).opacity).toBe(1)
    expect(entryVisuals(ENTRY_CLEAR).haze).toBe(0)
    expect(ENTRY_CLEAR).toBeLessThan(ENTRY_REVEAL)
  })

  it('covers the renderer handoff with light before the city appears', () => {
    for (let step = 0; step < 60; step++) expect(entryVisuals(step / 100).haze).toBe(0)
    expect(entryVisuals(ENTRY_REVEAL).haze).toBeGreaterThan(ENTRY_HAZE * 0.9)
    expect(entryVisuals(0.8).haze).toBeGreaterThan(ENTRY_HAZE * 0.95)
    expect(entryVisuals(1).haze).toBeLessThan(ENTRY_HAZE * 0.5)
  })

  it('requires a second click on the same city to enter', () => {
    expect(cityClickAction(null, { id: 'toronto' })).toBe('select')
    expect(cityClickAction({ id: 'london' }, { id: 'toronto' })).toBe('select')
    expect(cityClickAction({ id: 'toronto' }, { id: 'toronto' })).toBe('enter')
  })

  it('fills most of the workspace without clipping the globe', () => {
    for (const [width, height] of [[900, 450], [660, 360], [320, 520], [288, 240], [1600, 380], [120, 640]]) {
      const radius = orbitRadius(width, height)
      const diameter = height / (Math.tan(GLOBE_FOV / 2) * Math.sqrt(radius * radius - 1))
      expect(diameter / Math.min(width, height)).toBeCloseTo(GLOBE_FILL, 5)
      expect(diameter).toBeLessThan(Math.min(width, height))
    }
  })
})
