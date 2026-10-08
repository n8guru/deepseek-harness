import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '../src/index.ts'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import GoalService from '@deepseek-ai/dsh-goal'
import * as GoalDriver from '../../../goal/goal-round-driver/src/index.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import { expect, it, onTestFinished } from 'vitest'

/** Real native loop/goal assembly with no provider keys or production state. */
async function assembly(script: ConstructorParameters<typeof MockAdapter>[0] = [textResponse('foreground checkpoint'), textResponse('changed receipt checkpoint')]) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(GoalService)
  await ctx.plugin(GoalDriver)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('focus-native'), { provider: 'mock', model: 'mock' })
  const inbox = agent.inbox.notifications
  if (inbox === undefined) throw new Error('native notification capability absent')
  return { ctx, adapter, agent, inbox }
}

it('durably rejects a background admission without resurrecting it after reload or spending a request', async () => {
  const { ctx, adapter } = await assembly([])
  const root = await mkdtemp(join(tmpdir(), 'dsh-focus-rejected-'))
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const handle = await ctx.agents.create({ sessionId: SessionId('rejected-reload'), agentOptions: { provider: 'mock', model: 'mock' } })
  const notification = handle.agent.inbox.notifications!
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'policy refuses this receipt' }] })
  const stopReject = ctx.on('agent/pre-step', async ({ agent }, next) => agent === handle.agent ? { kind: 'reject' as const } : next())
  notification.admit('next-turn', message, { origin: 'native:test', sequence: 'rejected-1' })
  handle.agent.wakeInbox?.()
  await handle.agent.whenIdle()
  expect(adapter.requests).toHaveLength(0)
  expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'agent/notification/terminal').map(event => event.data)).toEqual([{ messageIds: [message.id], reason: 'rejected' }])
  stopReject()
  await handle.dispose()
  const reloaded = await ctx.agents.resume({ resumeSessionId: SessionId('rejected-reload'), agentOptions: { provider: 'mock', model: 'mock' } })
  try {
    const inbox = reloaded.agent.inbox.notifications!
    expect(inbox.receipt('native:test', 'rejected-1')?.id).toBe(message.id)
    expect(reloaded.agent.inbox.nextTurn).toEqual([])
    expect(reloaded.agent.inbox.nextStep).toEqual([])
    inbox.setFocus(true)
    expect(inbox.check('nothing-to-replay')).toEqual([])
    reloaded.agent.wakeInbox?.()
    await reloaded.agent.whenIdle()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(adapter.requests).toHaveLength(0)
    expect(reloaded.agent.status).toBe('idle')
  } finally { await reloaded.dispose() }
})

it('scopes Focus and human Stop to the foreground executor, not independent workers', async () => {
  const { ctx, adapter, agent, inbox } = await assembly(['hang'])
  const worker = await ctx.agentLoop.create(SessionId('independent-worker'), { provider: 'mock', model: 'mock' })
  worker.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'independent obligation' }] }))
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(worker.status).toBe('running')
  inbox.setFocus(true)
  ctx.goals.create(agent, { objective: 'foreground objective' })
  agent.cancel({ kind: 'user' })
  expect(ctx.goals.get(agent)?.phase).toBe('paused')
  expect(worker.status).toBe('running')
  expect(adapter.requests[0]?.signal?.aborted).toBe(false)
  worker.cancel({ kind: 'user' })
  await worker.whenIdle()
})

it('holds every background urgency and goal; foreground and one fixed Check return to static idle', async () => {
  const { ctx, adapter, agent, inbox } = await assembly()
  inbox.setFocus(true)
  const note = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const background = note('worker evidence')
  inbox.admit('next-step', background, { origin: 'native:test-worker', sequence: 'receipt-1', urgency: { kind: 'safety', reason: 'test grant' } })
  agent.wakeInbox?.()
  ctx.goals.create(agent, { objective: 'must not automatically continue' })
  await agent.whenIdle()
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(adapter.requests).toHaveLength(0)
  agent.followup(note('latest operator obligation'))
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(1)
  expect(adapter.requests[0]?.messages.flatMap(m => m.content).filter(b => b.type === 'text').map(b => b.text).join('\n')).not.toContain('worker evidence')
  const ids = inbox.check('explicit-check-1')
  agent.wakeInbox?.()
  await agent.whenIdle()
  expect(adapter.requests).toHaveLength(2)
  const late = note('late worker evidence')
  inbox.admit('next-step', late, { origin: 'native:test-worker', sequence: 'receipt-2' })
  expect(inbox.check('explicit-check-1')).toEqual(ids)
  agent.wakeInbox?.()
  await agent.whenIdle()
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(adapter.requests).toHaveLength(2)
  expect(inbox.focus).toEqual({ enabled: true, queued: 1 })
  agent.cancel({ kind: 'user' })
  expect(ctx.goals.get(agent)?.phase).toBe('paused')
  expect(inbox.receipt('native:test-worker', 'receipt-1')?.id).toBe(background.id)
  expect({ foregroundRequests: 1, checkRequests: 1, staticHoldRequests: adapter.requests.length - 2, goal: ctx.goals.get(agent)?.phase, lateHeld: inbox.focus.queued }).toMatchInlineSnapshot(`
    {
      "checkRequests": 1,
      "foregroundRequests": 1,
      "goal": "paused",
      "lateHeld": 1,
      "staticHoldRequests": 0,
    }
  `)
})
