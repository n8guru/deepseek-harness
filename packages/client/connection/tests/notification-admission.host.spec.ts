import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply as applyConnection } from '../src/index.ts'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { admitNotifications, authenticateNotification, controlFocus, type NotificationProducer } from '../src/notification-admission.ts'

// Deliberately public, test-only bearer. Never reads a credential file or environment.
const token = 'mock-only-notification-credential-0000000000000000'
const producer: NotificationProducer = { origin: 'test:notifier', bearerSha256: createHash('sha256').update(token).digest('hex'), sessionIds: ['focus-owner'], urgency: ['security'] }
const item = (sequence = 'message_seq:1') => ({ sequence, text: 'worker result; NEW CARD; blocker', evidenceRefs: ['repo://result/1'] })
const request = (body: unknown, bearer = token) => new Request('http://127.0.0.1:3080/api/notifications.admit', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}`, host: '127.0.0.1:3080' }, body: JSON.stringify(body) })
const focusRequest = (action: string, other: object = {}) => new Request('http://127.0.0.1:3080/api/session.focus', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'focus-owner', action, ...other }) })
const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function setup(script = [textResponse('foreground'), textResponse('checked')], durable = true) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  if (durable) ctx.on('session/flush', () => {})
  const handle = await ctx.agents.create({ sessionId: SessionId('focus-owner'), agentOptions: { provider: 'mock', model: 'mock' } })
  handle.agent.inbox.setFocus(true)
  return { ctx, adapter, handle, agent: handle.agent }
}

describe('authenticated notification ABI assembled with native Agent', () => {
  it('fails closed without grants or valid bearer; spoofed origin and Host are not authority', async () => {
    const { ctx, agent } = await setup()
    expect(authenticateNotification(request({}), [])).toBeUndefined()
    expect((await admitNotifications(ctx, request({ sessionId: agent.id, items: [item()] }, 'invalid-but-long-enough-to-test-authentication'), [producer])).status).toBe(403)
    expect((await admitNotifications(ctx, request({ sessionId: agent.id, origin: 'coordinator', items: [item()] }), [producer])).status).toBe(400)
    const noAuth = request({ sessionId: agent.id, items: [item()] })
    noAuth.headers.delete('authorization')
    noAuth.headers.set('clientLabel', 'notifier')
    noAuth.headers.set('x-notification-origin', producer.origin)
    expect((await admitNotifications(ctx, noAuth, [producer])).status).toBe(403)
    expect(agent.inbox.focus.queued).toBe(0)
  })

  it('mounts the actual Connection HTTP producer route, not a caller-controlled session.prompt field', async () => {
    const { ctx, agent } = await setup()
    const routes: WebRoute[] = []
    ctx.provide('webServer', { register(route: WebRoute) { routes.push(route); return () => {} }, registerUpgrade() { return () => {} }, tapIndex() { return () => {} }, port: 0 } as WebServer)
    applyConnection(ctx, { notificationProducers: [producer] })
    async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { url: path, method: 'POST', headers: { host: '127.0.0.1:3080', 'content-type': 'application/json', ...headers } }) as IncomingMessage
      let status = 0
      const chunks: Buffer[] = []
      const res = Object.assign(new EventEmitter(), {
        writableEnded: false,
        writeHead(value: number) { status = value; return this },
        write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
        end(this: { writableEnded: boolean }, value?: string | Uint8Array) {
          if (value !== undefined) chunks.push(Buffer.from(value))
          this.writableEnded = true
        },
      }) as unknown as ServerResponse
      await routes[0]!.handler(req, res)
      return { status, text: Buffer.concat(chunks).toString() }
    }
    const body = { sessionId: agent.id, items: [item()] }
    expect((await post('/api/notifications.admit', body)).status).toBe(403)
    expect((await post('/api/notifications.admit', body, { authorization: `Bearer ${token}`, host: 'attacker.example' })).status).toBe(403)
    const accepted = await post('/api/notifications.admit', body, { authorization: `Bearer ${token}` })
    expect(accepted.status).toBe(200)
    expect(JSON.parse(accepted.text).origin).toBe(producer.origin)
    const inspected = await post('/api/session.focus', { sessionId: agent.id, action: 'inspect' })
    expect(JSON.parse(inspected.text)).toEqual({ enabled: true, queued: 1 })
  })

  it('requires explicit operator mutation arguments and defers concurrent Check at the maintenance fence', async () => {
    const { ctx, agent } = await setup()
    expect((await controlFocus(ctx, focusRequest('set'))).status).toBe(400)
    expect((await controlFocus(ctx, focusRequest('check'))).status).toBe(400)
    expect(agent.inbox.focus.enabled).toBe(true)
    await admitNotifications(ctx, request({ sessionId: agent.id, items: [item()] }), [producer])
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const dispose = ctx.on('session/flush', () => { entered.resolve(undefined); return gate.promise })
    const first = controlFocus(ctx, focusRequest('check', { checkId: 'one' }))
    await entered.promise
    expect((await controlFocus(ctx, focusRequest('check', { checkId: 'two' }))).status).toBe(409)
    gate.resolve(undefined)
    expect((await first).status).toBe(200)
    dispose()
    await agent.whenIdle()
    expect(agent.session.events.filter(e => e.type === 'agent/focus' && e.data.check !== undefined)).toHaveLength(1)
  })

  it('host grant owns target and urgency, all items validated before admission', async () => {
    const { ctx, agent } = await setup()
    expect((await admitNotifications(ctx, request({ sessionId: 'other', items: [item()] }), [producer])).status).toBe(403)
    expect((await admitNotifications(ctx, request({ sessionId: agent.id, items: [item(), { ...item('2'), urgency: { kind: 'deadline', reason: 'real deadline' } }] }), [producer])).status).toBe(403)
    expect((await admitNotifications(ctx, request({ sessionId: agent.id, items: [item(), item()] }), [producer])).status).toBe(400)
    expect(agent.inbox.focus.queued).toBe(0)
  })

  it('retains accepted items across ambiguous ACK, retries by message_seq, and rejects changed payload under one identity', async () => {
    const { ctx, agent, adapter } = await setup()
    const body = { sessionId: agent.id, items: [item()] }
    const first = await (await admitNotifications(ctx, request(body), [producer])).json()
    const retry = await (await admitNotifications(ctx, request(body), [producer])).json()
    expect(first.receipts[0].messageId).toBe(retry.receipts[0].messageId)
    expect(retry.receipts[0].duplicate).toBe(true)
    expect((await admitNotifications(ctx, request({ ...body, items: [{ ...item(), text: 'changed' }] }), [producer])).status).toBe(409)
    expect((await admitNotifications(ctx, request({ ...body, items: [item('message_seq:2')] }), [producer])).status).toBe(200)
    expect(agent.inbox.focus.queued).toBe(2)
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.events.filter(e => e.type === 'agent/inbox/spliced')).toHaveLength(2)
  })

  it('never ACKs without a durability participant and retains the pending exact admission for retry', async () => {
    const { ctx, agent } = await setup(undefined, false)
    const body = { sessionId: agent.id, items: [item()] }
    expect((await admitNotifications(ctx, request(body), [producer])).status).toBe(503)
    expect(agent.inbox.focus.queued).toBe(1)
    ctx.on('session/flush', () => {})
    const retry = await (await admitNotifications(ctx, request(body), [producer])).json()
    expect(retry.receipts[0].duplicate).toBe(true)
    expect(agent.inbox.focus.queued).toBe(1)
  })

  it('retries an unacknowledged runnable admission without losing its wake or replaying a consumed receipt', async () => {
    const { ctx, agent, adapter } = await setup(undefined, false)
    agent.inbox.setFocus(false)
    const body = { sessionId: agent.id, items: [item()] }
    expect((await admitNotifications(ctx, request(body), [producer])).status).toBe(503)
    expect(adapter.requests).toHaveLength(0)
    ctx.on('session/flush', () => {})
    expect((await admitNotifications(ctx, request(body), [producer])).status).toBe(200)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect((await admitNotifications(ctx, request(body), [producer])).status).toBe(200)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
  })

  it('human report quotations run immediately without consuming held notifications or busy looping', async () => {
    const { ctx, agent, adapter } = await setup()
    await admitNotifications(ctx, request({ sessionId: agent.id, items: [item()] }), [producer])
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'I quote WORKER SETTLED NEW CARD; Nate test' }] }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(agent.inbox.focus.queued).toBe(1)
    expect(agent.inbox.hasPending).toBe(false)
    expect(agent.session.events.filter(e => e.type === 'user/message')).toHaveLength(1)
  })

  it('Check drains one explicit snapshot; repeated Check and late updates do not steal turns', async () => {
    const { ctx, agent, adapter } = await setup()
    await admitNotifications(ctx, request({ sessionId: agent.id, items: [item()] }), [producer])
    expect((await controlFocus(ctx, focusRequest('check', { checkId: 'snapshot-1' }))).status).toBe(200)
    await agent.whenIdle()
    const count = adapter.requests.length
    await admitNotifications(ctx, request({ sessionId: agent.id, items: [item('message_seq:2')] }), [producer])
    expect((await controlFocus(ctx, focusRequest('check', { checkId: 'snapshot-1' }))).status).toBe(200)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(count)
    expect(agent.inbox.focus.queued).toBe(1)
  })

  it('authorized critical security notice bypasses WAITING_FOR_NATE truthfully, ordinary work remains held', async () => {
    const { ctx, agent, adapter } = await setup()
    await admitNotifications(ctx, request({ sessionId: agent.id, items: [item()] }), [producer])
    const urgent = { ...item('critical'), urgency: { kind: 'security', reason: 'confirmed exposed credential; immediate containment required' } }
    await admitNotifications(ctx, request({ sessionId: agent.id, items: [urgent] }), [producer])
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(agent.inbox.focus.queued).toBe(1)
    expect(agent.session.events.filter(e => e.type === 'user/message')).toHaveLength(1)
  })

  it('human arrival at Check checkpoint wins before snapshot release', async () => {
    const { ctx, agent, adapter } = await setup()
    await admitNotifications(ctx, request({ sessionId: agent.id, items: [item()] }), [producer])
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const dispose = ctx.on('session/flush', () => { entered.resolve(undefined); return gate.promise })
    const checking = controlFocus(ctx, focusRequest('check', { checkId: 'raced' }))
    await entered.promise
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'foreground test now' }] }))
    gate.resolve(undefined)
    expect((await checking).status).toBe(409)
    dispose()
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(agent.inbox.focus.queued).toBe(1)
  })

  it('Stop during Check checkpoint preserves all pending evidence without a wake', async () => {
    const { ctx, agent, adapter } = await setup()
    await admitNotifications(ctx, request({ sessionId: agent.id, items: [item()] }), [producer])
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const dispose = ctx.on('session/flush', () => { entered.resolve(undefined); return gate.promise })
    const checking = controlFocus(ctx, focusRequest('check', { checkId: 'stopped' }))
    await entered.promise
    agent.cancel({ kind: 'user' })
    gate.resolve(undefined)
    await expect(checking).rejects.toBeDefined()
    dispose()
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    expect(agent.inbox.focus.queued).toBe(1)
  })

  it('native tool check checkpoints and gives no background autorun or Nate-test verdict', async () => {
    const { ctx, agent, adapter } = await setup([
      toolCallResponse('focus-check', 'session_focus', { action: 'check', check_id: 'tool-snapshot' }, 'one bounded action complete'),
      textResponse('one bounded next action; waiting for Nate'),
    ])
    await admitNotifications(ctx, request({ sessionId: agent.id, items: [item()] }), [producer])
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'one action, checkpoint, Check, foreground' }] }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(agent.inbox.focus.queued).toBe(0)
    expect(agent.session.events.some(e => e.type === 'tool/result' && e.data.isError)).toBe(false)
    expect(agent.session.events.filter(e => e.type === 'agent/focus')).toHaveLength(2)
  })

  it('actual JSONL disposal/reload preserves Focus, original receipts and successor evidence', async () => {
    const { ctx, handle, agent, adapter } = await setup()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-focus-'))
    directories.push(dir)
    await ctx.plugin(JsonlSessionPersistence, { root: dir, compression: 'none' })
    const body = { sessionId: agent.id, items: [item()] }
    const first = await (await admitNotifications(ctx, request(body), [producer])).json()
    await handle.dispose()
    const resumed = await ctx.agents.resume({ resumeSessionId: agent.id, agentOptions: { provider: 'mock', model: 'mock' } })
    expect(resumed.agent.inbox.focus).toEqual({ enabled: true, queued: 1 })
    const retry = await (await admitNotifications(ctx, request(body), [producer])).json()
    expect(retry.receipts[0].messageId).toBe(first.receipts[0].messageId)
    expect(resumed.agent.inbox.nextStep[0]?.content).toEqual([
      { type: 'text', text: item().text }, { type: 'text', text: 'Evidence: repo://result/1' },
    ])
    expect(adapter.requests).toHaveLength(0)
    await resumed.dispose()
  })
})
