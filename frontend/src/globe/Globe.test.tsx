import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import Globe from './Globe'
import { LOCATIONS } from './flight'

function render(overrides: Partial<ComponentProps<typeof Globe>> = {}) {
  return renderToStaticMarkup(<Globe phase="globe" selected={null} error={null} onSelect={vi.fn()} onReveal={vi.fn()} onComplete={vi.fn()} onCancel={vi.fn()} {...overrides} />)
}

describe('God’s Plan homepage', () => {
  it('keeps the landing page focused on choosing a city', () => {
    const html = render()
    expect(html).toContain('God&#x27;s Plan')
    expect(html).toContain('Choose City')
    expect(html).toContain('Search cities')
    expect(html).toContain('Select a city. Click again to enter.')
    expect(html).toContain('orbital-bar')
    expect(html).toContain('aria-label="Close settings"')
    expect(html).not.toContain('orbital-launch')
    expect(html).not.toContain('orbital-enter')
    expect(html).not.toContain('Toronto prototype')
    expect(html).not.toContain('Concrete Consequences')
    expect(html).not.toContain('recent-work')
    expect(html).not.toContain('orbital-intro')
  })

  it('makes every destination available without a working globe renderer', () => {
    const html = render()
    for (const place of LOCATIONS) expect(html).toContain(`aria-label="Choose ${place.name}"`)
    expect(html).toContain('aria-label="Close settings"')
    expect(html).toContain('Reset preferences')
  })

  it('names the selected city as the second click target everywhere', () => {
    const html = render({ selected: LOCATIONS.find((place) => place.id === 'london')! })
    expect(html).toContain('aria-label="Enter London"')
    expect(html).toContain('Click London again to enter.')
    expect(html).toContain('aria-label="Enter London on globe"')
  })

  it('uses the chosen city’s name throughout preparation and leaves cancellation available', () => {
    const html = render({ phase: 'preparing', selected: LOCATIONS.find((place) => place.id === 'london')! })
    expect(html).toContain('Preparing London')
    expect(html).not.toContain('Preparing Toronto')
    expect(html).toContain('Cancel')
    expect(html).toContain('aria-label="Flight progress"')
  })

  it('keeps flight cancellable without putting a loading card over the transition', () => {
    const html = render({ phase: 'flight', selected: LOCATIONS[0] })
    expect(html).not.toContain('orbital-flight-status')
    expect(html).not.toContain('orbital-entry-cancel')
    expect(html).toContain('aria-label="Flight progress"')
  })

  it('shows an entry failure without replacing the city picker', () => {
    const html = render({ phase: 'preparing', selected: LOCATIONS[0], error: 'City service is unavailable' })
    expect(html).toContain('City service is unavailable')
    expect(html).toContain('Unable to open city')
    expect(html).toContain('Choose City')
    expect(html).toContain('Cancel')
  })
})
