import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { EventConfigPanel, EventMenu, OrbitalLaserPanel } from './EventPanels'
import type { GodEventDraft } from './model'

const draft: GodEventDraft = { kind: 'orbital', radiusM: 150, durationS: 2.4, intensity: 'high', heading: 0, autoRespond: false }

describe('orbital laser controls', () => {
  it('is an available named event, not an unconnected preview', () => {
    const html = renderToStaticMarkup(<EventMenu onClose={vi.fn()} onSelect={vi.fn()} supportedEvents={['normal', 'orbital']} />)
    const row = html.match(/<button\b[\s\S]*?<\/button>/g)?.find(button => button.includes('Orbital Laser'))
    expect(row).toBeDefined()
    expect(row).not.toContain('gp-event-preview-label')
    expect(row).not.toContain('Orbital Strike')
  })

  it('offers a bounded radius and an explicit target-then-fire flow without irrelevant power or lifetime controls', () => {
    const html = renderToStaticMarkup(<EventConfigPanel draft={draft} onChange={vi.fn()} onPlace={vi.fn()} onCancel={vi.fn()} supported />)
    expect(html).toContain('Affected radius in metres')
    expect(html).toContain('min="25"')
    expect(html).toContain('max="1000"')
    expect(html).toContain('Choose target')
    expect(html).toContain('then fire when ready')
    expect(html).toContain('2.4-second green beam')
    expect(html).not.toContain('Auto-respond')
    expect(html).not.toContain('Event lifetime')
    expect(html).not.toContain('Event intensity')
  })

  it('reports local clearing honestly and offers restoration and another shot', () => {
    const html = renderToStaticMarkup(<OrbitalLaserPanel event={{ strike: { id: 'laser', x: 0, z: 0, radius: 150, firedAt: 1 }, area: 'Toronto', impact: { buildings: 7, entities: 8, developments: 1 } }} onClose={vi.fn()} onRestore={vi.fn()} onAgain={vi.fn()} />)
    expect(html).toContain('Strike complete')
    expect(html).toContain('Buildings cleared')
    expect(html).toContain('Restore area')
    expect(html).toContain('Fire another')
    expect(html).toContain('saved city data stays unchanged')
    expect(html).not.toContain('Estimated Impact')
  })
})
