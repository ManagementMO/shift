import { describe, expect, it } from 'vitest'

import { TORONTO_CITY } from '../world/camera'
import { radiusToZoom, zoomToRadius } from './mapAdapter'

describe('Mapbox zoom ↔ orbit radius', () => {
  it('maps the Toronto city pose to the miniature-city hero scale', () => {
    const r = zoomToRadius(TORONTO_CITY.zoom, TORONTO_CITY.center[1])
    expect(r).toBeGreaterThan(1500)
    expect(r).toBeLessThan(1800)
  })
  it('halves the radius per zoom level', () => {
    const a = zoomToRadius(15, 43.65)
    const b = zoomToRadius(16, 43.65)
    expect(a / b).toBeCloseTo(2, 6)
  })
  it('round-trips through radiusToZoom', () => {
    for (const z of [12, 14.4, 15.05, 17.6]) expect(radiusToZoom(zoomToRadius(z, 43.65), 43.65)).toBeCloseTo(z, 6)
  })
  it('agent zoom lands at street scale', () => {
    const r = zoomToRadius(17.6, 43.65)
    expect(r).toBeGreaterThan(200)
    expect(r).toBeLessThan(320)
  })
})
