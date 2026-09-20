// The one live SUMO city behind the shell. Every tool applies a command to this session; there is no scenario
// building. The controller shares the shell's playback clock so the dock and the bubbles read the same time.

import { useSyncExternalStore } from 'react'

import type { Restriction } from '../types'
import { clock } from '../world/playback'
import { liveApi } from './api'
import { LiveController, type LiveViewState } from './controller'
import type { LiveCounts } from './frames'
import { environmentAt } from './timeline'
import type { Intervention, LiveConfig, LiveSession } from './types'

export const live = new LiveController(clock)

export function useLive(): LiveViewState {
  return useSyncExternalStore(live.subscribe, live.getSnapshot, live.getSnapshot)
}

/** Default city: the live page's setup form values, so arriving from the globe needs no form. */
export const DEFAULT_LIVE_CONFIG: Omit<LiveConfig, 'pack_id'> = { seed: 7, horizon_s: 3600, initial_population: 600, fleet_size: 2, temperature_c: 20, car_share: 0.35 }

/** A restore re-simulates the whole recording; beyond this much history a fresh city starts faster than waiting. */
const QUICK_RESTORE_S = 120
/** Continue a city whose SUMO is alive, or a closed one short enough to restore quickly; anything else starts anew. */
const reusable = (s: LiveSession) =>
  s.available_until_s >= 0 && s.available_until_s < s.horizon_s
  && (s.status === 'paused' || s.status === 'running' || s.status === 'starting' || (s.status === 'closed' && s.available_until_s <= QUICK_RESTORE_S))

/**
 * Enter the city: continue the most recent usable session of this pack, else start a fresh one, and keep it
 * playing. Starting SUMO takes a few seconds; the controller reports progress through `busy`. Closed sessions with a
 * long history stay listed on the globe for an explicit resume rather than blocking arrival on a slow restore.
 */
export async function enterCity(packId: string): Promise<void> {
  live.start()
  clock.setLoop(null) // a live city has no recording to loop; it stops at its horizon
  const sessions = await liveApi.list().catch(() => [] as LiveSession[])
  const latest = sessions.filter((s) => s.pack_id === packId && reusable(s)).at(-1)
  if (latest) await live.open(latest.session_id)
  else await live.create({ pack_id: packId, ...DEFAULT_LIVE_CONFIG })
  if (live.session && !clock.playing) await live.play()
}

export async function newCity(packId: string, config: Partial<Omit<LiveConfig, 'pack_id'>> = {}): Promise<void> {
  await live.create({ pack_id: packId, ...DEFAULT_LIVE_CONFIG, ...config })
}

/**
 * One-click change: SUMO validates the command (the preview step) and, if it is sound, it is applied straight
 * away and the city keeps playing. Returns false — with `live.getSnapshot().error` set — if SUMO refused it.
 */
export async function applyNow(change: Intervention): Promise<boolean> {
  await live.preview(change)
  if (live.getSnapshot().error || !live.getSnapshot().draft) return false
  await live.apply()
  return !live.getSnapshot().error
}

/**
 * The closures in force at sim time `t`, one per close command still standing, in the shape the shell already
 * draws and describes (the restriction card, the Road closures list). Their id is the command id.
 */
export function liveClosuresAt(session: LiveSession | null, t: number, labelFor: (edgeIds: string[]) => string | null = () => null): Restriction[] {
  if (!session) return []
  const open = new Set<string>()
  const out: Restriction[] = []
  for (const command of [...session.commands].reverse()) {
    if (command.at_s > t) continue
    const change = command.intervention
    if (change.kind === 'reopen_road') for (const id of change.edge_ids) open.add(id)
    if (change.kind !== 'close_road' || (change.until_s != null && change.until_s <= t)) continue
    const edge_ids = change.edge_ids.filter((id) => !open.has(id))
    if (!edge_ids.length) continue
    for (const id of edge_ids) open.add(id) // an earlier close of the same edges is superseded
    out.push({
      restriction_id: command.command_id, edge_ids, modes: ['passenger', 'bus'], start_s: command.at_s,
      end_s: change.until_s ?? session.horizon_s, source_claim_id: null,
      label: labelFor(edge_ids) ?? `${edge_ids.length} road segment${edge_ids.length === 1 ? '' : 's'} closed`,
    })
  }
  return out.reverse()
}

/** Cohort counts in the frame at `t` (falls back to the session's latest counts while frames stream in). */
export function liveCountsAt(view: LiveViewState, t: number): LiveCounts | null {
  const channel = view.primary
  if (!channel) return null
  return channel.replay.frameAt(Math.floor(t))?.counts ?? channel.state.counts ?? null
}

export { environmentAt }
