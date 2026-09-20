import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ResidentInspector from './ResidentInspector'
import { buildPopulationIndex } from '../population'
import { populationArtifact } from '../population.testData'

const population = buildPopulationIndex(populationArtifact())
const render = (t: number, residentId = 'r1') => renderToStaticMarkup(<ResidentInspector population={population} residentId={residentId} t={t} onSelect={() => {}} onClose={() => {}} />)

describe('recorded resident inspector', () => {
  it('keeps optional camera actions in the resident header without offering unavailable actions', () => {
    const html = renderToStaticMarkup(<ResidentInspector population={population} residentId="r1" t={12} onSelect={() => {}} onClose={() => {}} onFrame={() => {}} onFollow={() => {}} />)
    expect(html).toContain('>Follow</button>')
    expect(html).toContain('>Frame</button>')
    expect(html.indexOf('>Follow</button>')).toBeLessThan(html.indexOf('synthetic resident'))
    expect(html.indexOf('>Frame</button>')).toBeLessThan(html.indexOf('synthetic resident'))
    expect(render(12)).not.toContain('>Follow</button>')
    expect(render(12)).not.toContain('>Frame</button>')
    expect(render(12)).toContain('>Close</button>')
  })

  it('puts the recorded explanation and actual provenance before setup and history', () => {
    const html = render(12)
    expect(html.indexOf('Recorded generated summary')).toBeLessThan(html.indexOf('Preferences and responsibilities'))
    expect(html.indexOf('Actual latest decision')).toBeLessThan(html.indexOf('Relevant task ledger'))
    expect(html.indexOf('Authority acceptance')).toBeLessThan(html.indexOf('Contacts and relationships'))
    expect(html.indexOf('Current recorded plan')).toBeLessThan(html.indexOf('Decision history'))
    expect(html).toContain('not hidden model reasoning')
    expect(html).toContain('<summary>Recorded messages</summary>')
    expect(html).toContain('<summary>Observations and memories')
  })

  it('never renders future summaries, task versions, memories, or incoming messages while scrubbing backwards', () => {
    expect(render(60)).toContain('FUTURE MEMORY')
    const html = render(30)
    expect(html).toContain('Reached shop.')
    expect(html).toContain('I will collect the request.')
    expect(html).not.toContain('FUTURE MEMORY')
    expect(html).not.toContain('FUTURE MESSAGE')
    expect(html).not.toContain('future-job')
    expect(html).not.toContain('Waiting after timeout.')
    expect(html).not.toContain('Delivered.')
    expect(render(11)).not.toContain('I will collect the request.')
    expect(render(19, 'r2')).not.toContain('On my way.')
    expect(render(20, 'r2')).toContain('On my way.')
  })

  it('separates proposal, validation, observed outcome, beliefs, and actual source from assigned brain', () => {
    const html = render(12)
    expect(html).toContain('Recorded generated summary')
    expect(html).toContain('Proposal')
    expect(html).toContain('Authority acceptance')
    expect(html).toContain('Accepted action')
    expect(html).toContain('No observed outcome recorded yet')
    expect(html).toContain('Beliefs, not authoritative facts')
    expect(html).toContain('Assigned brain')
    expect(html).toContain('Actual latest decision')
    expect(html).toContain('claude-test')
    expect(html).toContain('claude-resolved')
    expect(html).toContain('Run-level mappings, not timestamped worker history')
    const fallback = render(35)
    expect(fallback).toContain('Fallback: timeout')
    expect(fallback).toContain('source: <b>fallback</b>')
    expect(fallback).toContain('actual model: <b>none recorded</b>')
    expect(fallback).not.toContain('<h2>Recorded generated summary</h2>')
  })

  it('shows only timestamped mappings known at the scrub time, including equal-time restored generations', () => {
    const artifact = populationArtifact()
    const first = { ...artifact.swarm_bindings[0], bound_s: 10 }
    artifact.swarm_bindings = [first, { ...first, bound_s: 30, generation: 1, restored: true, worker_id: 'FUTURE-RESTORED-WORKER', session_id: 'FUTURE-RESTORED-SESSION' }]
    const p = buildPopulationIndex(artifact)
    const html = (t: number) => renderToStaticMarkup(<ResidentInspector population={p} residentId="r1" t={t} onSelect={() => {}} onClose={() => {}} />)
    expect(html(9)).toContain('No timestamped native mapping recorded by this time')
    expect(html(29)).toContain('Latest mapping at selected time')
    expect(html(29)).not.toContain('FUTURE-RESTORED-WORKER')
    expect(html(29)).not.toContain('FUTURE-RESTORED-SESSION')
    expect(html(30)).toContain('FUTURE-RESTORED-WORKER')
    expect(html(30)).toContain('generation 1')
    expect(html(30)).toContain('bound +00:30')
    expect(html(29)).not.toContain('FUTURE-RESTORED-WORKER')
  })

  it('labels static anchor presence explicitly rather than claiming a measured interior or walking position', () => {
    expect(render(0)).toContain('Abstract stationary presence at home; not measured movement or an interior position.')
    expect(render(10)).toContain('Measured mobility binding: bike-body')
    expect(render(45)).toContain('Aboard shared vehicle shared-bus; passenger identity does not color the vehicle.')
  })
})
