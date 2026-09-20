import type { PopulationIndex } from '../population'
import type { ReplayIndex } from '../replay'
import { selectedResidentId } from '../selection'
import type { Selection } from '../store'

/** A selected recording must never fall back to the unexecuted definition during refresh. */
export function residentDetailsSource(primaryRunId: string | null, replay: ReplayIndex | null, initial: PopulationIndex | null, selection: Selection, t: number) {
  const population = primaryRunId ? replay?.population ?? null : initial
  const residentId = primaryRunId && replay
    ? selectedResidentId(replay, selection, t)
    : selection?.kind === 'resident' ? selection.id : null
  return { population, residentId, time: primaryRunId ? t : 0 }
}
