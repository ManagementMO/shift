import { HAZARDS, type Intervention, type LiveSession } from './types'

export function environmentAt(session: LiveSession, t: number) {
  let temperature = session.config.temperature_c
  let population = session.config.initial_population
  const closedEdges = new Set<string>()
  const assignedBuses = new Set<string>()
  for (const command of session.commands) {
    if (command.at_s > t) continue
    const change = command.intervention
    if (change.kind === 'temperature') temperature = change.temperature_c
    else if (change.kind === 'population') population += change.count
    else if (change.kind === 'add_bus_route') assignedBuses.add(change.bus_id)
    else if (change.kind === 'reopen_road') for (const id of change.edge_ids) closedEdges.delete(id)
    else if (change.kind === 'close_road' && (change.until_s == null || change.until_s > t)) for (const id of change.edge_ids) closedEdges.add(id)
  }
  return { temperature, population, closedEdges, assignedBuses }
}

export function interventionLabel(change: Intervention): string {
  switch (change.kind) {
    case 'temperature': return `Temperature ${change.temperature_c}°C`
    case 'population': return `+${change.count.toLocaleString()} inbound travelers`
    case 'add_bus_route': return `${change.bus_id.replace('_', ' ')} route added`
    case 'close_road': return `${change.edge_ids.length} road segments closed`
    case 'reopen_road': return `${change.edge_ids.length} road segments reopened`
    case 'incident': return `${change.label ?? HAZARDS.find(h => h.id === change.hazard)?.label ?? change.hazard} · ${change.radius_m} m`
    case 'development': return `${change.spec.name} placed`
    case 'remove_development': return 'development demolished'
  }
}

export function elapsed(t: number): string {
  const seconds = Math.max(0, Math.floor(t))
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}
