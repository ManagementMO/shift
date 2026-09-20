import { create } from 'zustand'
import { api } from './api'
import { useStore } from './store'
import type { PopulationStimulus } from './types'

type Draft = Omit<PopulationStimulus, 'stimulus_id'>
type State = {
  populationId: string | null
  pending: PopulationStimulus[]
  notice: string | null
  busy: boolean
  clearPending: () => void
  reset: (populationId: string | null) => void
}

export const usePopulationStimuli = create<State>((set, get) => ({
  populationId: null, pending: [], notice: null, busy: false,
  clearPending: () => set({ pending: [] }),
  reset: populationId => {
    if (get().populationId !== populationId) set({ populationId, pending: [], notice: null })
  },
}))

/** Sending a warning never starts/resumes inference. Archived history remains immutable. */
export async function sendPopulationStimulus(draft: Draft): Promise<boolean> {
  const city = useStore.getState()
  const definition = city.populationDefinition
  if (!city.populationActive || !definition) {
    city.setError('Create or select a native swarm before sending an event.')
    return false
  }
  if (!draft.text.trim() || draft.text.length > 400) { city.setError('Use a message between 1 and 400 characters.'); return false }
  usePopulationStimuli.getState().reset(definition.population_id)
  const run = city.runs.find(r => r.status === 'running' || r.status === 'queued')
    ?? city.runs.find(r => r.run_id === city.primaryRunId && r.status === 'paused' && r.checkpoint_available)
  const stimulus: PopulationStimulus = { ...draft, stimulus_id: `input-${crypto.randomUUID()}` }
  if (!run) {
    const pending = usePopulationStimuli.getState().pending
    if (pending.length >= 20) { city.setError('Start the swarm or clear its pending events before adding more.'); return false }
    usePopulationStimuli.setState({ pending: [...pending, stimulus], notice: 'Event queued for the next new swarm run. Start the swarm to let residents observe and respond.' })
    return true
  }
  usePopulationStimuli.setState({ busy: true })
  try {
    await api.sendPopulationStimulus(run.run_id, stimulus)
    usePopulationStimuli.setState({ notice: run.status === 'paused'
      ? 'Event queued. Resume this run to let residents observe and respond.'
      : 'Event queued for the next decision boundary. Inspect residents for their responses.' })
    return true
  } catch (error) {
    city.setError(String(error))
    return false
  } finally { usePopulationStimuli.setState({ busy: false }) }
}

/** Explicit temperatures are authoritative inputs; other text is delivered as the operator's message. */
export function stimulusFromPrompt(text: string): Draft {
  const match = /(?:temperature|heat|cool).*?(-?\d+(?:\.\d+)?)\s*(?:°?\s*c(?:elsius)?)?\b/i.exec(text)
  if (match && !/\b(?:by|increase|decrease|raise|lower)\s+(?!.*\bto\b)/i.test(text)) {
    const value = Number(match[1])
    if (value >= -40 && value <= 50) return { kind: 'temperature', text, temperature_c: value, duration_s: 600 }
  }
  return { kind: 'announcement', text, duration_s: 600 }
}
