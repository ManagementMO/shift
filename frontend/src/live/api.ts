import type { LiveCommand, LiveConfig, LiveMetadata, LivePreview, LiveSession } from './types'

const BASE = import.meta.env.VITE_API_BASE ?? ''

async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${BASE}/api/live${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    const value = await response.json().catch(() => null)
    throw new Error(typeof value?.detail === 'string' ? value.detail : `Live simulation: HTTP ${response.status}`)
  }
  return response.json() as Promise<T>
}

export const liveApi = {
  list: () => request<LiveSession[]>(''),
  create: (config: Partial<LiveConfig> & { pack_id: string }) => request<LiveSession>('', config),
  state: (id: string, signal?: AbortSignal) => request<LiveSession>(`/${id}`, undefined, signal),
  metadata: (id: string, signal?: AbortSignal) => request<LiveMetadata>(`/${id}/metadata`, undefined, signal),
  advance: (id: string, target_s: number) => request<LiveSession>(`/${id}/advance`, { target_s }),
  pause: (id: string) => request<LiveSession>(`/${id}/pause`, {}),
  resume: (id: string) => request<LiveSession>(`/${id}/resume`, {}),
  close: (id: string) => request<LiveSession>(`/${id}/close`, {}),
  preview: (id: string, command: LiveCommand) => request<LivePreview>(`/${id}/preview`, command),
  apply: (id: string, command: LiveCommand) => request<LiveSession>(`/${id}/commands`, command),
  async chunk(id: string, start: number, signal: AbortSignal): Promise<ArrayBuffer> {
    const response = await fetch(`${BASE}/api/live/${id}/frames/${start}`, { signal })
    if (!response.ok) throw new Error(`Recorded history unavailable: HTTP ${response.status}`)
    return response.arrayBuffer()
  },
}
