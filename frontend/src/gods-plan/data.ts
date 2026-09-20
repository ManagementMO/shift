import { hash01 } from '../babylon/geometry'
import { personStateAt, type ReplayIndex } from '../replay'
import type { CityPack, Traveler } from '../types'
import type { GodCitizen, GodIntensity } from './model'
import { MAYA_PORTRAIT } from './portraits'

const NAMES = ['Maya Chen', 'Daniel Park', 'Aisha Bello', 'Marcus Lee', 'Alex Morgan', 'Sofia Patel', 'Jordan Brooks', 'Priya Shah', 'Noah Wilson', 'Amelia Wong', 'Owen Clarke', 'Leila Hassan']
const STATES = { not_departed: 'At the venue', walking: 'Walking', waiting: 'Waiting for transit', riding: 'On a bus', driving: 'Driving', arrived: 'Arrived', unroutable: 'Route unavailable' }

export function citizenName(id: string): string {
  const ordinal = Number(id.match(/\d+/)?.[0] ?? Math.round(hash01(id) * 1000))
  return NAMES[ordinal % NAMES.length]
}

export function citizenProfile(traveler: Traveler, replay: ReplayIndex | null, t: number, pack: CityPack | null): GodCitizen {
  const state = personStateAt(replay?.personEvents[traveler.person_id], t, traveler.has_car ? 'car' : 'walk')
  const zone = pack?.zones.find((z) => z.zone_id === traveler.dest_zone)?.name ?? traveler.dest_zone
  const events = (replay?.personEvents[traveler.person_id] ?? []).filter((event) => event.t <= t)
  const bus = [...events].reverse().find((event) => event.event === 'board' || event.event === 'alight')
  return {
    id: traveler.person_id,
    name: citizenName(traveler.person_id),
    avatarUrl: citizenName(traveler.person_id) === 'Maya Chen' ? MAYA_PORTRAIT : undefined,
    neighborhood: zone,
    role: 'Synthetic citizen',
    status: STATES[state],
    destination: zone,
    activity: state === 'arrived' ? 'Journey completed' : state === 'not_departed' ? 'Waiting to leave the venue' : `${STATES[state]} toward ${zone}`,
    synthetic: true,
    traits: [traveler.has_car ? 'Has a car' : 'Transit dependent', `${traveler.walk_limit_m} m walking limit`, 'Event traveler'],
    thoughts: [],
    relationships: bus?.event === 'board' && bus.vehicle_id ? [{ id: bus.vehicle_id, name: bus.vehicle_id, role: 'Current vehicle' }] : [],
  }
}

export const PREVIEW_CITIZEN: GodCitizen = {
  id: 'preview-maya', name: 'Maya Chen', avatarUrl: MAYA_PORTRAIT, age: 32, occupation: 'Urban Planner', neighborhood: 'Waterfront',
  role: 'Profile template', status: 'Calm', destination: 'Downtown', activity: 'Profile preview', synthetic: true, isPreview: true,
  quote: 'I want to help make Toronto a more connected and livable city.',
  thoughts: ['“I’m concerned about traffic congestion in my neighborhood. We need better public transit options.”', '“More green spaces would really improve quality of life here. I should propose a new park project.”', '“I hope we can create stronger community connections. Maybe a local event could bring people together.”'],
  thoughtTimes: ['5m ago', '15m ago', '1h ago'],
  traits: ['Connected communities', 'Livable streets', 'Green spaces'],
  relationships: [
    { id: 'preview-daniel', name: 'Daniel Park', role: 'Friend', strength: 0.7, sentiment: 'Good' },
    { id: 'preview-aisha', name: 'Aisha Bello', role: 'Colleague', strength: 0.85, sentiment: 'Strong' },
    { id: 'preview-marcus', name: 'Marcus Lee', role: 'Neighbor', strength: 0.45, sentiment: 'Neutral' },
  ],
}

export function powerIntensity(power: number): GodIntensity {
  return power <= 2 ? 'low' : power <= 3 ? 'medium' : 'high'
}

export function intensityPower(intensity: GodIntensity): number {
  return { low: 1, medium: 3, high: 5 }[intensity]
}

export function scenarioDate(createdAt?: string): string {
  if (!createdAt) return 'Scenario time'
  const date = new Date(createdAt)
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : 'Scenario time'
}
