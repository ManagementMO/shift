import { useId, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { GodAgentMember, GodCitizen } from './model'
import { GlassButton, GlassIconButton, GlassPill, GlassSurface } from './ui'
import { GodIcon } from './icons'
import { Avatar } from './Avatar'
import './people.css'

export type SwarmsTab = 'groups' | 'individuals' | 'templates'
export type CitizenTab = 'thoughts' | 'mood' | 'goals' | 'relationships'
export type PeopleTone = 'green' | 'red' | 'blue' | 'purple' | 'amber' | 'neutral'

export interface SwarmGroup {
  id: string
  name: string
  count: number | null
  icon?: string
  tone?: PeopleTone
  status?: string
  statusTone?: PeopleTone
  objectives?: readonly string[]
  description?: string
  memberIds?: readonly string[]
}

export interface SwarmTemplate {
  id: string
  name: string
  description: string
  command: string
  icon?: string
  tone?: PeopleTone
}

export interface SwarmsPanelProps {
  tab: SwarmsTab
  groups: readonly SwarmGroup[]
  members: readonly GodAgentMember[]
  selectedGroup: string | null
  command: string
  commandBusy?: boolean
  commandDisabled?: boolean
  suggestions?: readonly string[]
  templates?: readonly SwarmTemplate[]
  className?: string
  onTab: (tab: SwarmsTab) => void
  onGroup: (id: string | null) => void
  onPerson: (id: string) => void
  onCommandChange: (value: string) => void
  onCommand: () => void
  onSuggestion: (value: string) => void
  onClose: () => void
}

export interface CitizenPanelProps {
  citizen: GodCitizen
  tab: CitizenTab
  following?: boolean
  followDisabled?: boolean
  guideDisabled?: boolean
  messageDisabled?: boolean
  className?: string
  onTab: (tab: CitizenTab) => void
  onClose: () => void
  onFollow: (citizenId: string) => void
  onGuide: (citizenId: string) => void
  onMessage: (citizenId: string) => void
  onPerson: (id: string) => void
}

const SWARMS_TABS: readonly { value: SwarmsTab; label: string }[] = [
  { value: 'groups', label: 'Agent Groups' },
  { value: 'individuals', label: 'Individual Agents' },
  { value: 'templates', label: 'Templates' },
]

const CITIZEN_TABS: readonly { value: CitizenTab; label: string }[] = [
  { value: 'thoughts', label: 'Thoughts' },
  { value: 'mood', label: 'Mood' },
  { value: 'goals', label: 'Goals' },
  { value: 'relationships', label: 'Relationships' },
]

const DEFAULT_TEMPLATES: readonly SwarmTemplate[] = [
  {
    id: 'evacuate',
    name: 'Move to safety',
    description: 'Prepare an evacuation objective for the selected group.',
    command: 'Evacuate downtown',
    icon: 'people',
    tone: 'green',
  },
  {
    id: 'secure',
    name: 'Secure an area',
    description: 'Give the group a location to protect and a shared priority.',
    command: 'Secure Union Station',
    icon: 'shield',
    tone: 'blue',
  },
  {
    id: 'transit',
    name: 'Keep the city moving',
    description: 'Prepare a rerouting request around the affected area.',
    command: 'Reroute transit around the affected area',
    icon: 'train',
    tone: 'purple',
  },
]

function displayLabel(value: string) {
  const label = value.replace(/_/g, ' ').trim()
  return label ? label[0].toLocaleUpperCase() + label.slice(1) : ''
}

function statusTone(status = ''): PeopleTone {
  if (/inactive|idle|not active|unavailable|not departed/i.test(status)) return 'neutral'
  if (/alert|waiting|caution|unroutable/i.test(status)) return 'amber'
  if (/emergency|danger|failed/i.test(status)) return 'red'
  if (/coordinat/i.test(status)) return 'purple'
  if (/normal|safe|arrived|complete/i.test(status)) return 'green'
  if (/active|walking|riding|driving|moving/i.test(status)) return 'blue'
  return 'neutral'
}

function groupAppearance(group: SwarmGroup): { icon: string; tone: PeopleTone } {
  const name = `${group.id} ${group.name}`.toLocaleLowerCase()
  const defaults: { icon: string; tone: PeopleTone } = /emergency|responder|rescue/.test(name)
    ? { icon: 'responder', tone: 'red' }
    : /police|security/.test(name)
      ? { icon: 'shield', tone: 'blue' }
      : /transit|transport/.test(name)
        ? { icon: 'train', tone: 'purple' }
        : /civilian|resident/.test(name)
          ? { icon: 'people', tone: 'green' }
          : { icon: 'people', tone: 'neutral' }
  return { icon: group.icon ?? defaults.icon, tone: group.tone ?? defaults.tone }
}

function GroupGlyph({ icon, size = 36 }: { icon: string; size?: number }) {
  let drawing: ReactNode
  if (['people', 'agents', 'users', 'civilians'].includes(icon)) {
    drawing = <><circle cx="13" cy="10" r="6" /><path d="M2 30v-4.2C2 20.7 6.7 18 13 18s11 2.7 11 7.8V30Z" /><circle cx="26.3" cy="11" r="4.7" opacity="0.9" /><path d="M26.5 19c4.7.4 7.5 2.8 7.5 6.7V30h-7v-4.2c0-2.7-.8-4.9-2.4-6.7Z" opacity="0.9" /></>
  } else if (['responder', 'helmet', 'hard-hat', 'emergency'].includes(icon)) {
    drawing = <><path d="M5 16a13 13 0 0 1 9-11.5V15h3V3h3v12h3V4.5A13 13 0 0 1 32 16Z" /><path d="M3 17h31v3H3zM10 23h17a8.5 8.5 0 0 1-17 0ZM5 34l1.1-5.4a4.1 4.1 0 0 1 3.3-3.1A12 12 0 0 0 18.5 30a12 12 0 0 0 9.1-4.5 4.1 4.1 0 0 1 3.3 3.1L32 34Z" /></>
  } else if (['shield', 'police', 'security'].includes(icon)) {
    drawing = <><path d="M18 2 32 7v10c0 8.5-8.3 14.9-14 18C12.3 31.9 4 25.5 4 17V7Z" /><path d="m11.5 19 4-4 3.8 3.8 5.2-7.3" fill="none" stroke="#244d77" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></>
  } else if (['train', 'transit', 'transport'].includes(icon)) {
    drawing = <><path d="M11 2h14a6 6 0 0 1 6 6v16a6 6 0 0 1-6 6H11a6 6 0 0 1-6-6V8a6 6 0 0 1 6-6Z" /><path d="M9 10h18v9H9z" fill="#344a71" /><path d="M14 6h8" fill="none" stroke="#344a71" strokeWidth="2" strokeLinecap="round" /><circle cx="11.5" cy="24" r="2" fill="#344a71" /><circle cx="24.5" cy="24" r="2" fill="#344a71" /><path d="m11 29-4 6m18-6 4 6M10 33h16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></>
  } else {
    return <GodIcon name={icon} size={size} />
  }
  return <svg width={size} height={size} viewBox="0 0 36 36" fill="currentColor" aria-hidden="true">{drawing}</svg>
}

function PeopleTabs<T extends string>({ id, label, value, tabs, onChange }: {
  id: string
  label: string
  value: T
  tabs: readonly { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = tabs.findIndex((tab) => tab.value === value)
    let next = current
    if (event.key === 'ArrowRight') next = (current + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    event.stopPropagation()
    onChange(tabs[next].value)
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <div className="gp-people-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          type="button"
          role="tab"
          key={tab.value}
          id={`${id}-tab-${tab.value}`}
          aria-selected={value === tab.value}
          aria-controls={`${id}-panel-${tab.value}`}
          tabIndex={value === tab.value ? 0 : -1}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

function StatusPill({ status, tone }: { status: string; tone?: PeopleTone }) {
  return <GlassPill className="gp-people-chip gp-people-status" data-tone={tone ?? statusTone(status)}>{displayLabel(status)}</GlassPill>
}

function EmptyState({ icon = 'people', title, children }: { icon?: string; title: string; children: ReactNode }) {
  return (
    <div className="gp-people-empty">
      <span className="gp-people-empty-icon"><GodIcon name={icon} size={28} /></span>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  )
}

function GroupRow({ group, onClick }: { group: SwarmGroup; onClick: () => void }) {
  const appearance = groupAppearance(group)
  return (
    <button type="button" className="gp-people-group" onClick={onClick}>
      <span className="gp-people-group-icon" data-tone={appearance.tone}><GroupGlyph icon={appearance.icon} /></span>
      <span className="gp-people-group-content">
        <span className="gp-people-group-heading">
          <span className="gp-people-group-name">{group.name}</span>
          <span className="gp-people-group-count" title={group.count === null ? 'Population not supplied by the model' : undefined} aria-label={group.count === null ? 'Population unavailable' : `${group.count.toLocaleString()} agents`}>
            {group.count === null ? '—' : group.count.toLocaleString()}
          </span>
        </span>
        {(group.status || group.objectives?.length) ? (
          <span className="gp-people-chips">
            {group.status && <StatusPill status={group.status} tone={group.statusTone} />}
            {group.objectives?.map((objective, index) => <GlassPill className="gp-people-chip" key={`${objective}-${index}`}>{objective}</GlassPill>)}
          </span>
        ) : null}
      </span>
      <GodIcon name="chevron-right" size={20} className="gp-people-chevron" />
    </button>
  )
}

function AgentSearch({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="gp-people-search">
      <GodIcon name="search" size={19} />
      <input id={id} type="search" value={value} placeholder="Search agents..." aria-label="Search agents by name, role, or status" onChange={(event) => onChange(event.target.value)} autoComplete="off" spellCheck={false} />
      {value && <GlassIconButton className="gp-people-search-clear" icon="close" label="Clear agent search" size={16} onClick={() => onChange('')} />}
    </div>
  )
}

function MemberList({ members, onPerson }: { members: readonly GodAgentMember[]; onPerson: (id: string) => void }) {
  return (
    <ul className="gp-people-agent-list">
      {members.map((member) => (
        <li key={member.id}>
          <button type="button" className="gp-people-agent" onClick={() => onPerson(member.id)}>
            <span className="gp-people-agent-avatar">
              <Avatar name={member.name} src={member.avatarUrl} size={42} decorative />
              <span className="gp-people-presence" data-active={member.active} title={member.active ? 'Active agent' : 'Inactive agent'} />
            </span>
            <span className="gp-people-agent-identity"><strong>{member.name}</strong><span>{displayLabel(member.role) || 'Role unavailable'}</span></span>
            {member.status && <StatusPill status={member.status} />}
            <GodIcon name="chevron-right" size={18} className="gp-people-chevron" />
          </button>
        </li>
      ))}
    </ul>
  )
}

function matchingMembers(members: readonly GodAgentMember[], query: string) {
  const search = query.trim().toLocaleLowerCase()
  return search ? members.filter((member) => `${member.name} ${member.role} ${displayLabel(member.status)}`.toLocaleLowerCase().includes(search)) : members
}

export function SwarmsPanel({ tab, groups, members, selectedGroup, command, commandBusy = false, commandDisabled = false, templates = DEFAULT_TEMPLATES, className = '', onTab, onGroup, onPerson, onCommandChange, onCommand, onSuggestion, onClose }: SwarmsPanelProps) {
  const id = useId()
  const commandInput = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const group = groups.find((item) => item.id === selectedGroup)
  const appearance = group ? groupAppearance(group) : null
  const memberIds = group?.memberIds ? new Set(group.memberIds) : null
  const groupMembers = memberIds ? members.filter((member) => memberIds.has(member.id)) : []
  const visibleMembers = matchingMembers(tab === 'groups' ? groupMembers : members, query)
  const canSubmit = Boolean(command.trim()) && !commandBusy && !commandDisabled
  const applySuggestion = (suggestion: string) => {
    if (commandBusy || commandDisabled) return
    onSuggestion(suggestion)
    commandInput.current?.focus()
  }

  return (
    <GlassSurface
      tone="dark"
      className={`gp-people-panel gp-swarms-panel ${className}`.trim()}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${id}-heading`}
      data-tab={tab}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      }}
    >
      <header className="gp-people-panel-header">
        <GodIcon name="people" size={35} strokeWidth={1.7} />
        <h2 id={`${id}-heading`}>Swarms</h2>
        <GlassIconButton className="gp-people-close" icon="close" label="Close Swarms" size={25} onClick={onClose} />
      </header>
      <PeopleTabs id={id} label="Swarms views" value={tab} tabs={SWARMS_TABS} onChange={onTab} />
      <div
        key={`${tab}-${tab === 'groups' ? group?.id ?? 'all' : 'all'}`}
        className="gp-people-content"
        role="tabpanel"
        id={`${id}-panel-${tab}`}
        aria-labelledby={`${id}-tab-${tab}`}
        tabIndex={0}
      >
        {tab === 'groups' && !group && (
          groups.length ? (
            <ul className="gp-people-groups">
              {groups.map((item) => <li key={item.id}><GroupRow group={item} onClick={() => { setQuery(''); onGroup(item.id) }} /></li>)}
            </ul>
          ) : <EmptyState title="No groups available">Agent groups will appear here when they are supplied by the simulation.</EmptyState>
        )}
        {tab === 'groups' && group && appearance && (
          <div className="gp-people-group-detail">
            <button type="button" className="gp-people-back" onClick={() => { setQuery(''); onGroup(null) }}><GodIcon name="arrow-left" size={17} />All groups</button>
            <div className="gp-people-detail-card">
              <div className="gp-people-detail-heading">
                <span className="gp-people-group-icon" data-tone={appearance.tone}><GroupGlyph icon={appearance.icon} size={40} /></span>
                <div><h3>{group.name}</h3><p>{group.count === null ? 'Population not modeled' : `${group.count.toLocaleString()} agents`}</p></div>
              </div>
              <div className="gp-people-chips">
                {group.status && <StatusPill status={group.status} tone={group.statusTone} />}
                {group.objectives?.map((objective, index) => <GlassPill className="gp-people-chip" key={`${objective}-${index}`}>{objective}</GlassPill>)}
              </div>
              {group.description && <p className="gp-people-detail-description">{group.description}</p>}
            </div>
            <div className="gp-people-list-heading"><h3>Group members</h3><span>{memberIds ? `${groupMembers.length.toLocaleString()} available` : 'Not linked'}</span></div>
            {groupMembers.length > 0 ? (
              <>
                <AgentSearch id={`${id}-group-search`} value={query} onChange={setQuery} />
                {visibleMembers.length ? <MemberList members={visibleMembers} onPerson={onPerson} /> : <EmptyState icon="search" title="No matching agents">Try another name, role, or status.</EmptyState>}
              </>
            ) : (
              <div className="gp-people-members-empty">
                <p>{memberIds ? 'No members of this group are available to inspect.' : 'Individual membership is not supplied for this group.'}</p>
                <GlassButton variant="ghost" className="gp-people-inline-button" onClick={() => onTab('individuals')}>View individual agents<GodIcon name="chevron-right" size={16} /></GlassButton>
              </div>
            )}
          </div>
        )}
        {tab === 'individuals' && (
          <div className="gp-people-individuals">
            <AgentSearch id={`${id}-agent-search`} value={query} onChange={setQuery} />
            <div className="gp-people-list-heading"><h3>Available agents</h3><span aria-live="polite">{visibleMembers.length.toLocaleString()} shown</span></div>
            {visibleMembers.length ? <MemberList members={visibleMembers} onPerson={onPerson} /> : <EmptyState icon={query ? 'search' : 'people'} title={query ? 'No matching agents' : 'No individual agents yet'}>{query ? 'Try another name, role, or status.' : 'Connect a simulation to inspect its available agents.'}</EmptyState>}
          </div>
        )}
        {tab === 'templates' && (
          <div className="gp-people-templates">
            <div className="gp-people-intro"><h3>Start with a shared objective</h3><p>Choose a template, then review your command before sending it.</p></div>
            {templates.length ? (
              <ul className="gp-people-template-list">
                {templates.map((template) => (
                  <li key={template.id}>
                    <button type="button" className="gp-people-template" data-selected={command.trim() === template.command} disabled={commandBusy || commandDisabled} onClick={() => applySuggestion(template.command)}>
                      <span className="gp-people-group-icon" data-tone={template.tone ?? 'blue'}><GroupGlyph icon={template.icon ?? 'sparkles'} size={30} /></span>
                      <span className="gp-people-template-copy"><strong>{template.name}</strong><span>{template.description}</span><span className="gp-people-template-action">{command.trim() === template.command ? 'Added to command' : 'Use template'}<GodIcon name={command.trim() === template.command ? 'check' : 'arrow-right'} size={15} /></span></span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <EmptyState icon="sparkles" title="No templates available">Write your own group objective in the command field below.</EmptyState>}
          </div>
        )}
      </div>
      <form className="gp-people-command" aria-busy={commandBusy} onSubmit={(event) => { event.preventDefault(); if (canSubmit) onCommand() }}>
        <label htmlFor={`${id}-command`}>{group ? `Tell ${group.name} what to do...` : 'Tell this group what to do...'}</label>
        <div className="gp-people-command-field">
          <GodIcon name="sparkles" size={28} className="gp-people-command-sparkles" />
          <input ref={commandInput} id={`${id}-command`} value={command} onChange={(event) => onCommandChange(event.target.value)} placeholder="e.g. Evacuate downtown..." autoComplete="off" disabled={commandBusy || commandDisabled} />
          <GlassIconButton className="gp-people-send" icon={commandBusy ? 'more' : 'arrow-right'} label={commandBusy ? 'Sending group command' : 'Send group command'} size={23} type="submit" disabled={!canSubmit} />
        </div>
      </form>
    </GlassSurface>
  )
}

function CitizenSectionHeading({ title, count, onSeeAll }: { title: string; count?: number; onSeeAll?: () => void }) {
  return (
    <div className="gp-citizen-section-heading">
      <h3>{title}</h3>
      {onSeeAll && <button type="button" onClick={onSeeAll}>See all{count !== undefined ? ` (${count})` : ''}<GodIcon name="chevron-right" size={15} /></button>}
    </div>
  )
}

function CitizenState({ citizen }: { citizen: GodCitizen }) {
  return (
    <section className="gp-citizen-section">
      <CitizenSectionHeading title="Current state" />
      <div className="gp-citizen-state-card">
        <div className="gp-citizen-current-activity">
          <span className="gp-citizen-state-icon"><GodIcon name="navigation" size={22} /></span>
          <div><strong>{citizen.activity || 'Activity unavailable'}</strong><span>{citizen.destination ? `Heading to ${citizen.destination}` : 'Destination unavailable'}</span></div>
        </div>
        <div className="gp-people-chips"><StatusPill status={citizen.status || 'Status unavailable'} /><GlassPill className="gp-people-chip gp-citizen-mood" title="The citizen model does not provide a mood measurement">Mood not modeled</GlassPill></div>
      </div>
    </section>
  )
}

function CitizenThoughts({ thoughts, isPreview, times }: { thoughts: readonly string[]; isPreview?: boolean; times?: readonly string[] }) {
  if (!thoughts.length) return <EmptyState icon="message" title="No thoughts available">{isPreview ? 'This preview does not include thought data.' : 'No thoughts have been supplied for this agent.'}</EmptyState>
  return (
    <ul className="gp-citizen-thoughts">
      {thoughts.map((thought, index) => {
        const kind = /green|trees|shade|nature|garden/i.test(thought) ? 'leaf' : /community|neighbou?r|together|friend/i.test(thought) ? 'people' : 'message'
        return (
          <li className="gp-citizen-thought" key={`${index}-${thought}`}>
            <span className="gp-citizen-thought-icon" data-kind={kind}><GodIcon name={kind} size={23} /></span>
            <span className="gp-citizen-thought-time" title={isPreview ? 'Illustrative thought from a preview profile' : 'No timestamp was supplied'}>{times?.[index] ?? (isPreview ? 'Preview' : 'Untimed')}</span>
            <p>{thought}</p>
          </li>
        )
      })}
    </ul>
  )
}

function CitizenGoals({ citizen }: { citizen: GodCitizen }) {
  return (
    <section className="gp-citizen-section">
      <CitizenSectionHeading title="Goals & traits" />
      <div className="gp-citizen-goals">
        {citizen.destination ? <div className="gp-citizen-destination"><GodIcon name="pin" size={18} /><span><span>Destination</span>{citizen.destination}</span></div> : <p className="gp-citizen-unavailable">No goal or destination supplied.</p>}
        {citizen.traits.length ? <div className="gp-people-chips">{citizen.traits.map((trait, index) => <GlassPill className="gp-people-chip gp-citizen-trait" key={`${trait}-${index}`}>{trait}</GlassPill>)}</div> : <p className="gp-citizen-unavailable">Personality traits are not available.</p>}
      </div>
    </section>
  )
}

function CitizenRelationships({ relationships, isPreview, limit, onSeeAll, onPerson }: {
  relationships: GodCitizen['relationships']
  isPreview?: boolean
  limit?: number
  onSeeAll?: () => void
  onPerson: (id: string) => void
}) {
  const visible = limit === undefined ? relationships : relationships.slice(0, limit)
  return (
    <section className="gp-citizen-section gp-citizen-relationships">
      <CitizenSectionHeading title="Relationships" count={relationships.length} onSeeAll={relationships.length ? onSeeAll : undefined} />
      {visible.length ? (
        <ul className="gp-citizen-relationship-list">
          {visible.map((person) => (
            <li key={person.id}>
              <button type="button" className="gp-citizen-relationship" onClick={() => onPerson(person.id)} aria-label={`View ${person.name}'s profile`}>
                <Avatar name={person.name} src={person.avatarUrl} size={40} decorative />
                <span className="gp-citizen-relationship-identity"><strong>{person.name}</strong><span>{person.role || 'Relationship unspecified'}</span></span>
                <span className="gp-citizen-relationship-strength" aria-label={person.sentiment ?? 'Relationship strength not modeled'}><i style={{ width: `${Math.max(0, Math.min(1, person.strength ?? 0)) * 100}%` }} data-tone={person.sentiment?.toLowerCase()} /></span><span className="gp-citizen-relationship-sentiment">{person.sentiment ?? 'Unmodeled'}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="gp-citizen-unavailable gp-citizen-relationships-empty">{isPreview ? 'No relationships are included in this preview.' : 'No relationship data is available for this agent.'}</p>}
    </section>
  )
}

export function CitizenPanel({ citizen, tab, following = false, followDisabled = false, guideDisabled = false, messageDisabled = false, className = '', onTab, onClose, onFollow, onGuide, onMessage, onPerson }: CitizenPanelProps) {
  const id = useId()
  const [infoFor, setInfoFor] = useState<string | null>(null)
  const infoOpen = infoFor === citizen.id
  const thoughts = citizen.thoughts.filter((thought) => thought.trim())
  const name = citizen.name.trim() || 'Unnamed citizen'

  return (
    <GlassSurface
      tone="dark"
      className={`gp-people-panel gp-citizen-panel ${className}`.trim()}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${id}-name`}
      data-tab={tab}
      data-preview={citizen.isPreview || undefined}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          if (infoOpen) setInfoFor(null)
          else onClose()
        }
      }}
    >
      <header className="gp-citizen-header">
        <Avatar name={name} src={citizen.avatarUrl} size={108} className="gp-citizen-portrait" decorative />
        <div className="gp-citizen-identity">
          <h2 id={`${id}-name`}>{name}</h2>
          <div className="gp-citizen-bio"><span>{citizen.occupation || displayLabel(citizen.role) || 'Occupation unavailable'}</span><span>Age <strong>{citizen.age ?? '—'}</strong></span></div>
          <div className="gp-citizen-neighborhood"><GodIcon name="pin" size={14} /><span>{citizen.neighborhood || 'Neighborhood unavailable'}</span></div>
          {(citizen.isPreview || citizen.synthetic) && <p className="gp-citizen-provenance"><span />{citizen.isPreview ? 'Preview profile · model placeholder' : 'Simulated citizen'}</p>}
        </div>
      </header>
      {citizen.quote && <p className="gp-citizen-quote">“{citizen.quote}”</p>}
      <div className="gp-citizen-header-actions">
        <GlassIconButton className="gp-citizen-more" icon="more" label="Profile information" size={20} aria-expanded={infoOpen} aria-controls={`${id}-profile-info`} onClick={() => setInfoFor(infoOpen ? null : citizen.id)} />
        <GlassIconButton className="gp-people-close" icon="close" label={`Close ${name}'s profile`} size={25} onClick={onClose} />
      </div>
      {infoOpen && (
        <div id={`${id}-profile-info`} className="gp-citizen-profile-info" role="note">
          <strong>Profile information</strong>
          <dl><dt>Agent ID</dt><dd>{citizen.id}</dd><dt>Source</dt><dd>{citizen.isPreview ? 'Illustrative preview' : citizen.synthetic ? 'Synthetic agent' : 'Supplied citizen profile'}</dd></dl>
          <p>No health, mood, or relationship scores are inferred.</p>
        </div>
      )}
      <PeopleTabs id={id} label={`${name}'s profile views`} value={tab} tabs={CITIZEN_TABS} onChange={onTab} />
      <div key={`${citizen.id}-${tab}`} className="gp-people-content gp-citizen-content" role="tabpanel" id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`} tabIndex={0}>
        {tab === 'thoughts' && (
          <>
            <section className="gp-citizen-section gp-citizen-activity">
              <h3 className="gp-people-sr-only">Thoughts</h3>
              <CitizenThoughts thoughts={thoughts} times={citizen.thoughtTimes} isPreview={citizen.isPreview} />
            </section>
            <CitizenRelationships relationships={citizen.relationships} isPreview={citizen.isPreview} limit={3} onSeeAll={() => onTab('relationships')} onPerson={onPerson} />
            {!thoughts.length && <p className="gp-citizen-data-note">Thoughts and social relationships are not supplied by the recorded journey model.</p>}
          </>
        )}
        {tab === 'mood' && <><CitizenState citizen={citizen} /><div className="gp-citizen-model-note"><GodIcon name="heart" size={24} /><p>{citizen.mood ?? 'The mood model is not connected yet.'}</p></div></>}
        {tab === 'goals' && <CitizenGoals citizen={citizen} />}
        {tab === 'relationships' && (
          <>
            <CitizenRelationships relationships={citizen.relationships} isPreview={citizen.isPreview} onPerson={onPerson} />
            <div className="gp-citizen-model-note"><GodIcon name="people" size={22} /><p>{citizen.isPreview ? 'These connections belong to an illustrative preview profile.' : 'Only connections supplied with this profile are shown.'}<span>Relationship strength is not modeled.</span></p></div>
          </>
        )}
      </div>
      {infoOpen && <footer className="gp-citizen-actions">
        <GlassButton variant="primary" className="gp-citizen-follow" aria-pressed={following} disabled={followDisabled} onClick={() => onFollow(citizen.id)}><GodIcon name={following ? 'check' : 'navigation'} size={18} />{following ? 'Following' : 'Follow'}</GlassButton>
        <GlassButton variant="secondary" disabled={guideDisabled} onClick={() => onGuide(citizen.id)}><GodIcon name="sparkles" size={19} />Guide</GlassButton>
        <GlassButton variant="secondary" disabled={messageDisabled} onClick={() => onMessage(citizen.id)}><GodIcon name="message" size={19} />Message</GlassButton>
      </footer>}
    </GlassSurface>
  )
}
