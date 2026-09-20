/**
 * Hard-coded example personas for the travelers of the live city.  Everything here is illustrative and deterministic:
 * the same traveler always gets the same name, job, neighbourhood, traits and relationships (seeded by its id), while
 * the *current activity* is read from what SUMO is really doing with it (walking, driving, waiting, riding, arrived).
 * None of it is model-generated and none of it feeds the simulation.
 */

import type { LiveEntity } from '../live/types'
import type { CityPack } from '../types'
import { hash01 } from '../babylon/geometry'
import type { GodCitizen } from './model'

const JOBS = ['Nurse at St. Michael\'s', 'Line cook, Queen West', 'Software developer', 'Streetcar operator', 'Elementary school teacher', 'Paralegal, Bay Street', 'Barista', 'Civil engineer', 'Warehouse supervisor', 'Graduate student, U of T', 'Real estate agent', 'Bike courier', 'Dental hygienist', 'Sound technician', 'Retired postal worker', 'Security guard, Union Station', 'Pharmacist', 'Freelance illustrator', 'Financial analyst', 'Hotel concierge']
const NEIGHBOURHOODS = ['Liberty Village', 'St. Lawrence Market', 'The Annex', 'Leslieville', 'Parkdale', 'Cabbagetown', 'Kensington Market', 'CityPlace', 'Roncesvalles', 'The Beaches', 'Corktown', 'Little Italy']
const TRAITS = ['punctual', 'easily distracted', 'chatty', 'cautious', 'stubborn', 'generous', 'anxious in crowds', 'always early', 'night owl', 'follows the crowd', 'trusts strangers', 'reads every sign', 'impatient', 'protective', 'optimistic', 'skeptical of announcements']
const MOODS = ['tired but cheerful', 'restless', 'calm', 'irritated', 'excited', 'worn out', 'focused', 'wary']
const RELATION_ROLES: [string, string][] = [
  ['Partner', 'walks home together most nights'], ['Sister', 'texts to check in during the crowd'], ['Coworker', 'shares the commute on Front St'], ['Neighbour', 'lives two doors down'],
  ['Best friend', 'came to the game together'], ['Father', 'waiting at home for a call'], ['Roommate', 'holds the spare key'], ['Old classmate', 'ran into each other at the gate'],
  ['Manager', 'expects them in at 7 am'], ['Daughter', 'asleep at the sitter\'s'],
]
const SENTIMENTS = ['close', 'warm', 'tense', 'trusted', 'distant', 'new']
const FIRST = ['Maya', 'Daniel', 'Aisha', 'Marcus', 'Alex', 'Sofia', 'Jordan', 'Priya', 'Liam', 'Amara', 'Noah', 'Chloe', 'Omar', 'Hannah', 'Mateo', 'Grace', 'Kenji', 'Zara', 'Ethan', 'Leila', 'Ravi', 'Nora', 'Tariq', 'Ines', 'Wei', 'Fatima', 'Lucas', 'Yara', 'Tomasz', 'Bea']
const LAST = ['Chen', 'Park', 'Bello', 'Lee', 'Morgan', 'Patel', 'Brooks', 'Nguyen', 'Okafor', 'Rossi', 'Haddad', 'Kowalski', 'Singh', 'Fernandes', 'Wong', 'Campbell', 'Ivanova', 'Dubois', 'Tremblay', 'Mensah', 'Abadi', 'Novak', 'Reyes', 'Kim', 'Osei', 'Larsen', 'Moreau', 'Silva', 'Adeyemi', 'Costa']

/** A stable, varied full name for a traveler id (the same id always gets the same name). */
export function personaName(id: string): string {
  return `${FIRST[Math.floor(hash01(`${id}:first`) * FIRST.length) % FIRST.length]} ${LAST[Math.floor(hash01(`${id}:last`) * LAST.length) % LAST.length]}`
}

const pick = <T,>(list: readonly T[], id: string, salt: string): T => list[Math.floor(hash01(`${id}:${salt}`) * list.length) % list.length]

function stateLabel(state: number | undefined, kind: LiveEntity['kind'], speed: number | undefined): string {
  if (kind === 'bus') return speed && speed > 0.5 ? 'Driving the shuttle loop' : 'Boarding passengers at a stop'
  if (kind === 'car') return speed && speed > 0.5 ? 'Driving home through downtown' : 'Stuck in traffic, engine idling'
  switch (state) {
    case 0: return 'Still inside, about to leave'
    case 1: return speed && speed > 0.3 ? 'Walking with the crowd' : 'Standing on the sidewalk, checking the phone'
    case 2: return 'Waiting for a shuttle bus'
    case 3: return 'Riding a shuttle bus'
    case 4: return 'Driving'
    case 5: return 'Arrived; heading indoors'
    case 6: return 'Looking for another way through'
    default: return 'On the move'
  }
}

function thoughtsFor(activity: string, destination: string, traits: string[], relation: string): string[] {
  const out = [`${activity}. Aiming for ${destination}.`]
  if (/crowd/i.test(activity)) out.push(traits.includes('anxious in crowds') ? 'Too many people. Keep to the edge of the sidewalk.' : 'Everyone is going the same way; might as well follow.')
  if (/Waiting/.test(activity)) out.push('Third bus that went past full. Maybe walking is faster.')
  if (/traffic|idling/i.test(activity)) out.push('Should have parked further out. Never again.')
  if (/another way/i.test(activity)) out.push('The street ahead is closed. Someone said Front St is open.')
  if (/Arrived/.test(activity)) out.push('Made it. Text to say I got here.')
  out.push(`Wondering whether ${relation} got out ahead of the rush.`)
  return out.slice(0, 3)
}

export interface PersonaLive { state?: number; speed?: number }

/** A deterministic, hard-coded example persona for a live traveler, with the live activity read from SUMO. */
export function personaFor(entity: LiveEntity, live: PersonaLive | null, pack: CityPack | null, allEntities: readonly LiveEntity[]): GodCitizen {
  const id = entity.person_id ?? entity.id
  const name = entity.kind === 'bus' ? `Shuttle ${entity.line ?? entity.id.replace(/^bus_?/, '')} · operator ${personaName(id)}` : personaName(id)
  const age = 19 + Math.floor(hash01(`${id}:age`) * 50)
  const occupation = entity.kind === 'bus' ? 'Shuttle bus operator' : pick(JOBS, id, 'job')
  const neighborhood = pick(NEIGHBOURHOODS, id, 'home')
  const traits = [pick(TRAITS, id, 't1'), pick(TRAITS, id, 't2'), pick(TRAITS, id, 't3')].filter((t, i, a) => a.indexOf(t) === i)
  const destination = pack?.zones.find((z) => z.zone_id === entity.destination_zone_id)?.name ?? (entity.kind === 'bus' ? 'the shuttle loop' : neighborhood)
  const activity = stateLabel(live?.state, entity.kind, live?.speed)
  // relationships point at other real travelers so clicking through lands on someone who is actually in the city
  const others = allEntities.filter((e) => e.kind === 'person' && e.id !== entity.id && personaName(e.person_id ?? e.id) !== name)
  const relationships = [0, 1, 2].map((i) => {
    const other = others.length ? others[Math.floor(hash01(`${id}:rel${i}`) * others.length) % others.length] : null
    const [role, note] = RELATION_ROLES[Math.floor(hash01(`${id}:role${i}`) * RELATION_ROLES.length) % RELATION_ROLES.length]
    const otherId = other?.id ?? `${id}-rel${i}`
    return { id: otherId, name: personaName(other?.person_id ?? otherId), role: `${role} · ${note}`, strength: 0.4 + hash01(`${id}:s${i}`) * 0.6, sentiment: pick(SENTIMENTS, id, `sent${i}`) }
  }).filter((r, i, a) => a.findIndex((x) => x.name === r.name) === i)
  return {
    id: entity.id, name, age, occupation, neighborhood, role: entity.kind === 'bus' ? 'Transit' : entity.kind === 'car' ? 'Driver' : 'Resident',
    status: activity, destination, activity, synthetic: true, traits, mood: pick(MOODS, id, 'mood'),
    thoughts: thoughtsFor(activity, destination, traits, relationships[0]?.name ?? 'the others'),
    quote: pick(['I just want to get home.', 'Is the bridge open?', 'Follow me, I know a shortcut.', 'They said it was closed, so we turned back.', 'Not waiting for another bus.', 'Stay close.'], id, 'quote'),
    relationships,
  }
}
