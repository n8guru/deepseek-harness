/** Keyless assembled native HTTP admission with actual durable JSONL receipts. */
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import WebSocket from 'ws'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '../../../api/gateway/src/index.ts'
import { OperatorActivity } from '../src/operator-activity.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import GoalService from '@deepseek-ai/dsh-goal'
import HostMaintenance from '../../../core/agent-loop/src/maintenance.ts'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { expect, it, vi } from 'vitest'
import * as Connection from '../src/index.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

it('authenticates an actual caller, durably retries its identity and never accepts a forged foreground label', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-focus-'))
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
    await ctx.plugin(HostMaintenance, { receiptGrants: [{ owner: 'test:caller', kind: 'supervisor', target: { kind: 'agent', sessionId: 'wire-focus' } }] })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([textResponse('foreground checkpoint'), textResponse('receipt checkpoint')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('wire-focus'), { provider: 'mock', model: 'mock' })
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    provideBrowserCredentials(ctx)
    const bearer = 'mocked-approved-producer-bearer-123456789'
    await ctx.plugin(Connection, { maintenanceOwners: ['test:caller'], notificationProducers: [{
      origin: 'test:caller', bearerSha256: createHash('sha256').update(bearer).digest('hex'),
      sessionIds: [agent.id], urgency: ['safety'],
    }] })
    ctx.webServer.register({ kind: 'exact', path: '/', handler: (req, res) => {
      if (!ctx.connection.authorizeIndex(req, res)) { res.writeHead(401); res.end() }
    } })
    const base = `http://127.0.0.1:${ctx.webServer.port}`
    const exchange = await fetch(ctx.connection.authenticatedUrl(base), { redirect: 'manual' })
    const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
    if (cookie === undefined) throw new Error('real HTTP browser exchange did not return a cookie')
    const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + route, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    })
    const operator = (body: unknown) => post('/api/session.focus', { sessionId: agent.id, ...body as object }, { cookie })
    const set = await operator({ action: 'set', enabled: true })
    expect({ status: set.status, body: await set.text() }).toEqual({ status: 200, body: JSON.stringify({ enabled: true, queued: 0 }) })
    const body = { sessionId: agent.id, items: [{ sequence: 'changed-receipt-1', text: 'worker report', evidenceRefs: ['test://artifact'], urgency: { kind: 'safety', reason: 'authorized but Focus still holds' } }] }
    expect((await post('/api/notifications.admit', body, { cookie })).status).toBe(403)
    expect((await post('/api/session.focus', { sessionId: agent.id, action: 'inspect' }, { authorization: `Bearer ${bearer}` })).status).toBe(401)
    const accepted = await Promise.all([0, 1].map(() => post('/api/notifications.admit', body, { authorization: `Bearer ${bearer}` })))
    expect(accepted.map(response => response.status)).toEqual([200, 200])
    const receipts = await Promise.all(accepted.map(response => response.json()))
    const receipt = receipts[0]
    expect(receipts[1].receipts[0].messageId).toBe(receipt.receipts[0].messageId)
    expect(receipts.map(value => value.receipts[0].duplicate).sort()).toEqual([false, true])
    expect(receipt).toMatchObject({ accepted: true, origin: 'test:caller', focus: { enabled: true, queued: 1 } })
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    const retry = await post('/api/notifications.admit', body, { authorization: `Bearer ${bearer}` })
    expect(await retry.json()).toMatchObject({ receipts: [{ sequence: 'changed-receipt-1', duplicate: true }] })
    expect((await post('/api/notifications.admit', { ...body, origin: 'foreground' }, { authorization: `Bearer ${bearer}` })).status).toBe(400)
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'latest human obligation' }] }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const checked = await operator({ action: 'check', checkId: 'browser-check-1' })
    expect(checked.status).toBe(200)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect((await operator({ action: 'check', checkId: 'browser-check-1' })).status).toBe(200)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect({ producer: receipt.origin, foreground: 1, checked: 1, duplicateWake: adapter.requests.length - 2 }).toMatchInlineSnapshot(`
      {
        "checked": 1,
        "duplicateWake": 0,
        "foreground": 1,
        "producer": "test:caller",
      }
    `)
    const late = await post('/api/notifications.admit', { ...body, items: [{ sequence: 'late-receipt', text: 'late worker evidence' }] }, { authorization: `Bearer ${bearer}` })
    expect(late.status).toBe(200)
    const flush = vi.spyOn(ctx.sessions, 'flush').mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    try {
      expect((await operator({ action: 'check', checkId: 'failed-check' })).status).toBe(503)
      expect(agent.inbox.notifications?.focus).toEqual({ enabled: true, queued: 1 })
      agent.wakeInbox?.()
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(2)
    } finally { flush.mockRestore() }
    const admissionCuts: ReturnType<OperatorActivity['snapshot']>[] = []
    ctx.on('host-admission/changed', () => { admissionCuts.push(activity.snapshot(agent.id)) })
    const activity = new OperatorActivity(ctx, 300000)
    const beforeMaintenance = activity.snapshot(agent.id)!
    const maintenance = (body: unknown) => post('/api/maintenance.receive', body, { authorization: `Bearer ${bearer}` })
    expect((await post('/api/maintenance.receive', { action: 'close', runId: 'http-run' }, { cookie })).status).toBe(403)
    const closed = await maintenance({ action: 'close', runId: 'http-run' })
    expect(closed.status).toBe(200)
    expect(await closed.json()).toMatchObject({ owner: 'test:caller', runId: 'http-run', phase: 'closed' })
    expect(activity.snapshot(agent.id)).toMatchObject({ hostAdmission: 'closed' })
    expect(activity.snapshot(agent.id)!.controlRevision).toBeGreaterThan(beforeMaintenance.controlRevision)
    expect(admissionCuts[0]?.hostAdmission).toBe('closed')
    expect(admissionCuts[0]!.controlRevision).toBeGreaterThan(beforeMaintenance.controlRevision)
    expect(() => agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'blocked new work' }] }))).toThrow('admission closed')
    const delivery = { action: 'deliver-receipts', runId: 'http-run', items: [{ sequence: 'typed-supervisor', kind: 'supervisor', payload: 'trusted caller checkpoint', target: { kind: 'agent', sessionId: agent.id } }] }
    expect((await post('/api/maintenance.receive', delivery, { cookie })).status).toBe(403)
    const receiveTrace = vi.spyOn(ctx.hostMaintenance, 'receive')
    const delivered = await Promise.all([0, 1].map(() => maintenance(delivery)))
    const receiverErrors = await Promise.all(receiveTrace.mock.results.map(result =>
      Promise.resolve(result.value).then(() => undefined, error => String(error))))
    receiveTrace.mockRestore()
    expect({ statuses: delivered.map(response => response.status), receiverErrors }).toEqual({
      statuses: [200, 200], receiverErrors: [undefined, undefined],
    })
    const acknowledgements = await Promise.all(delivered.map(response => response.json()))
    expect(acknowledgements[0].deliveries).toEqual(acknowledgements[1].deliveries)
    const admission = acknowledgements[0].deliveries[0]
    expect(admission.status).toBe('delivered')
    expect(agent.inbox.notifications?.receipt('native:maintenance-receipt:test:caller', admission.messageId)?.content).toEqual([{ type: 'text', text: 'trusted caller checkpoint' }])
    expect((await maintenance({ ...delivery, items: [{ ...delivery.items[0], payload: 'different' }] })).status).toBe(409)
    expect((await maintenance({ ...delivery, items: [{ ...delivery.items[0], sequence: 'ungranted', target: { kind: 'agent', sessionId: 'another-target' } }] })).status).toBe(409)
    expect(agent.inbox.notifications?.focus.enabled).toBe(true)
    expect(adapter.requests).toHaveLength(2) // delivery does not wake or impersonate foreground
    expect((await maintenance({ action: 'release', runId: 'another-run' })).status).toBe(409)
    expect((await maintenance({ action: 'release', runId: 'http-run', owner: 'forged-owner' })).status).toBe(409)
    expect((await maintenance({ action: 'release', runId: 'http-run' })).status).toBe(200)
    expect(activity.snapshot(agent.id)!.hostAdmission).toBe('open')
    const beforeRejectedClose = activity.snapshot(agent.id)!
    admissionCuts.length = 0
    const rejected = ctx.hostMaintenance.receive('test:caller', { action: 'close', runId: 'http-run' })
    expect(activity.snapshot(agent.id)!.hostAdmission).toBe('closed')
    expect(activity.snapshot(agent.id)!.controlRevision).toBeGreaterThan(beforeRejectedClose.controlRevision)
    await expect(rejected).rejects.toThrow('released maintenance run')
    expect(admissionCuts.map(value => value?.hostAdmission)).toEqual(['closed', 'open'])
    expect(admissionCuts[0]!.controlRevision).toBeGreaterThan(beforeRejectedClose.controlRevision)
    expect(admissionCuts[1]!.controlRevision).toBeGreaterThan(admissionCuts[0]!.controlRevision)
    expect(activity.snapshot(agent.id)!.hostAdmission).toBe('open')
    expect(activity.snapshot(agent.id)!.controlRevision).toBeGreaterThan(beforeRejectedClose.controlRevision + 1)
    const beforeRoundTrip = activity.snapshot(agent.id)!
    await ctx.hostMaintenance.receive('test:caller', { action: 'close', runId: 'revision-roundtrip' })
    await ctx.hostMaintenance.receive('test:caller', { action: 'release', runId: 'revision-roundtrip' })
    expect(activity.snapshot(agent.id)!.hostAdmission).toBe('open')
    expect(activity.snapshot(agent.id)!.controlRevision).toBeGreaterThan(beforeRoundTrip.controlRevision)
    expect(adapter.requests).toHaveLength(2)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('binds activity to the authenticated Gateway socket and exact session without granting notification release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-activity-wire-'))
  const ctx = new Context()
  const sockets: WebSocket[] = []
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
    await ctx.plugin(HostMaintenance)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(GoalService)
    const adapter = new MockAdapter([textResponse('programmatic prompt')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('activity-wire'), { provider: 'mock', model: 'mock' })
    const bearer = 'activity-read-test-bearer-123456789012345'
    const denied = 'notification-only-bearer-123456789012345'
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    provideBrowserCredentials(ctx)
    await ctx.plugin(Connection, { notificationProducers: [
      { origin: 'test:activity', bearerSha256: createHash('sha256').update(bearer).digest('hex'),
        sessionIds: [agent.id], urgency: [], activityRead: true, activityGated: true },
      { origin: 'test:notify', bearerSha256: createHash('sha256').update(denied).digest('hex'),
        sessionIds: [agent.id], urgency: [] },
    ] })
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(Gateway, { websocketHeartbeatIntervalMs: 2000 })
    ctx.webServer.register({ kind: 'exact', path: '/', handler: (req, res) => {
      if (!ctx.connection.authorizeIndex(req, res)) { res.writeHead(401); res.end() }
    } })
    const base = `http://127.0.0.1:${ctx.webServer.port}`
    const exchange = await fetch(ctx.connection.authenticatedUrl(base), { redirect: 'manual' })
    const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
    if (cookie === undefined) throw new Error('cookie missing')
    const body = { version: 1, action: 'activity', sessionId: agent.id }
    const post = (payload: unknown, headers: Record<string, string> = { authorization: `Bearer ${bearer}` }) =>
      fetch(base + '/api/notifications.admit', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) })
    const read = async () => {
      const response = await post(body)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      return response.json()
    }
    expect((await post(body, { cookie })).status).toBe(403)
    expect((await post(body, { authorization: `Bearer ${denied}` })).status).toBe(403)
    expect((await post(body, { authorization: `Bearer ${bearer}`, origin: 'null' })).status).toBe(403)
    expect((await post({ ...body, sessionId: 'wrong-session' })).status).toBe(403)
    for (const extra of [{ origin: 'foreground' }, { isHuman: true }, { clientTime: 999999999999 }, { trusted: true }]) {
      expect((await post({ ...body, ...extra })).status).toBe(400)
    }
    expect((await read()).state).toBe('unknown')
    const connect = async () => {
      const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/remote.mux', { headers: { cookie, origin: base } })
      sockets.push(socket)
      await once(socket, 'open')
      return socket
    }
    const send = async (socket: WebSocket, message: object) => {
      const received = once(socket, 'message')
      socket.send(JSON.stringify(message))
      const [bytes] = await received
      return JSON.parse(String(bytes))
    }
    const socket = await connect()
    const opened = await send(socket, { type: 'open', streamId: 'activity', endpoint: 'session.operatorActivity', payload: { version: 1, sessionId: agent.id } })
    expect(opened.type).toBe('item')
    const bindingEpoch = opened.value.bindingEpoch
    expect(typeof bindingEpoch).toBe('string')
    expect((await read()).state).toBe('unknown')
    const frame = (sequence: number, extra = {}) => ({ type: 'item', streamId: 'activity', value: { version: 1, bindingEpoch, sequence, interaction: 'input', ...extra } })
    expect((await send(socket, frame(1))).value.accepted).toBe(true)
    const active = await read()
    expect(active).toMatchObject({ state: 'active', eligible: false, stop: 'clear', goal: { state: 'none' }, hostAdmission: 'open', binding: { bindingEpoch, principalClass: 'authenticated-operator-gui' } })
    for (const bad of [frame(1), frame(2, { bindingEpoch: 'forged' }), frame(2, { lastActivityAt: 1 }), frame(2, { sequence: Number.MAX_SAFE_INTEGER + 1 })]) {
      expect((await send(socket, bad)).value.accepted).toBe(false)
      expect(await read()).toMatchObject({ lastActivityAt: active.lastActivityAt, activityRevision: active.activityRevision })
    }
    const second = await connect()
    const next = await send(second, { type: 'open', streamId: 'activity', endpoint: 'session.operatorActivity', payload: { version: 1, sessionId: agent.id } })
    expect(next.value.bindingEpoch).not.toBe(bindingEpoch)
    expect((await read()).binding.bindingEpoch).toBe(bindingEpoch)
    expect((await send(second, frame(1))).value.accepted).toBe(false)
    const closed = once(second, 'close'); second.close(); await closed
    expect((await read()).binding.bindingEpoch).toBe(bindingEpoch)
    const operator = (payload: object, headers: Record<string, string> = { cookie }) => fetch(base + '/api/session.focus', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ sessionId: agent.id, ...payload }),
    })
    agent.cancel({ kind: 'user' })
    const stopped = await read()
    expect(stopped.stop).toBe('stopped')
    expect(stopped.controlRevision).toBeGreaterThan(active.controlRevision)
    expect((await operator({ action: 'resume' }, { authorization: `Bearer ${bearer}` })).status).toBe(401)
    expect((await operator({ action: 'resume', isHuman: true })).status).toBe(400)
    expect((await operator({ action: 'resume' }, { cookie, origin: 'null' })).status).toBe(403)
    expect((await read()).stop).toBe('stopped')
    expect((await operator({ action: 'set', enabled: true })).status).toBe(200)
    expect((await read()).stop).toBe('stopped')
    expect((await operator({ action: 'resume' })).status).toBe(200)
    expect(await read()).toMatchObject({ stop: 'clear', focus: 'enabled', lastActivityAt: active.lastActivityAt })
    expect((await read()).controlRevision).toBeGreaterThan(stopped.controlRevision)
    expect(adapter.requests).toHaveLength(0)
    expect((await operator({ action: 'set', enabled: false })).status).toBe(200)
    const allClear = await read()
    expect(allClear).toMatchObject({ state: 'active', stop: 'clear', focus: 'disabled', goal: { state: 'none' }, hostAdmission: 'open', foregroundBusy: false, eligible: false })
    const count = agent.session.seq
    for (const payload of [
      { sessionId: agent.id, items: [{ sequence: 'held', text: 'must not enter' }] },
      { sessionId: agent.id, activityGated: false, items: [{ sequence: 'held', text: 'must not enter' }] },
      { sessionId: agent.id, activityGuard: { version: 1, hostEpoch: allClear.hostEpoch, bindingEpoch, activityRevision: allClear.activityRevision, controlRevision: allClear.controlRevision }, items: [{ sequence: 'held', text: 'must not enter' }] },
    ]) expect((await post(payload)).status).toBe(409)
    expect(agent.session.seq).toBe(count)
    expect(adapter.requests).toHaveLength(0)
    expect((await send(socket, frame(2, { interaction: 'leave' }))).value.accepted).toBe(true)
    expect(await read()).toMatchObject({ state: 'stale', lastActivityAt: active.lastActivityAt })
    expect((await send(socket, frame(3))).value.accepted).toBe(false)
    agent.cancel({ kind: 'user' })
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'programmatic' }] }))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(await read()).toMatchObject({ state: 'stale', stop: 'stopped', lastActivityAt: active.lastActivityAt })

    // Fake clocks exercise equality and rollback without advancing Gateway timers.
    let wall = 1000000, mono = 0
    const owner = new OperatorActivity(ctx, 300000, { wall: () => wall, mono: () => mono })
    const frames: unknown[] = []
    const source = { async *[Symbol.asyncIterator]() { while (frames.length) yield frames.shift() } }
    const stream = owner.open(
      { version: 1, sessionId: agent.id }, source, { live: () => true, observed: () => {} }, () => true, new AbortController().signal,
    )
    const iterator = stream[Symbol.asyncIterator]()
    const initial = await iterator.next()
    const epoch = (initial.value as { bindingEpoch: string }).bindingEpoch
    frames.push({ version: 1, bindingEpoch: epoch, sequence: 1, interaction: 'input' })
    await iterator.next()
    expect(owner.snapshot(agent.id)?.state).toBe('active')
    wall += 299999; mono += 299999
    expect(owner.snapshot(agent.id)?.state).toBe('active')
    wall++; mono++
    expect(owner.snapshot(agent.id)?.state).toBe('idle')
    wall--
    expect(owner.snapshot(agent.id)?.state).toBe('unknown')
    frames.push({ version: 1, bindingEpoch: epoch, sequence: 2, interaction: 'input' })
    await iterator.next()
    expect(owner.snapshot(agent.id)?.state).toBe('active')
    await iterator.return?.()
    expect(owner.snapshot(agent.id)?.state).toBe('stale')
    expect(() => new OperatorActivity(ctx, 999)).toThrow('idleThresholdMs')
  } finally {
    for (const socket of sockets) socket.terminate()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
