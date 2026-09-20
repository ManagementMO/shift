import { create } from 'zustand'
import { liveApi } from '../live/api'
import type { LiveSession } from '../live/types'
import { locationForPack, type Location } from './flight'

export interface RecentItem {
  session: LiveSession
  location: Location
  title: string
  status: string
  live: boolean
}

/** Human summary of a live city: what is in it and how far it has run. */
export function sessionSummary(session: LiveSession): { title: string; status: string; live: boolean } {
  const people = session.counts?.total ?? session.config.initial_population
  const changes = session.commands.length
  const title = `${people.toLocaleString()} travelers${changes ? ` · ${changes} change${changes === 1 ? '' : 's'}` : ''}`
  const minutes = Math.max(0, Math.floor(Math.max(session.available_until_s, 0) / 60))
  if (session.status === 'failed') return { title, status: 'SUMO stopped', live: false }
  if (session.status === 'completed') return { title, status: `Finished · ${minutes} min simulated`, live: false }
  if (session.status === 'starting' || session.status === 'restoring') return { title, status: 'Starting SUMO', live: true }
  return { title, status: `${session.status === 'running' ? 'Running' : 'Paused'} · ${minutes} min simulated`, live: true }
}

export function recentItems(sessions: LiveSession[], limit = 8): RecentItem[] {
  const items: RecentItem[] = []
  for (const session of sessions) {
    const location = locationForPack(session.pack_id)
    if (!location || session.status === 'failed') continue
    items.push({ session, location, ...sessionSummary(session) })
  }
  // newest first: sessions list in creation order
  return items.reverse().slice(0, limit)
}

interface RecentState {
  items: RecentItem[] | null
  failed: boolean
  loadedAt: number
  refresh: () => Promise<void>
}

let refreshRequest = 0

/** Shared across globe visits so returning from the city shows the last list immediately while it refreshes. */
export const useRecentWork = create<RecentState>((set) => ({
  items: null,
  failed: false,
  loadedAt: 0,
  async refresh() {
    const request = ++refreshRequest
    try {
      const sessions = await liveApi.list()
      if (request === refreshRequest) set({ items: recentItems(sessions), failed: false, loadedAt: Date.now() })
    } catch { if (request === refreshRequest) set({ failed: true }) }
  },
}))

export function relativeTime(iso: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - iso) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}
