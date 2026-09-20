import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PopulationRunActionsView } from './PopulationRunActions'
import { run } from '../population.testData'

const paused = run({ run_kind: 'population', population_id: 'population', status: 'paused' })

describe('explicit population lifecycle controls', () => {
  it('does not dispatch execution actions while rendering paused or requested states', () => {
    const onPause = vi.fn()
    const onResume = vi.fn()
    const onStop = vi.fn()
    const callbacks = { onPause, onResume, onStop }
    const html = renderToStaticMarkup(<PopulationRunActionsView run={paused} resumeReason={null} {...callbacks} />)
    expect(html).toContain('Resume same run')
    expect(html).toContain('revalidates paired hashes and versions')
    expect(html).not.toContain('checkpoint complete')
    const pending = renderToStaticMarkup(<PopulationRunActionsView run={{ ...paused, status: 'running' }} action={{ action: 'pause', phase: 'requested' }} resumeReason={null} {...callbacks} />)
    expect(pending).toContain('Pause requested, not confirmed')
    expect(pending).toContain('Stop (no checkpoint request)')
    expect(onPause).not.toHaveBeenCalled()
    expect(onResume).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
  })

  it('labels interrupted-checkpoint recovery as conditional and surfaces resume validation errors', () => {
    const html = renderToStaticMarkup(<PopulationRunActionsView run={{ ...paused, status: 'failed' }} action={{ action: 'resume', phase: 'error', message: 'Paired checkpoint hash mismatch' }} resumeReason={null} onPause={() => {}} onResume={() => {}} onStop={() => {}} />)
    expect(html).toContain('Validate checkpoint &amp; resume')
    expect(html).toContain('No checkpoint validity is exposed here')
    expect(html).toContain('Paired checkpoint hash mismatch')
  })

  it('disables gated resume and does not expose population actions on transport or canceled runs', () => {
    const props = { resumeReason: 'Native execution is limited to 100 residents', onPause: () => {}, onResume: () => {}, onStop: () => {} }
    const html = renderToStaticMarkup(<PopulationRunActionsView run={paused} {...props} />)
    expect(html).toContain('disabled=""')
    expect(html).toContain(props.resumeReason)
    expect(renderToStaticMarkup(<PopulationRunActionsView run={run()} {...props} />)).toBe('')
    expect(renderToStaticMarkup(<PopulationRunActionsView run={{ ...paused, status: 'canceled' }} {...props} />)).not.toContain('<button')
  })
})
