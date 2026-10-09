/** Native control owners, not sampled snapshots or client claims, invalidate diagnostic revisions. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import GoalService from '@deepseek-ai/dsh-goal'
import { expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { OperatorActivity } from '../src/operator-activity.ts'
import type { ActivitySnapshot } from '../src/rpc.ts'

async function assembly(beforeOwners?: (ctx: Context) => void) {
  const ctx = new Context()
  beforeOwners?.(ctx)
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([textResponse('programmatic prompt')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('native-controls'), { provider: 'mock', model: 'mock' })
  const inbox = agent.inbox.notifications!
  const activity = new OperatorActivity(ctx, 300000)
  const read = () => {
    const snapshot = activity.snapshot(agent.id)
    if (snapshot === undefined) throw new Error('missing native snapshot')
    expect(snapshot.eligible).toBe(false)
    return snapshot
  }
  return { ctx, adapter, agent, inbox, activity, read }
}

it('reads native no-goal Stop and preserves its latch across generic prompts and Focus away-and-back', async () => {
  const { ctx, adapter, agent, inbox, read } = await assembly()
  await ctx.plugin(GoalService)
  const initial = read()
  expect(initial).toMatchObject({ stop: 'clear', focus: 'disabled', goal: { state: 'none' } })
  expect(read().controlRevision).toBe(initial.controlRevision)

  agent.cancel({ kind: 'user' })
  expect(read()).toMatchObject({ stop: 'stopped', goal: { state: 'none' } })
  expect(read().holdReasons).toContain('stop-stopped')
  expect(read().controlRevision).toBeGreaterThan(initial.controlRevision)
  const stopped = read()
  inbox.setFocus(true)
  inbox.setFocus(false)
  expect(read()).toMatchObject({ stop: 'stopped', focus: 'disabled' })
  expect(read().controlRevision).toBeGreaterThan(stopped.controlRevision)

  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'SDK-style prompt' }] }))
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(1)
  expect(read().stop).toBe('stopped')
  expect(read().lastActivityAt).toBeNull()
  const beforeRoundTrip = read()
  inbox.resumeOperator!()
  agent.cancel({ kind: 'user' })
  expect(read().stop).toBe('stopped')
  expect(read().controlRevision).toBeGreaterThan(beforeRoundTrip.controlRevision)
  inbox.resumeOperator!()
  expect(read().stop).toBe('clear')
  expect(adapter.requests).toHaveLength(1)
})

it('projects every goal phase and activation; absent service is not authoritative no-goal', async () => {
  const { ctx, agent, inbox, read } = await assembly()
  expect(read().goal).toEqual({ state: 'unknown' })
  expect(read().holdReasons).toContain('goal-unknown')
  const unknown = read()
  const goals = await ctx.plugin(GoalService)
  expect(read().goal).toEqual({ state: 'none' })
  expect(read().controlRevision).toBeGreaterThan(unknown.controlRevision)

  let goal = ctx.goals.create(agent, { objective: 'native goal' })
  expect(read().goal).toEqual({ state: 'present', id: goal.id, revision: goal.revision, phase: 'active', activation: 'armed' })
  const armed = read()
  ctx.goals.disarm(agent)
  expect(read().goal).toMatchObject({ phase: 'active', activation: 'disarmed', revision: goal.revision })
  expect(read().holdReasons).toContain('goal-disarmed')
  expect(read().controlRevision).toBeGreaterThan(armed.controlRevision)
  goal = ctx.goals.resume(agent, goal)
  expect(read().holdReasons).not.toContain('goal-disarmed')

  const beforePause = read()
  goal = ctx.goals.pause(agent, goal)
  expect(read().holdReasons).toContain('goal-paused')
  goal = ctx.goals.resume(agent, goal)
  expect(read().goal).toMatchObject({ phase: 'active', activation: 'armed', revision: goal.revision })
  expect(read().controlRevision).toBeGreaterThan(beforePause.controlRevision)
  const beforeEdit = read()
  goal = ctx.goals.edit(agent, goal, { objective: 'edited' })
  expect(read().goal).toMatchObject({ revision: goal.revision })
  expect(read().controlRevision).toBeGreaterThan(beforeEdit.controlRevision)
  goal = ctx.goals.block(agent, goal, { code: 'test-block', message: 'native blocker' })
  expect(read().holdReasons).toContain('goal-blocked')
  agent.cancel({ kind: 'user' })
  inbox.resumeOperator!()
  expect(read().goal).toMatchObject({ phase: 'blocked', activation: 'disarmed' })
  goal = ctx.goals.complete(agent, goal)
  expect(read().goal).toMatchObject({ phase: 'complete', activation: 'disarmed' })
  expect(read().holdReasons.filter(reason => reason.startsWith('goal-'))).toEqual([])
  ctx.goals.clear(agent, goal)
  expect(read().goal).toEqual({ state: 'none' })

  const beforeReload = read()
  await goals.dispose()
  expect(read().goal).toEqual({ state: 'unknown' })
  await ctx.plugin(GoalService)
  expect(read().goal).toEqual({ state: 'none' })
  expect(read().controlRevision).toBeGreaterThan(beforeReload.controlRevision)
  const get = vi.spyOn(ctx.goals, 'get').mockImplementation(() => { throw new Error('invalid goal projection') })
  expect(read().goal).toEqual({ state: 'unknown' })
  expect(read().holdReasons).toContain('goal-unknown')
  get.mockRestore()
})

it('counts foreground insert/remove and whole-turn transitions without intervening reads', async () => {
  const { agent, adapter, read } = await assembly()
  const initial = read()
  const input = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'pending' }] })
  agent.inject(input)
  expect(read().foregroundBusy).toBe(true)
  agent.inbox.remove(input.id)
  expect(read().foregroundBusy).toBe(false)
  expect(read().controlRevision).toBeGreaterThan(initial.controlRevision)
  const before = read()
  agent.inject(input)
  agent.inbox.remove(input.id)
  expect(read().foregroundBusy).toBe(false)
  expect(read().controlRevision).toBeGreaterThan(before.controlRevision)
  const beforeTurn = read()
  agent.followup(input)
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(1)
  expect(read().foregroundBusy).toBe(false)
  expect(read().controlRevision).toBeGreaterThan(beforeTurn.controlRevision)
})

it('activity categories and reconnect cannot claim or clear native controls', async () => {
  const { ctx, agent, inbox, activity, read, adapter } = await assembly()
  await ctx.plugin(GoalService)
  let goal = ctx.goals.create(agent, { objective: 'paused objective' })
  goal = ctx.goals.pause(agent, goal)
  inbox.setFocus(true)
  agent.cancel({ kind: 'user' })
  const held = read()
  const frames: unknown[] = []
  const source = { async *[Symbol.asyncIterator]() { while (frames.length) yield frames.shift() } }
  const open = () => activity.open({ version: 1, sessionId: agent.id }, source,
    { live: () => true, observed: () => {} }, () => true, new AbortController().signal)[Symbol.asyncIterator]()
  const stream = open()
  const epoch = (await stream.next()).value as { bindingEpoch: string }
  let sequence = 0
  for (const interaction of ['input', 'submit', 'focus-control', 'stop']) {
    frames.push({ version: 1, bindingEpoch: epoch.bindingEpoch, sequence: ++sequence, interaction })
    expect((await stream.next()).value).toMatchObject({ accepted: true })
    expect(read()).toMatchObject({ state: 'active', stop: 'stopped', focus: 'enabled', goal: { phase: 'paused', activation: 'disarmed' }, controlRevision: held.controlRevision })
  }
  await stream.return?.()
  expect(read().state).toBe('stale')
  const reconnected = open()
  await reconnected.next()
  expect(read()).toMatchObject({ state: 'unknown', stop: 'stopped', focus: 'enabled', controlRevision: held.controlRevision })
  await reconnected.return?.()
  expect(adapter.requests).toHaveLength(0)
  inbox.resumeOperator!()
  expect(read()).toMatchObject({ stop: 'clear', focus: 'enabled', goal: { phase: 'paused', activation: 'disarmed' } })
  expect(adapter.requests).toHaveLength(0)
  // Native controls do not read focus.queued / isHeld, avoiding a future predicate cycle.
  const heldPredicate = vi.spyOn(inbox, 'isHeld').mockImplementation(() => { throw new Error('recursive queue evaluation') })
  expect(read().focus).toBe('enabled')
  heldPredicate.mockRestore()
})

it('publishes native revision changes before earlier observers reenter snapshots', async () => {
  const activityRef: { current?: OperatorActivity } = {}
  const observed: ActivitySnapshot[] = []
  const capture = () => {
    const value = activityRef.current?.snapshot('native-controls')
    if (value !== undefined) observed.push(value)
  }
  const { ctx, agent, inbox } = await assembly((ctx) => {
    // Registered even before the projection/goal owners and the activity reader.
    ctx.on('session/event', (_session, event) => {
      if (['agent/focus', 'goal/change', 'agent/inbox/spliced'].includes(event.type)) capture()
    })
    ctx.on('agent/stop-changed', capture)
    ctx.on('agent/status', capture)
    ctx.on('goal/activation-changed', capture)
    ctx.on('internal/service', (name) => { if (name === 'goals') capture() })
  })
  const goals = await ctx.plugin(GoalService)
  const owner = new OperatorActivity(ctx, 300000)
  activityRef.current = owner
  const check = (change: () => void, expected: Partial<ActivitySnapshot>) => {
    const before = owner!.snapshot(agent.id)!
    observed.length = 0
    change()
    expect(observed.length).toBeGreaterThan(0)
    for (const during of observed) expect(during.controlRevision).toBeGreaterThan(before.controlRevision)
    expect(owner!.snapshot(agent.id)).toMatchObject(expected)
  }
  check(() => agent.cancel({ kind: 'user' }), { stop: 'stopped' })
  check(() => inbox.resumeOperator!(), { stop: 'clear' })
  check(() => inbox.setFocus(true), { focus: 'enabled' })
  check(() => inbox.setFocus(false), { focus: 'disabled' })
  let goal = ctx.goals.create(agent, { objective: 'observer ordering' })
  check(() => { ctx.goals.disarm(agent) }, { goal: { state: 'present', id: goal.id, revision: goal.revision, phase: 'active', activation: 'disarmed' } })
  check(() => { goal = ctx.goals.resume(agent, goal) }, {})
  check(() => { goal = ctx.goals.pause(agent, goal) }, {})
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'foreground' }] })
  check(() => agent.inject(message), { foregroundBusy: true })
  check(() => { agent.inbox.remove(message.id) }, { foregroundBusy: false })
  const beforeTurn = owner.snapshot(agent.id)!
  observed.length = 0
  agent.followup(message)
  await agent.whenIdle()
  expect(observed.some(value => value.foregroundBusy)).toBe(true)
  expect(observed.at(-1)?.foregroundBusy).toBe(false)
  for (const during of observed) expect(during.controlRevision).toBeGreaterThan(beforeTurn.controlRevision)
  const beforeDispose = owner.snapshot(agent.id)!
  observed.length = 0
  await goals.dispose()
  expect(observed.some(value => value.goal.state === 'unknown' && value.controlRevision > beforeDispose.controlRevision)).toBe(true)
})

it('fails closed on unsupported native controls without trusting legacy Focus fields', async () => {
  const { inbox, read } = await assembly()
  const controls = vi.spyOn(inbox, 'controls', 'get').mockReturnValue(undefined)
  expect(read()).toMatchObject({ stop: 'unknown', focus: 'unknown' })
  expect(read().holdReasons).toEqual(expect.arrayContaining(['stop-unknown', 'focus-unknown', 'goal-unknown', 'admission-unknown']))
  controls.mockRestore()
})
