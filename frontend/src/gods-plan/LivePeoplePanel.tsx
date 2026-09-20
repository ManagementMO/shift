import { useMemo, useState } from 'react'
import type { LiveController } from '../live/controller'
import type { Picked } from '../babylon/traffic'
import { citizenName } from './data'
import { SwarmsPanel, type SwarmsTab, type SwarmGroup } from './PeoplePanels'

export default function LivePeoplePanel({ channel, time, onPick, onClose, onCommand }: { channel: ReturnType<LiveController['getSnapshot']>['primary']; time: number; onPick: (picked: Picked) => void; onClose: () => void; onCommand: (command: string) => void }) {
  const [tab, setTab] = useState<SwarmsTab>('groups')
  const [group, setGroup] = useState<string | null>(null)
  const [command, setCommand] = useState('')
  const members = useMemo(() => {
    const states = new Map<number, number>()
    channel?.replay.forEachAt(time, (index, _x, _z, _heading, _speed, _kind, state) => states.set(index, state))
    const names = ['At origin', 'Walking', 'Waiting for transit', 'On transit', 'Driving', 'Arrived', 'No route']
    return (channel?.metadata.entities ?? []).filter((entity) => entity.kind !== 'bus').map((entity) => ({ id: entity.id, name: citizenName(entity.person_id ?? entity.id), role: 'Synthetic traveler', status: states.has(entity.index) ? names[states.get(entity.index)!] ?? 'Active' : 'Outside current frame', active: states.has(entity.index) }))
  }, [channel, time])
  const count = channel?.replay.frameAt(time)?.counts.total ?? null
  const groups: SwarmGroup[] = [
    { id: 'civilians', name: 'Civilians', count, status: 'Normal', objectives: ['Move to safety', 'Avoid risk'], memberIds: members.map((m) => m.id), description: 'Measured travelers. Incident warnings and word of mouth influence their routes.' },
    { id: 'responders', name: 'Emergency Responders', count: null, status: 'Preview', objectives: ['Assist & rescue', 'High priority'] },
    { id: 'police', name: 'Police', count: null, status: 'Preview', objectives: ['Maintain order', 'Secure area'] },
    { id: 'transit', name: 'Transit Operators', count: null, status: 'Preview', objectives: ['Keep service running', 'Reroute'] },
    { id: 'custom', name: 'Custom Group', count: null, status: 'Idle', objectives: ['Custom objective', 'User defined'] },
  ]
  return <SwarmsPanel tab={tab} groups={groups} members={members} selectedGroup={group} command={command} onTab={setTab} onGroup={setGroup} onPerson={(id) => { const entity = channel?.metadata.entities.find((item) => item.id === id); if (entity) onPick({ id, kind: entity.kind }) }} onCommandChange={setCommand} onCommand={() => onCommand(command)} onSuggestion={setCommand} onClose={onClose} />
}
