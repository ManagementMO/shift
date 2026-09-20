import { describe, expect, it } from 'vitest'
import { abstractEntityId, bindingAt, bindingsForEntityAt, brainColor, buildPopulationIndex, decisionProvenance, NEUTRAL_BRAIN_COLOR, populationColorAt, residentForEntityAt, residentStateAt, residentViewAt, stationaryPresenceAt, swarmBindingAt, taskAt, visibleTasksAt } from './population'
import { buildIndex, entitiesAt, MAX_GAP_S, trailAt } from './replay'
import { selectionEntityId, selectionForEntity, selectionPosition } from './selection'
import { bundle, claude, openai, populationArtifact, task } from './population.testData'

const pop = () => buildPopulationIndex(populationArtifact())

describe('population replay indexing', () => {
  it('uses half-open binding intervals and stable identity through body and mode changes', () => {
    const p = pop()
    expect(bindingAt(p, 'r1', 9.99)?.ownership).toBe('abstract')
    expect(bindingAt(p, 'r1', 10)?.entity_id).toBe('bike-body')
    expect(bindingAt(p, 'r1', 30)?.anchor_id).toBe('shop')
    expect(residentForEntityAt(p, 'bike-body', 29.99)).toBe('r1')
    expect(residentForEntityAt(p, 'bike-body', 30)).toBeNull()
    expect(residentForEntityAt(p, 'van-body', 40)).toBe('r1')
    expect(bindingAt(p, 'r1', 45)?.ownership).toBe('shared')
    expect(bindingsForEntityAt(p, 'shared-bus', 45).map((b) => b.resident_id)).toEqual(['r1', 'r2'])
    expect(residentForEntityAt(p, 'shared-bus', 45)).toBeNull()
    expect(residentForEntityAt(p, 'car_r2', 10)).toBeNull()
  })

  it('uses recorded state and task versions rather than the final records', () => {
    const p = pop()
    expect(residentStateAt(p, 'r1', -1)).toBeNull()
    expect(residentStateAt(p, 'r1', 9)?.activity).toBe('idle')
    expect(residentStateAt(p, 'r1', 10)?.mobility_mode).toBe('cycle')
    expect(taskAt(p, 'job', 9)).toBeNull()
    expect(taskAt(p, 'job', 10)?.status).toBe('requested')
    expect(taskAt(p, 'job', 49)?.status).toBe('requested')
    expect(taskAt(p, 'job', 50)?.status).toBe('completed')
    expect(taskAt(p, 'future-job', 54)).toBeNull()
  })

  it('hides future memories, decisions, tasks, outcomes and undelivered received messages when seeking backwards', () => {
    const p = pop()
    expect(residentViewAt(p, 'r1', 60)?.decision?.source).toBe('fallback')
    const at = residentViewAt(p, 'r1', 30)!
    expect(at.state?.memories.map((m) => m.event_id)).toEqual(['seen'])
    expect(at.tasks.map((t) => t.task_id)).toEqual(['job'])
    expect(at.decision?.summary).toBe('I will collect the request.')
    expect(at.decision?.outcome_event_ids).toEqual([])
    expect(at.outcomes).toEqual([])
    expect(at.receivedMessages).toEqual([])
    expect(residentViewAt(p, 'r1', 11)?.decision).toBeNull()
    expect(residentViewAt(p, 'r2', 19)?.receivedMessages).toEqual([])
    expect(residentViewAt(p, 'r2', 20)?.receivedMessages[0].message_id).toBe('message')
    expect(residentViewAt(p, 'r1', 15)?.sentMessages[0].delivered_s).toBeNull()
    expect(residentViewAt(p, 'r1', 50)?.outcomes[0].status).toBe('observed')
  })

  it('represents stationary presence only at explicit abstract anchors, without creating movement samples', () => {
    const rx = buildIndex(bundle())
    const p = rx.population!
    expect(stationaryPresenceAt(p, 0)).toHaveLength(2)
    expect(stationaryPresenceAt(p, 10).map((e) => e.residentId)).toEqual(['r2'])
    const entities = entitiesAt(rx, 30)
    expect(entities.find((e) => e.id === 'bike-body')).toBeUndefined()
    expect(entities.find((e) => e.residentId === 'r1')).toMatchObject({ id: abstractEntityId('r1'), lon: -79.379, lat: 43.64, measured: false, ownership: 'abstract' })
    expect(rx.tracks[abstractEntityId('r1')]).toBeUndefined()
    expect(selectionPosition(rx, { kind: 'resident', id: 'r1' }, 30)).toEqual([-79.379, 43.64])
    expect(selectionEntityId(rx, { kind: 'resident', id: 'r1' }, 10)).toBe('bike-body')
    expect(selectionEntityId(rx, { kind: 'resident', id: 'r1' }, 40)).toBe('van-body')
    expect(selectionForEntity(rx, 'bike-body', 'bicycle', 10)).toEqual({ kind: 'resident', id: 'r1' })
    expect(selectionForEntity(rx, 'shared-bus', 'bus', 45)).toEqual({ kind: 'bus', id: 'shared-bus' })
  })

  it('does not invent stationary presence from a state anchor or fabricate movement across a missing binding', () => {
    const artifact = populationArtifact()
    artifact.mobility_bindings = []
    const rx = buildIndex(bundle(artifact))
    expect(residentStateAt(rx.population!, 'r1', 0)?.anchor_id).toBe('home')
    expect(stationaryPresenceAt(rx.population!, 0)).toEqual([])
    expect(selectionPosition(rx, { kind: 'resident', id: 'r1' }, 0)).toBeNull()
    expect(entitiesAt(rx, 10).some((e) => e.id === 'bike-body')).toBe(false)
  })

  it('shows role-scoped available tasks from their current version without revealing future assignment', () => {
    const artifact = populationArtifact()
    artifact.tasks = [
      { t: 1, task: task({ created_s: 1, assignee_id: null }) },
      { t: 5, task: task({ created_s: 1, assignee_id: null, status: 'ready', ready_s: 5 }) },
      { t: 8, task: task({ created_s: 1, assignee_id: 'r2', status: 'assigned', ready_s: 5 }) },
      { t: 50, task: task({ created_s: 1, assignee_id: 'r1', status: 'assigned', ready_s: 5 }) },
    ]
    const p = buildPopulationIndex(artifact)
    expect(visibleTasksAt(p, 'r1', 1)).toEqual([])
    expect(visibleTasksAt(p, 'r1', 5).map((task) => task.task_id)).toEqual(['job'])
    expect(visibleTasksAt(p, 'r1', 8)).toEqual([])
    expect(visibleTasksAt(p, 'r1', 50)[0].assignee_id).toBe('r1')
    artifact.definition.profiles[0].roles = ['shop_worker']
    const shop = buildPopulationIndex(artifact)
    expect(visibleTasksAt(shop, 'r1', 1)[0].status).toBe('requested')
  })

  it('keeps assignment colors across modes and leaves shared and unowned traffic neutral', () => {
    const p = pop()
    expect(brainColor(claude)).toEqual([232, 139, 73])
    expect(brainColor(openai)).toEqual([48, 166, 115])
    expect(brainColor({ ...claude, model_family: 'other', color: '#123456' })).toEqual([18, 52, 86])
    expect(populationColorAt(p, 'bike-body', 10)).toEqual(brainColor(claude))
    expect(populationColorAt(p, 'van-body', 40)).toEqual(brainColor(claude))
    expect(populationColorAt(p, abstractEntityId('r1'), 30)).toEqual(brainColor(claude))
    expect(populationColorAt(p, 'shared-bus', 45)).toEqual(NEUTRAL_BRAIN_COLOR)
    expect(populationColorAt(p, 'car_r2', 10)).toEqual(NEUTRAL_BRAIN_COLOR)
  })

  it('distinguishes assigned model from actual native, rules and fallback decisions', () => {
    const p = pop()
    expect(decisionProvenance(claude, null)).toMatchObject({ assignedModel: 'claude-test', actualModel: null, source: 'none' })
    expect(decisionProvenance(claude, residentViewAt(p, 'r1', 12)!.decision)).toMatchObject({ source: 'jiuwenswarm', actualModel: 'claude-resolved', fallbackReason: null })
    expect(decisionProvenance(claude, residentViewAt(p, 'r1', 35)!.decision)).toMatchObject({ source: 'fallback', actualModel: null, fallbackReason: 'timeout' })
    expect(decisionProvenance(claude, { ...populationArtifact().decisions[0], source: 'rules', actual_model_id: null })).toMatchObject({ source: 'rules', actualModel: null })
  })

  it('indexes timestamped swarm generations without showing a restored worker before its boundary', () => {
    const artifact = populationArtifact()
    const first = { ...artifact.swarm_bindings[0], bound_s: 12 }
    const restored = { ...first, bound_s: 30, generation: 1, restored: true, worker_id: 'restored-worker', session_id: 'restored-session' }
    artifact.swarm_bindings = [restored, first]
    const p = buildPopulationIndex(artifact)
    expect(swarmBindingAt(p, 'r1', 11.99)).toBeNull()
    expect(swarmBindingAt(p, 'r1', 12)?.worker_id).toBe('worker')
    expect(swarmBindingAt(p, 'r1', 29.99)?.generation).toBe(0)
    expect(swarmBindingAt(p, 'r1', 30)).toMatchObject({ worker_id: 'restored-worker', generation: 1, restored: true })
    expect(residentViewAt(p, 'r1', 29)?.swarmBindings.map((b) => b.worker_id)).toEqual(['worker'])
    expect(residentViewAt(p, 'r1', 30)?.swarmBinding?.generation).toBe(1)
    expect(swarmBindingAt(p, 'r1', 12)?.generation).toBe(0)
  })

  it('keeps untimestamped legacy swarm records separate and uses the newest generation at equal boundary times', () => {
    const artifact = populationArtifact()
    const old = artifact.swarm_bindings[0]
    artifact.swarm_bindings = [old, { ...old, bound_s: 30, generation: 2, worker_id: 'second-restore' }, { ...old, bound_s: 30, generation: 1, worker_id: 'first-restore' }]
    const p = buildPopulationIndex(artifact)
    expect(swarmBindingAt(p, 'r1', 0)).toBeNull()
    expect(residentViewAt(p, 'r1', 0)?.swarmBindings).toEqual([])
    expect(residentViewAt(p, 'r1', 0)?.legacySwarmBindings).toEqual([old])
    expect(swarmBindingAt(p, 'r1', 30)?.worker_id).toBe('second-restore')
  })

  it('uses the recorded population end rather than extrapolating partial execution to the requested horizon', () => {
    const data = bundle()
    data.run.status = 'failed'
    expect(buildIndex(data).tMax).toBe(60)
  })

  it('preserves old bundles, sample gap limits and recorded trail breaks', () => {
    const old = bundle(null)
    delete old.population
    const rx = buildIndex(old)
    expect(rx.population).toBeNull()
    expect(MAX_GAP_S).toBe(3)
    expect(entitiesAt(rx, 14).some((e) => e.id === 'bike-body')).toBe(true)
    expect(entitiesAt(rx, 14.01).some((e) => e.id === 'bike-body')).toBe(false)
    expect(trailAt(rx.tracks['bike-body'], 30, 100)).toEqual([[[-79.38, 43.64], [-79.379, 43.64]]])
    expect(selectionForEntity(rx, 'car_r2', 'car', 10)).toEqual({ kind: 'car', id: 'car_r2' })
  })
})
