/** Real native write-lease and durable replay; no provider credentials or live Host. */
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalDriver from '../../../goal/goal-round-driver/src/index.ts'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import AgentLoop from '../src/index.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import HostMaintenance from '../src/maintenance.ts'
import type { MaintenanceLaunchConfig, MaintenanceReceiptGrant } from '../src/maintenance.ts'

async function assembly(root: string, successor?: MaintenanceLaunchConfig, receiptGrants: MaintenanceReceiptGrant[] = []) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  await ctx.plugin(HostMaintenance, { ...(successor === undefined ? {} : { successor }), receiptGrants })
  return ctx
}

it('durably binds owner/run, atomically accepts both receipt kinds and claims one successor digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-maintenance-native-'))
  let ctx = await assembly(root)
  try {
    const receiver = ctx.hostMaintenance
    const ticket = receiver.begin()
    const closing = receiver.receive('owner-a', { action: 'close', runId: 'run-1' })
    expect(receiver.open).toBe(false)
    await closing
    await expect(receiver.receive('owner-b', { action: 'release', runId: 'run-1' })).rejects.toThrow('owner/run')
    await expect(receiver.receive('owner-b', { action: 'close', runId: 'run-2' })).rejects.toThrow('another owner')
    const items = [
      { sequence: 'notification-1', kind: 'notification', payload: 'artifact://changed' },
      { sequence: 'supervisor-1', kind: 'supervisor', payload: 'checkpoint changed' },
    ]
    const replies = await Promise.all([0, 1].map(() => receiver.receive('owner-a', { action: 'receipts', runId: 'run-1', items })))
    expect(replies.map(reply => reply.receipts.length)).toEqual([2, 2])
    const revision = receiver.snapshot().revision
    await expect(receiver.receive('owner-a', { action: 'receipts', runId: 'run-1', items: [{ ...items[0], payload: 'different' }] })).rejects.toThrow('conflict')
    expect(receiver.snapshot().revision).toBe(revision)
    await ctx.fiber.dispose()
    ctx = await assembly(root)
    expect(ctx.hostMaintenance.open).toBe(false)
    expect((await ctx.hostMaintenance.receive('owner-a', { action: 'status', runId: 'run-1' })).receipts).toHaveLength(2)
    await ctx.hostMaintenance.receive('owner-a', { action: 'release', runId: 'run-1' })
    expect(() => ctx.hostMaintenance.assert(ticket)).toThrow('epoch')
    const workerTicket = ctx.hostMaintenance.begin()
    await ctx.hostMaintenance.receive('owner-a', { action: 'receipts', runId: 'run-1', items: [{ sequence: 'late-worker', kind: 'notification', payload: 'finished' }] })
    expect(() => ctx.hostMaintenance.assert(workerTicket)).not.toThrow()
    const batonDigest = 'a'.repeat(64)
    const claims = await Promise.all([0, 1].map(() => ctx.hostMaintenance.receive('owner-a', { action: 'claim-successor', runId: 'run-1', batonDigest })))
    const firstClaim = claims[0]
    if (firstClaim === undefined) throw new Error('missing successor claim')
    expect(firstClaim.successor).toEqual(claims[1]?.successor)
    expect(() => ctx.hostMaintenance.assert(workerTicket)).not.toThrow()
    expect(firstClaim.successor?.status).toBe('claimed') // Claim is NOT execution or a fabricated started ACK.
    await expect(ctx.hostMaintenance.receive('owner-a', { action: 'claim-successor', runId: 'run-1', batonDigest: 'b'.repeat(64) })).rejects.toThrow('baton conflict')
    await ctx.fiber.dispose()
    ctx = await assembly(root)
    expect((await ctx.hostMaintenance.receive('owner-a', { action: 'status', runId: 'run-1' })).successor).toEqual(firstClaim.successor)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('delivers granted typed supervisor receipts once, preserves pauses and reconciles target durability after lost control ACK', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-receipt-outbox-'))
  const target = { kind: 'agent' as const, sessionId: 'supervisor-target' }
  const grants = [{ owner: 'owner', kind: 'supervisor' as const, target }]
  let ctx = await assembly(root)
  const item = { sequence: 'supervisor-checkpoint', kind: 'supervisor' as const, payload: 'durable checkpoint', target }
  const command = { action: 'deliver-receipts', runId: 'receipt-run', items: [item] }
  try {
    await ctx.hostMaintenance.receive('owner', { action: 'close', runId: 'receipt-run' })
    const revision = ctx.hostMaintenance.snapshot().revision
    await expect(ctx.hostMaintenance.receive('owner', command)).rejects.toThrow('grant denied')
    expect(ctx.hostMaintenance.snapshot().revision).toBe(revision)
    await ctx.fiber.dispose()
    ctx = await assembly(root, undefined, grants)
    await ctx.hostMaintenance.receive('owner', { action: 'release', runId: 'receipt-run' })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    const live = await ctx.agents.create({ sessionId: SessionId(target.sessionId) })
    const inbox = live.agent.inbox.notifications!
    inbox.setFocus(true)
    await ctx.hostMaintenance.receive('owner', { action: 'close', runId: 'delivery-run' })
    const delivery = { ...command, runId: 'delivery-run' }
    const refused = vi.spyOn(inbox, 'admitMaintenance').mockImplementationOnce(() => { throw new Error('before target effect') })
    await expect(ctx.hostMaintenance.receive('owner', delivery)).rejects.toThrow('before target effect')
    refused.mockRestore()
    const intent = (await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'delivery-run' })).deliveries![0]!
    expect(intent.status).toBe('accepted-intent')
    expect(inbox.receipt('native:maintenance-receipt:owner', intent.messageId)).toBeUndefined()
    await expect(ctx.hostMaintenance.receive('owner', { ...delivery, items: [{ ...item, payload: 'divergent' }] })).rejects.toThrow('content conflict')
    const control = (ctx.hostMaintenance as unknown as { handle: SessionHandle }).handle
    const failedACK = vi.spyOn(control, 'append').mockRejectedValueOnce(new Error('after target flush before control ACK'))
    await expect(ctx.hostMaintenance.receive('owner', delivery)).rejects.toThrow('after target flush')
    failedACK.mockRestore()
    expect(inbox.receipt('native:maintenance-receipt:owner', intent.messageId)?.content).toEqual([{ type: 'text', text: item.payload }])
    expect(inbox.focus.enabled).toBe(true)
    live.agent.cancel({ kind: 'user' })
    expect(inbox.receipt('native:maintenance-receipt:owner', intent.messageId)).toBeDefined()
    expect(live.agent.session.snapshotEvents().some(event => event.type === 'user/message')).toBe(false)
    await ctx.fiber.dispose()
    ctx = await assembly(root, undefined, grants) // cold target: no Agent or model executor on replay
    const replies = await Promise.all([0, 1].map(() => ctx.hostMaintenance.receive('owner', delivery)))
    expect(replies[0]).toEqual(replies[1])
    expect(replies[0]?.deliveries?.[0]?.status).toBe('delivered')
    expect(ctx.hostMaintenance.open).toBe(false)
    const durable = await ctx.sessionPersistence.open(SessionId(target.sessionId), 'read')
    try {
      const { events } = await durable.read()
      expect(events.filter(event => event.type === 'agent/inbox/spliced' && event.data.notification?.sequence === intent.messageId)).toHaveLength(1)
    } finally { await durable.close() }
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('fences ordinary notifications and refuses a target disposed during granted receipt flush', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-receipt-dispose-'))
  const target = { kind: 'agent' as const, sessionId: 'race-target' }
  const ctx = await assembly(root, undefined, [{ owner: 'owner', kind: 'supervisor', target }])
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    const live = await ctx.agents.create({ sessionId: SessionId(target.sessionId) })
    const inbox = live.agent.inbox.notifications!
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'background' }] })
    await ctx.hostMaintenance.receive('owner', { action: 'close', runId: 'race' })
    expect(() => inbox.admit('next-turn', message, { origin: 'native:test', sequence: 'ordinary' })).toThrow('admission closed')
    expect(() => inbox.admitMaintenance!({}, 'next-turn', message, { origin: 'native:test', sequence: 'forged' })).toThrow('permit refused')
    const flushOriginal = ctx.sessions.flush.bind(ctx.sessions)
    const flushing = vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async session => {
      const result = await flushOriginal(session)
      live.agent.cancel({ kind: 'disposed' })
      return result
    })
    await expect(ctx.hostMaintenance.receive('owner', { action: 'deliver-receipts', runId: 'race', items: [{ sequence: 'race-receipt', kind: 'supervisor', payload: 'checkpoint', target }] })).rejects.toThrow('owner changed or disposed')
    flushing.mockRestore()
    expect((await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'race' })).deliveries?.[0]?.status).toBe('accepted-intent')
    expect(inbox.accepting).toBe(false)
    expect(() => inbox.admit('next-turn', message, { origin: 'native:test', sequence: 'after-dispose' })).toThrow('disposed')
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('defaults successor effects disabled and durably accepts one immutable closed-run intent under trusted Host config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-successor-intent-'))
  let ctx = await assembly(root)
  const baton = 'verified handoff'
  const batonDigest = createHash('sha256').update(baton).digest('hex')
  const command = { action: 'start-successor', runId: 'intent-run', baton, batonDigest }
  const launch = { owner: 'owner', agentPreset: 'approved-test-preset', provider: 'keyless-test', model: 'scripted', cwd: root }
  try {
    await ctx.hostMaintenance.receive('owner', { action: 'close', runId: 'intent-run' })
    const revision = ctx.hostMaintenance.snapshot().revision
    await expect(ctx.hostMaintenance.receive('owner', command)).rejects.toThrow('disabled')
    expect(ctx.hostMaintenance.snapshot().revision).toBe(revision)
    await ctx.fiber.dispose()
    ctx = await assembly(root, launch)
    await expect(ctx.hostMaintenance.receive('owner', { ...command, baton: 'tampered' })).rejects.toThrow('digest mismatch')
    const replies = await Promise.all([0, 1].map(() => ctx.hostMaintenance.receive('owner', command)))
    expect(replies[0]).toEqual(replies[1])
    expect(replies[0]?.successor?.status).toBe('accepted-intent')
    expect(replies[0]?.successor?.intent?.launch).toEqual(launch)
    expect(ctx.hostMaintenance.open).toBe(false)
    const accepted = ctx.hostMaintenance.snapshot()
    await ctx.fiber.dispose()
    ctx = await assembly(root, { ...launch, model: 'changed-host-model' })
    expect(ctx.hostMaintenance.snapshot()).toEqual(accepted)
    await expect(ctx.hostMaintenance.receive('owner', command)).rejects.toThrow('immutable')
    expect(ctx.hostMaintenance.open).toBe(false)
    // Intent is not a started ACK; no canonical child effect is implemented yet.
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('reconciles canonical successor once across before-effect and after-child-flush control failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-canonical-successor-'))
  const launch = { owner: 'owner', agentPreset: 'trusted-fixture', provider: 'mock', model: 'mock', cwd: root }
  let ctx = await assembly(root, launch)
  const firstAdapter = new MockAdapter([textResponse('handoff complete')])
  const mount = async (adapter: MockAdapter) => {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.provide('maintenanceSuccessorSetup', { prepare: actual => {
      expect(actual).toEqual(launch)
      return async () => {}
    } })
  }
  const baton = 'canonical durable handoff'
  const command = { action: 'start-successor', runId: 'run', baton, batonDigest: createHash('sha256').update(baton).digest('hex') }
  try {
    await mount(firstAdapter)
    await ctx.hostMaintenance.receive('owner', { action: 'close', runId: 'run' })
    const beforeEffect = vi.spyOn(ctx.maintenanceSuccessorSetup!, 'prepare').mockImplementationOnce(() => { throw new Error('before child effect') })
    await expect(ctx.hostMaintenance.receive('owner', command)).rejects.toThrow('before child effect')
    beforeEffect.mockRestore()
    const intent = (await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'run' })).successor!
    expect(intent.status).toBe('accepted-intent')
    expect(ctx.agents.get(SessionId(intent.sessionId))).toBeUndefined()
    await expect(ctx.agents.create({ sessionId: SessionId('unrelated') })).rejects.toThrow('admission closed')
    await expect(ctx.agents.create({ sessionId: SessionId(intent.sessionId), maintenancePermit: {} })).rejects.toThrow('permit refused')
    const control = (ctx.hostMaintenance as unknown as { handle: SessionHandle }).handle
    const append = vi.spyOn(control, 'append').mockRejectedValueOnce(new Error('after child flush before control receipt'))
    await expect(ctx.hostMaintenance.receive('owner', command)).rejects.toThrow('after child flush')
    append.mockRestore()
    expect(firstAdapter.requests).toHaveLength(1)
    expect(ctx.hostMaintenance.open).toBe(false)
    await ctx.fiber.dispose()
    ctx = await assembly(root, launch)
    const recoveredAdapter = new MockAdapter([])
    await mount(recoveredAdapter)
    const replies = await Promise.all([0, 1].map(() => ctx.hostMaintenance.receive('owner', command)))
    expect(replies[0]).toEqual(replies[1])
    expect(replies[0]?.successor?.status).toBe('complete')
    expect(replies[0]?.successor?.sessionId).toBe(intent.sessionId)
    expect(recoveredAdapter.requests).toHaveLength(0)
    const child = ctx.agents.get(SessionId(intent.sessionId))!
    expect(child.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === intent.intent?.messageId)).toHaveLength(1)
    expect(ctx.hostMaintenance.open).toBe(false)
    expect(() => child.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'unapproved extra wake' }] }))).toThrow('permit refused')
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('reports the active initiating caller without joining a successor awaiting its own checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-maintenance-status-'))
  const launch = { owner: 'owner', agentPreset: 'fixture', provider: 'mock', model: 'scripted', cwd: root }
  const ctx = await assembly(root, launch)
  const adapter = new MockAdapter(['hang', 'hang'])
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.provide('maintenanceSuccessorSetup', { prepare: () => async () => {} })
    const caller = await ctx.agents.create({ sessionId: SessionId('initiating-caller'), agentOptions: { provider: 'mock', model: 'scripted' } })
    caller.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'initiating caller checkpoint' }] }))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    const closed = await ctx.hostMaintenance.receive('owner', { action: 'close', runId: 'busy-run' })
    expect(closed).toMatchObject({ phase: 'closed', activity: { closed: true, busy: true, activeAgents: expect.arrayContaining([caller.agent.id]) } })
    expect(caller.agent.status).toBe('running')
    const baton = 'successor checkpoint pending'
    const pending = ctx.hostMaintenance.receive('owner', { action: 'start-successor', runId: 'busy-run', baton, batonDigest: createHash('sha256').update(baton).digest('hex') })
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(2))
    // This must resolve while materialization remains on the mutation tail.
    const status = await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'busy-run' })
    expect(status).toMatchObject({ phase: 'closed', successor: { status: 'accepted-intent' }, activity: { closed: true, busy: true, activeAgents: expect.arrayContaining([caller.agent.id]), unknownParticipants: expect.arrayContaining(['jobs-global', 'delegates-global', 'workflows-global', 'provider-backends']) } })
    const child = ctx.agents.get(SessionId(status.successor!.sessionId))!
    // Fixture cleanup only; receiver did not cancel either participant.
    child.cancel({ kind: 'user' })
    caller.agent.cancel({ kind: 'user' })
    await pending
    await caller.agent.whenIdle()
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('fails admission closed after an uncertain control flush while previously open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-maintenance-flush-failure-'))
  const ctx = await assembly(root)
  try {
    await ctx.hostMaintenance.receive('owner', { action: 'close', runId: 'flush-run' })
    await ctx.hostMaintenance.receive('owner', { action: 'release', runId: 'flush-run' })
    const ticket = ctx.hostMaintenance.begin()
    const handle = (ctx.hostMaintenance as unknown as { handle: SessionHandle }).handle
    const flush = vi.spyOn(handle, 'flush').mockRejectedValueOnce(new Error('injected uncertain durable flush'))
    try {
      await expect(ctx.hostMaintenance.receive('owner', { action: 'receipts', runId: 'flush-run', items: [{ sequence: 'failed-ack', kind: 'notification', payload: 'evidence' }] })).rejects.toThrow('uncertain durable flush')
      expect(ctx.hostMaintenance.open).toBe(false)
      expect(() => ctx.hostMaintenance.assert(ticket)).toThrow('admission closed')
      expect(() => ctx.hostMaintenance.begin()).toThrow('admission closed')
    } finally { flush.mockRestore() }
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('keeps prior human goal pause and Focus unchanged across durable close and release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-maintenance-prior-pause-'))
  const ctx = await assembly(root)
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(GoalService)
    await ctx.plugin(GoalDriver)
    await ctx.plugin(AgentLoop, { agents: [] })
    const live = await ctx.agents.create({ sessionId: SessionId('paused-owner') })
    live.agent.inbox.notifications!.setFocus(true)
    const goal = ctx.goals.create(live.agent, { objective: 'prior human pause' })
    live.agent.cancel({ kind: 'user' })
    const paused = ctx.goals.get(live.agent)
    expect(paused?.phase).toBe('paused')
    expect(paused?.id).toBe(goal.id)
    await ctx.hostMaintenance.receive('owner', { action: 'close', runId: 'pause-run' })
    expect(ctx.goals.get(live.agent)).toEqual(paused)
    expect(live.agent.inbox.notifications!.focus.enabled).toBe(true)
    await ctx.hostMaintenance.receive('owner', { action: 'release', runId: 'pause-run' })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(ctx.goals.get(live.agent)).toEqual(paused)
    expect(live.agent.inbox.notifications!.focus.enabled).toBe(true)
    expect(live.agent.session.snapshotEvents().some(event => event.type === 'request/header')).toBe(false)
    await live.dispose()
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('counts reservations across close and releases only exact owned tickets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-maintenance-reservations-'))
  const ctx = await assembly(root)
  try {
    const reservation = ctx.hostMaintenance.reserve('job', SessionId('caller'))
    await ctx.hostMaintenance.receive('owner', { action: 'close', runId: 'reserved' })
    expect(() => ctx.hostMaintenance.assert(reservation.ticket)).not.toThrow()
    expect(() => ctx.hostMaintenance.reserve('job')).toThrow('admission closed')
    expect(() => ctx.hostMaintenance.assert({})).toThrow('admission closed')
    expect(await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'reserved' })).toMatchObject({ activity: { busy: true, activeReservations: [{ kind: 'job', sessionId: 'caller' }] } })
    reservation.release()
    reservation.release()
    expect(() => ctx.hostMaintenance.assert(reservation.ticket)).toThrow('admission closed')
    expect(await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'reserved' })).toMatchObject({ activity: { activeReservations: [], busy: true } }) // Unknown producers still forbid idle.
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('refuses new work while preserving counted preclose publication and retiring its ticket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-maintenance-publication-'))
  const ctx = await assembly(root)
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    const live = await ctx.agents.create({ sessionId: SessionId('existing-agent') })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const pending = ctx.agents.create({ sessionId: SessionId('late-agent'), setup: async () => { entered.resolve(); await release.promise } })
    await entered.promise
    await ctx.hostMaintenance.receive('owner', { action: 'close', runId: 'run' })
    await expect(ctx.agents.create({ sessionId: SessionId('refused-agent') })).rejects.toThrow('admission closed')
    expect(() => live.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'new work' }] }))).toThrow('admission closed')
    const status = await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'run' })
    expect(status).toMatchObject({ activity: { busy: true, activeReservations: [{ kind: 'publication', sessionId: 'late-agent' }] } })
    release.resolve()
    const late = await pending
    expect(ctx.agents.get(SessionId('late-agent'))).toBe(late.agent)
    expect(ctx.sessions.get(SessionId('late-agent'))).toBe(late.agent.session)
    expect(() => late.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'unrelated after publication' }] }))).toThrow('admission closed')
    await ctx.sessions.flush(late.agent.session)
    expect((await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'run' })).activity.unknownParticipants).toContain('preclose-publications')
    await ctx.sessionPersistence.flush() // The other idle Agent's buffered writes must also genuinely settle.
    // An empty actual LLM registry has no provider work; absent producer coverage is still unknown.
    expect(await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'run' })).toMatchObject({ activity: {
      busy: true, activeReservations: [], providerBackends: { state: 'JOINED', participants: [] },
      unknownParticipants: ['jobs-global', 'delegates-global', 'workflows-global'],
    } })
    await ctx.hostMaintenance.receive('owner', { action: 'release', runId: 'run' })
    await late.dispose()
    await live.dispose()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
