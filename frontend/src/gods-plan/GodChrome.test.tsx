import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import GodChrome from './GodChrome'
import type { GodHUDProps } from './model'

const props: GodHUDProps = {
  city: 'Toronto', activeTab: 'live', activeTool: 'select', dateLabel: '', timeLabel: '22:31',
  weatherLabel: 'Clear', temperatureLabel: '18°C', statusLabel: 'Live · paused',
  agentCount: 100, playing: false, speed: 1, speeds: [1, 2, 4, 8], is2D: false, command: '',
  onTab: vi.fn(), onTool: vi.fn(), onHome: vi.fn(), onCommandChange: vi.fn(),
  onCommand: vi.fn(), onSuggestion: vi.fn(), onTogglePlay: vi.fn(), onView: vi.fn(),
}

describe('compact city chrome', () => {
  it('shows weather without the top-right clock', () => {
    const html = renderToStaticMarkup(<GodChrome {...props} />)
    expect(html).toContain('aria-label="Weather"')
    expect(html).toContain('18°C')
    expect(html).toContain('Clear')
    expect(html).not.toContain('22:31')
    expect(html).not.toContain('god-chrome__time')
  })

  it('keeps the compact playback bar alongside resident history controls', () => {
    const html = renderToStaticMarkup(<GodChrome {...props} recordingControls={<input aria-label="Resident history playhead" type="range" />} />)
    expect(html).toContain('god-chrome__dock')
    expect(html).toContain('Resume simulation')
    expect(html).toContain('Simulation speed')
    expect(html).toContain('8×')
    expect(html).toContain('Resident history playhead')
  })
})
