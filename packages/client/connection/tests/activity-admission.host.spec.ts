/** Real authenticated transport, durable custody and native final model-entry checks. */
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import GoalService from '@deepseek-ai/dsh-goal'
import HostMaintenance from '../../../core/agent-loop/src/maintenance.ts'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '../../../api/gateway/src/index.ts'
import { expect, it, vi } from 'vitest'
import * as Connection from '../src/index.ts'
import type { ActivitySnapshot } from '../src/rpc.ts'

type CustodyAck = { accepted: true; delivery: 'held' | 'eligible'; activity: ActivitySnapshot; receipts: { sequence: string; messageId: string; duplicate: boolean }[] }
import { provideBrowserCredentials } from './browser-credentials.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function fixture(script = Array.from({ length: 20 }, () => textResponse('noted'))) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gated-admission-'))
  const ctx = new Context()
  const sockets: WebSocket[] = []
  let mono = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => mono)
  const close = async () => {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.CLOSED) continue
      const closed = once(socket, 'close')
      socket.terminate()
      await closed
    }
    try { await ctx.fiber.dispose() } finally {
      clock.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  }
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
    const adapter = new MockAdapter(script)
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('gated-admission'), { provider: 'mock', model: 'mock' })
    const bearer = 'gated-admission-producer-123456789012345'
    const legacy = 'legacy-admission-producer-123456789012345'
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    provideBrowserCredentials(ctx)
    await ctx.plugin(Connection, { notificationProducers: [
      { origin: 'test:gated', bearerSha256: createHash('sha256').update(bearer).digest('hex'),
        sessionIds: [agent.id], urgency: [], activityRead: true, activityGated: true },
      { origin: 'test:legacy', bearerSha256: createHash('sha256').update(legacy).digest('hex'),
        sessionIds: [agent.id], urgency: [] },
    ] })
    await ctx.plugin(TypertRegistry)
    // Long heartbeat isolates inactivity from socket expiry; both use the injected monotonic clock.
    await ctx.plugin(Gateway, { websocketHeartbeatIntervalMs: 3600000 })
    ctx.webServer.register({ kind: 'exact', path: '/', handler: (req, res) => {
      if (!ctx.connection.authorizeIndex(req, res)) { res.writeHead(401); res.end() }
    } })
    const base = `http://127.0.0.1:${ctx.webServer.port}`
    const exchange = await fetch(ctx.connection.authenticatedUrl(base), { redirect: 'manual' })
    const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
    if (cookie === undefined) throw new Error('browser authentication failed')
    const post = (body: unknown, token = bearer) => fetch(base + '/api/notifications.admit', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    })
    const read = async () => {
      const response = await post({ version: 1, action: 'activity', sessionId: agent.id })
      expect(response.status).toBe(200)
      return response.json() as Promise<ActivitySnapshot>
    }
    const send = async (socket: WebSocket, message: object) => {
      const received = once(socket, 'message')
      socket.send(JSON.stringify(message))
      const bytes: unknown[] = await received
      return JSON.parse(String(bytes[0])) as { value: { bindingEpoch: string; accepted: boolean } }
    }
    const connect = async () => {
      const socket = new WebSocket(base.replace('http:', 'ws:') + '/api/remote.mux', { headers: { cookie, origin: base } })
      sockets.push(socket)
      await once(socket, 'open')
      const opened = await send(socket, { type: 'open', streamId: 'activity', endpoint: 'session.operatorActivity',
        payload: { version: 1, sessionId: agent.id } })
      const bindingEpoch = opened.value.bindingEpoch
      let sequence = 0
      const gesture = async (interaction = 'input') => {
        const result = await send(socket, { type: 'item', streamId: 'activity',
          value: { version: 1, bindingEpoch, sequence: ++sequence, interaction } })
        expect(result.value.accepted).toBe(true)
      }
      return { socket, gesture }
    }
    const stream = await connect()
    await stream.gesture()
    const snapshot = await read()
    expect(snapshot.holdReasons).toEqual([])
    const guard = { version: 1, hostEpoch: snapshot.hostEpoch, bindingEpoch: snapshot.binding!.bindingEpoch,
      activityRevision: snapshot.activityRevision, controlRevision: snapshot.controlRevision }
    const body = { sessionId: agent.id, activityGuard: guard,
      items: [{ sequence: 'first', text: 'first evidence' }, { sequence: 'second', text: 'second evidence' }] }
    return { ctx, agent, adapter, post, read, body, legacy, stream, connect, close, advance: (ms: number) => { mono += ms } }
  } catch (error) { await close(); throw error }
}

it('requires a current exact guard, enters fresh input once, and never wakes receipt-only retry', async () => {
  const f = await fixture()
  try {
    const original = f.agent.session.seq
    for (const activityGuard of [
      { ...f.body.activityGuard, hostEpoch: 'forged' },
      { ...f.body.activityGuard, bindingEpoch: 'another-socket' },
      { ...f.body.activityGuard, activityRevision: f.body.activityGuard.activityRevision + 1 },
      { ...f.body.activityGuard, controlRevision: f.body.activityGuard.controlRevision + 1 },
    ]) expect((await f.post({ ...f.body, activityGuard })).status).toBe(409)
    expect((await f.post({ sessionId: f.agent.id, items: f.body.items })).status).toBe(409)
    expect((await f.post(f.body, 'wrong-bearer-123456789012345678901234567890')).status).toBe(403)
    expect((await f.post({ ...f.body, sessionId: 'wrong-session' })).status).toBe(403)
    expect((await f.post({ version: 1, action: 'activity', sessionId: f.agent.id }, f.legacy)).status).toBe(403)
    expect((await f.post(f.body, f.legacy)).status).not.toBe(200)
    for (const extra of [{ activityGated: false }, { eligible: true }, { origin: 'foreground' }]) {
      expect((await f.post({ ...f.body, ...extra })).status).toBe(400)
    }
    expect((await f.post({ ...f.body, items: [f.body.items[0], f.body.items[0]] })).status).toBe(400)
    expect((await f.post({ ...f.body, items: Array.from({ length: 11 }, (_, i) => ({ sequence: String(i), text: 'bounded' })) })).status).toBe(400)
    expect(f.agent.session.seq).toBe(original)
    const response = await f.post(f.body)
    expect(response.status).toBe(200)
    const receipt = await response.json() as CustodyAck
    expect(receipt).toMatchObject({ accepted: true, origin: 'test:gated',
      receipts: [{ sequence: 'first', duplicate: false }, { sequence: 'second', duplicate: false }] })
    expect(receipt.delivery).toBe(receipt.activity.eligible ? 'eligible' : 'held')
    await f.agent.whenIdle()
    expect((await f.read()).eligible).toBe(true)
    expect(f.adapter.requests).toHaveLength(1)
    expect(receipt.receipts.map(r => r.messageId)).toEqual(f.agent.session.snapshotEvents()
      .filter(e => e.type === 'user/message').filter(e => receipt.receipts.some(r => r.messageId === e.data.id)).map(e => e.data.id))
    expect(f.agent.inbox.nextStep).toHaveLength(0)
    expect(await f.ctx.sessions.flush(f.agent.session)).toBe(true)
    f.advance(300000)
    expect((await f.read()).state).toBe('idle')
    const beforeReplay = f.agent.session.seq
    const replay = await f.post(f.body)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ accepted: true, delivery: 'held',
      receipts: receipt.receipts.map((r: object) => ({ ...r, duplicate: true })) })
    expect(f.agent.session.seq).toBe(beforeReplay)
    expect((await f.post({ ...f.body, items: [f.body.items[0], { sequence: 'late', text: 'late evidence' }] })).status).toBe(409)
    expect((await f.post({ ...f.body, items: [{ ...f.body.items[0], text: 'conflicting evidence' }] })).status).toBe(409)
    expect(f.agent.session.seq).toBe(beforeReplay)
    expect(f.agent.inbox.notifications!.receipt('test:gated', 'late')).toBeUndefined()
    f.agent.wakeInbox?.()
    await f.agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.agent.session.snapshotEvents().filter(e => e.type === 'user/message')).toHaveLength(2)
  } finally { await f.close() }
})

for (const hold of ['idle', 'stop', 'focus', 'focus-roundtrip', 'maintenance', 'goal-paused', 'goal-disarmed', 'reconnect'] as const) {
  it(`refuses new custody before mutation when ${hold} wins after snapshot`, async () => {
    const f = await fixture()
    try {
      if (hold === 'idle') f.advance(300000)
      if (hold === 'stop') f.agent.cancel({ kind: 'user' })
      if (hold === 'focus') f.agent.inbox.notifications!.setFocus(true)
      if (hold === 'focus-roundtrip') { f.agent.inbox.notifications!.setFocus(true); f.agent.inbox.notifications!.setFocus(false) }
      if (hold === 'maintenance') await f.ctx.hostMaintenance.receive('test:owner', { action: 'close', runId: 'before-admission' })
      if (hold === 'goal-paused' || hold === 'goal-disarmed') {
        const goal = f.ctx.goals.create(f.agent, { objective: 'pre-admission hold' })
        if (hold === 'goal-paused') f.ctx.goals.pause(f.agent, goal)
        else f.ctx.goals.disarm(f.agent)
      }
      if (hold === 'reconnect') {
        const closed = once(f.stream.socket, 'close')
        f.stream.socket.close()
        await closed
        await f.connect()
      }
      const before = f.agent.session.seq
      expect((await f.post(f.body)).status).toBe(409)
      expect(f.agent.session.seq).toBe(before)
      expect(f.agent.inbox.nextStep).toHaveLength(0)
      expect(f.adapter.requests).toHaveLength(0)
    } finally { await f.close() }
  })
}

for (const race of ['idle', 'transport-expiry', 'stop', 'focus', 'focus-roundtrip', 'maintenance', 'goal-paused', 'goal-disarmed', 'reconnect', 'write-failure', 'write-throw'] as const) {
  it(`holds across awaited durable flush: ${race}`, async () => {
    const f = await fixture()
    const reached = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    const spy = vi.spyOn(f.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      reached.resolve(undefined)
      await release.promise
      if (race === 'write-throw') throw new Error('injected durable participant failure')
      return race === 'write-failure' ? false : flush(session)
    })
    let pending: Promise<Response> | undefined
    try {
      pending = f.post(f.body)
      await Promise.race([reached.promise, pending.then(() => { throw new Error('admission returned before reaching durable flush') })])
      expect(f.agent.inbox.nextStep).toHaveLength(2)
      if (race === 'idle') f.advance(300000)
      if (race === 'transport-expiry') f.advance(7200000)
      if (race === 'stop') f.agent.cancel({ kind: 'user' })
      if (race === 'focus') f.agent.inbox.notifications!.setFocus(true)
      if (race === 'focus-roundtrip') { f.agent.inbox.notifications!.setFocus(true); f.agent.inbox.notifications!.setFocus(false) }
      if (race === 'maintenance') await f.ctx.hostMaintenance.receive('test:owner', { action: 'close', runId: 'during-flush' })
      if (race === 'goal-paused' || race === 'goal-disarmed') {
        const goal = f.ctx.goals.create(f.agent, { objective: 'test native control hold' })
        if (race === 'goal-paused') f.ctx.goals.pause(f.agent, goal)
        else f.ctx.goals.disarm(f.agent)
      }
      if (race === 'reconnect') {
        const closed = once(f.stream.socket, 'close')
        f.stream.socket.close()
        await closed
        await f.connect() // a fresh socket has no qualifying gesture
      }
      release.resolve(undefined)
      const response = await pending
      if (race === 'write-throw') {
        expect(response.status).toBe(409)
        expect(await response.text()).toContain('no accepted ACK')
      } else if (race === 'write-failure') {
        expect(response.status).toBe(503)
      } else {
        expect(response.status).toBe(200)
        const receipt = await response.json() as CustodyAck
        expect(receipt).toMatchObject({ accepted: true, delivery: 'held' })
        // The ACK must contain the post-await cut, not the pre-insertion snapshot.
        const { observedAt, ...cut } = await f.read()
        expect(receipt.activity).toMatchObject(cut)
        expect(receipt.activity.observedAt).toBeLessThanOrEqual(observedAt)
      }
      spy.mockRestore()
      const state = await f.read()
      if (race === 'idle') expect(state.state).toBe('idle')
      if (race === 'transport-expiry') expect(state.state).toBe('stale')
      if (race === 'stop') expect(state.stop).toBe('stopped')
      if (race === 'focus') expect(state.focus).toBe('enabled')
      if (race === 'focus-roundtrip') {
        expect(state.focus).toBe('disabled')
        expect(state.controlRevision).toBeGreaterThan(f.body.activityGuard.controlRevision)
      }
      if (race === 'maintenance') expect(state.hostAdmission).toBe('closed')
      if (race === 'goal-paused') expect(state.goal).toMatchObject({ state: 'present', phase: 'paused' })
      if (race === 'goal-disarmed') expect(state.goal).toMatchObject({ state: 'present', activation: 'disarmed' })
      if (race === 'reconnect') expect(state.state).toBe('unknown')
      const ids = f.agent.inbox.nextStep.map(m => m.id)
      const retried = await f.post(f.body)
      expect(retried.status).toBe(200)
      expect(await retried.json()).toMatchObject({ accepted: true, delivery: 'held',
        receipts: ids.map((messageId, i) => ({ sequence: f.body.items[i]!.sequence, messageId, duplicate: true })) })
      expect(f.agent.inbox.nextStep.map(m => m.id)).toEqual(ids)
      f.agent.wakeInbox?.()
      await f.agent.whenIdle()
      expect(f.adapter.requests).toHaveLength(0)
      expect(f.agent.session.snapshotEvents().some(e => e.type === 'user/message')).toBe(false)
    } finally {
      release.resolve(undefined)
      await pending?.catch(() => {})
      spy.mockRestore()
      await f.close()
    }
  })
}

it('retires an armed selection when maintenance finishes without a driver wake', async () => {
  const f = await fixture()
  const wake = vi.spyOn(f.agent, 'wakeInbox').mockImplementationOnce(() => {})
  try {
    const ack = await (await f.post(f.body)).json() as CustodyAck
    await f.agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(0)
    expect(f.agent.inbox.nextStep.map(message => message.id)).toEqual(ack.receipts.map(receipt => receipt.messageId))
    expect(f.agent.inbox.nextStep.every(message => f.agent.inbox.notifications!.isHeld(message))).toBe(true)
    wake.mockRestore()
    await f.stream.gesture()
    await f.agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(1)
  } finally { wake.mockRestore(); await f.close() }
})

it('continues a released notification through its tool-result model step', async () => {
  const f = await fixture([toolCallResponse('activity-tool', 'echo', {}), textResponse('done')])
  let tools = 0
  f.ctx.tools.register(defineContentToolFixture({
    name: 'echo', description: 'echo', parameters: {},
    async execute() { tools++; return [{ type: 'text', text: 'echo' }] },
  }))
  try {
    const ack = await (await f.post(f.body)).json() as CustodyAck
    await f.agent.whenIdle()
    expect(tools).toBe(1)
    expect(f.adapter.requests).toHaveLength(2)
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data.id))
      .toEqual(ack.receipts.map(receipt => receipt.messageId))
  } finally { await f.close() }
})

it('preserves a tool continuation while selected queued turns still await acceptance', async () => {
  const f = await fixture([toolCallResponse('queued-activity-tool', 'echo', {}), textResponse('first done'), textResponse('second done')])
  let tools = 0
  f.ctx.tools.register(defineContentToolFixture({
    name: 'echo', description: 'echo', parameters: {},
    async execute() { tools++; return [{ type: 'text', text: 'echo' }] },
  }))
  try {
    const receipts = f.agent.inbox.notifications!.stageActivityGated!('next-turn', f.body.items.map(item => ({
      message: createUserMessage({ source: { kind: 'notification', origin: 'test:gated', form: 'notice', summary: 'queued' },
        content: [{ type: 'text', text: item.text }] }),
      admission: { origin: 'test:gated', sequence: item.sequence, activityGated: true },
    })), { ...f.body.activityGuard, version: 1 })
    await f.stream.gesture()
    await f.agent.whenIdle()
    expect(tools).toBe(1)
    expect(f.adapter.requests).toHaveLength(3)
    expect(f.agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data.id))
      .toEqual(receipts.map(receipt => receipt.messageId))
    expect(f.agent.inbox.nextTurn).toHaveLength(0)
  } finally { await f.close() }
})

for (const boundary of ['wake-status', 'claim'] as const) {
  for (const action of ['steer', 'followup', 'insert-remove'] as const) {
    it(`retires selected background admission for foreground ${action} at ${boundary}`, async () => {
      const f = await fixture()
      const foreground = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'foreground' }] })
      let changed = false
      const change = () => {
        if (changed) return
        changed = true
        if (action === 'followup') f.agent.followup(foreground)
        else f.agent.inject(foreground)
        if (action === 'insert-remove') f.agent.inbox.remove(foreground.id)
      }
      const dispose = boundary === 'claim' ? f.ctx.on('agent/inbox/claimed', change)
        : f.ctx.on('agent/status', ({ status }) => { if (status === 'running') change() })
      try {
        const ack = await (await f.post(f.body)).json() as CustodyAck
        await f.agent.whenIdle()
        expect(changed).toBe(true)
        expect(f.adapter.requests).toHaveLength(action === 'insert-remove' ? 0 : 1)
        expect(f.agent.session.snapshotEvents().filter(event => event.type === 'user/message').map(event => event.data.id))
          .toEqual(action === 'insert-remove' ? [] : [foreground.id])
        expect(f.agent.inbox.nextStep.map(message => message.id)).toEqual(ack.receipts.map(receipt => receipt.messageId))
        expect(f.agent.inbox.nextTurn).toHaveLength(0)
      } finally { dispose(); await f.close() }
    })
  }
}

for (const mutation of ['reverse', 'in-place', 'next-in-place', 'drop', 'reject', 'duplicate', 'replace', 'inject'] as const) {
  it(`retains ordered gated custody when pre-step attempts to ${mutation} selected input`, async () => {
    const f = await fixture()
    let injected: ReturnType<typeof createUserMessage> | undefined
    const dispose = f.ctx.on('agent/pre-step', async (payload, next) => {
      if (mutation === 'reject') return { kind: 'reject' as const }
      if (mutation === 'in-place') return { kind: 'enter' as const, messages: payload.messages.reverse() }
      const decision = await next()
      if (decision.kind === 'reject') return decision
      if (mutation === 'next-in-place') {
        decision.messages.reverse()
        return decision
      }
      const messages = [...decision.messages]
      if (mutation === 'reverse') messages.reverse()
      if (mutation === 'drop') messages.shift()
      if (mutation === 'duplicate') messages.push(messages[0]!)
      if (mutation === 'replace') messages[0] = { ...messages[0]!, content: [{ type: 'text', text: 'replaced' }] }
      if (mutation === 'inject') {
        injected = createUserMessage({ source: { kind: 'notification', origin: 'test:gated', form: 'notice', summary: 'late' },
          content: [{ type: 'text', text: 'late' }] })
        f.agent.inbox.notifications!.stageActivityGated!('next-step', [{
          message: injected, admission: { origin: 'test:gated', sequence: 'late', activityGated: true },
        }], { ...f.body.activityGuard, version: 1 })
        messages.push(injected)
      }
      return { ...decision, messages }
    })
    try {
      const ack = await (await f.post(f.body)).json() as CustodyAck
      await f.agent.whenIdle()
      expect(f.adapter.requests).toHaveLength(0)
      expect(f.agent.session.snapshotEvents().some(event => event.type === 'user/message')).toBe(false)
      expect(f.agent.inbox.nextStep.map(message => message.id))
        .toEqual([...ack.receipts.map(receipt => receipt.messageId), ...injected === undefined ? [] : [injected.id]])
      dispose()
      await f.stream.gesture()
      await f.agent.whenIdle()
      expect(f.adapter.requests).toHaveLength(1)
      expect(f.agent.inbox.nextStep).toHaveLength(0)
    } finally { dispose(); await f.close() }
  })
}

for (const interaction of ['leave', 'stop']) {
  it(`consumes same-socket ${interaction} while a gesture release flush awaits`, async () => {
    const f = await fixture()
    const reached = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    const ids = f.agent.inbox.notifications!.stageActivityGated!('next-step', f.body.items.map(item => ({
      message: createUserMessage({ source: { kind: 'notification', origin: 'test:gated', form: 'notice', summary: item.text },
        content: [{ type: 'text', text: item.text }] }),
      admission: { origin: 'test:gated', sequence: item.sequence, activityGated: true },
    })), { ...f.body.activityGuard, version: 1 }).map(receipt => receipt.messageId)
    const spy = vi.spyOn(f.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      reached.resolve(undefined)
      await release.promise
      return flush(session)
    })
    try {
      await f.stream.gesture()
      await reached.promise
      // The second frame must be consumed and acknowledged BEFORE releasing flush.
      // Awaiting native release in the stream reader deadlocks at this barrier.
      await f.stream.gesture(interaction)
      const cut = await f.read()
      if (interaction === 'leave') expect(cut.state).toBe('stale')
      release.resolve(undefined)
      await f.agent.whenIdle()
      expect(f.adapter.requests).toHaveLength(0)
      expect(f.agent.inbox.nextStep.map(message => message.id)).toEqual(ids)
      expect(f.agent.session.snapshotEvents().some(event => event.type === 'user/message')).toBe(false)
    } finally { release.resolve(undefined); spy.mockRestore(); await f.close() }
  })
}

it('keeps the fixed ten-item selection and late arrival ordered across canceled preparation', async () => {
  const f = await fixture()
  const reached = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const prepare = f.ctx.llm.prepareCall.bind(f.ctx.llm)
  const spy = vi.spyOn(f.ctx.llm, 'prepareCall').mockImplementationOnce(async (...args) => {
    const call = await prepare(...args)
    reached.resolve(undefined)
    await release.promise
    return call
  })
  try {
    const body = { ...f.body, items: Array.from({ length: 10 }, (_, i) => ({ sequence: String(i), text: `notice ${i}` })) }
    const ack = await (await f.post(body)).json() as CustodyAck
    await reached.promise
    const late = createUserMessage({ source: { kind: 'notification', origin: 'test:gated', form: 'notice', summary: 'late' },
      content: [{ type: 'text', text: 'late' }] })
    f.agent.inbox.notifications!.stageActivityGated!('next-step', [{
      message: late, admission: { origin: 'test:gated', sequence: 'late', activityGated: true },
    }], { ...f.body.activityGuard, version: 1 })
    // The in-flight selection has exactly ten ids; the eleventh is never runnable through it.
    expect(f.agent.inbox.notifications!.isHeld(late)).toBe(true)
    f.agent.cancel({ kind: 'user' })
    release.resolve(undefined)
    await f.agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(0)
    expect(f.agent.inbox.nextStep.map(m => m.id)).toEqual([...ack.receipts.map(r => r.messageId), late.id])
    f.agent.inbox.notifications!.resumeOperator!()
    await f.stream.gesture()
    await f.agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.agent.inbox.nextStep.map(m => m.id)).toEqual([late.id])
    const entered = f.agent.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => e.data.id)
    expect(entered).toEqual(ack.receipts.map(r => r.messageId))
    await f.read()
    f.agent.wakeInbox?.()
    await f.agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(1)
    await f.stream.gesture()
    await f.agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(2)
    expect(f.agent.inbox.nextStep).toHaveLength(0)
    expect(f.agent.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => e.data.id))
      .toEqual([...entered, late.id])
  } finally { release.resolve(undefined); spy.mockRestore(); await f.close() }
})

for (const boundary of ['staging', 'wake-status', 'claim', 'system-commit', 'user-commit', 'request-header', 'stream-start'] as const) {
  // Session.append forbids durable goal edits reentered from session/event.
  // Exercise those edits only at event boundaries that can actually commit them.
  const controls = boundary === 'wake-status' || boundary === 'claim' || boundary === 'stream-start'
    ? ['stop', 'focus-roundtrip', 'goal-edit'] as const : ['stop', 'focus-roundtrip'] as const
  for (const control of controls) {
    it(`rechecks synchronous ${boundary} observers: ${control}`, async () => {
      const f = await fixture()
      const goal = control === 'goal-edit' ? f.ctx.goals.create(f.agent, { objective: 'original goal' }) : undefined
      let changed = false
      const change = () => {
        if (changed) return
        changed = true
        if (goal !== undefined) f.ctx.goals.edit(f.agent, goal, { objective: 'changed goal' })
        else if (control === 'stop') f.agent.cancel({ kind: 'user' })
        else { f.agent.inbox.notifications!.setFocus(true); f.agent.inbox.notifications!.setFocus(false) }
      }
      const dispose = boundary === 'claim' ? f.ctx.on('agent/inbox/claimed', change)
        : boundary === 'wake-status' ? f.ctx.on('agent/status', ({ status }) => { if (status === 'running') change() })
          : boundary === 'stream-start' ? f.ctx.on('agent/assistant-stream', ({ frame }) => { if (frame.type === 'start') change() })
            : f.ctx.on('session/event', (session, event) => {
              if (session !== f.agent.session) return
              if (event.type === (boundary === 'staging' ? 'agent/notification/activity-gated'
                : boundary === 'system-commit' ? 'system/message' : boundary === 'user-commit' ? 'user/message' : 'request/header')) change()
            })
      try {
        const current = await f.read()
        const response = await f.post({ ...f.body, activityGuard: { ...f.body.activityGuard,
          controlRevision: current.controlRevision } })
        expect(response.status).toBe(200)
        const ack = await response.json() as CustodyAck
        expect(ack.delivery).not.toBe('delivered')
        await f.agent.whenIdle()
        expect(changed).toBe(true)
        expect(f.adapter.requests).toHaveLength(0)
        const accepted = boundary === 'request-header' || boundary === 'stream-start'
        const enteredCount = accepted ? ack.receipts.length : boundary === 'user-commit' ? 1 : 0
        expect(f.agent.inbox.nextStep.map(m => m.id)).toEqual(ack.receipts.slice(enteredCount).map(r => r.messageId))
        expect(f.agent.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => e.data.id))
          .toEqual(ack.receipts.slice(0, enteredCount).map(r => r.messageId))
      } finally { dispose(); await f.close() }
    })
  }
}

it('defers notification preparation without canceling or parking a racing foreground prompt', async () => {
  const f = await fixture()
  const reached = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const prepare = f.ctx.llm.prepareCall.bind(f.ctx.llm)
  const spy = vi.spyOn(f.ctx.llm, 'prepareCall').mockImplementationOnce(async (...args) => {
    const call = await prepare(...args)
    reached.resolve(undefined)
    await release.promise
    return call
  })
  try {
    const ack = await (await f.post(f.body)).json() as CustodyAck
    await reached.promise
    const foreground = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'foreground wins' }] })
    f.agent.followup(foreground)
    release.resolve(undefined)
    await f.agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.agent.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => e.data.id)).toEqual([foreground.id])
    expect(f.agent.inbox.nextStep.map(m => m.id)).toEqual(ack.receipts.map(r => r.messageId))
    expect(f.agent.inbox.nextTurn).toHaveLength(0)
  } finally { release.resolve(undefined); spy.mockRestore(); await f.close() }
})

type Fixture = Awaited<ReturnType<typeof fixture>>
const entryRaces = ['idle', 'transport-expiry', 'stop', 'focus', 'focus-roundtrip', 'maintenance', 'goal-paused', 'goal-disarmed', 'reconnect'] as const
async function holdAtEntry(f: Fixture, race: typeof entryRaces[number]) {
  if (race === 'idle') f.advance(300000)
  if (race === 'transport-expiry') f.advance(7200000)
  if (race === 'stop') f.agent.cancel({ kind: 'user' })
  if (race === 'focus') f.agent.inbox.notifications!.setFocus(true)
  if (race === 'focus-roundtrip') { f.agent.inbox.notifications!.setFocus(true); f.agent.inbox.notifications!.setFocus(false) }
  if (race === 'maintenance') {
    // Closing remains pending until this blocked driver drains; don't deadlock the test barrier.
    void f.ctx.hostMaintenance.receive('test:owner', { action: 'close', runId: 'entry-race' }).catch(() => {})
  }
  if (race === 'goal-paused' || race === 'goal-disarmed') {
    const goal = f.ctx.goals.create(f.agent, { objective: 'final-entry hold' })
    if (race === 'goal-paused') f.ctx.goals.pause(f.agent, goal)
    else f.ctx.goals.disarm(f.agent)
  }
  if (race === 'reconnect') {
    const closed = once(f.stream.socket, 'close')
    f.stream.socket.close()
    await closed
    await f.connect()
  }
}

for (const race of entryRaces) {
  it(`rechecks the native selection's own flush: ${race}`, async () => {
    const f = await fixture()
    const reached = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
    const spy = vi.spyOn(f.ctx.sessions, 'flush').mockImplementationOnce(flush)
      .mockImplementationOnce(async (session) => { reached.resolve(undefined); await release.promise; return flush(session) })
    let pending: Promise<Response> | undefined
    try {
      pending = f.post(f.body)
      await Promise.race([reached.promise, pending.then(() => { throw new Error('native selection flush not reached') })])
      await holdAtEntry(f, race)
      release.resolve(undefined)
      const ack = await (await pending).json() as CustodyAck
      expect(ack).toMatchObject({ accepted: true, delivery: 'held' })
      await f.agent.whenIdle()
      expect(f.adapter.requests).toHaveLength(0)
      expect(f.agent.session.snapshotEvents().some(e => e.type === 'user/message')).toBe(false)
      expect(f.agent.inbox.nextStep.map(m => m.id)).toEqual(ack.receipts.map(r => r.messageId))
    } finally { release.resolve(undefined); await pending?.catch(() => {}); spy.mockRestore(); await f.close() }
  })
}

for (const boundary of ['assembly', 'pre-step', 'prepare-call', 'stream-middleware'] as const) {
  for (const race of entryRaces) {
    it(`retains ordered custody with no forbidden model entry across ${boundary}: ${race}`, async () => {
      const f = await fixture()
      const reached = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      const barrier = async () => { reached.resolve(undefined); await release.promise }
      let restore: (() => void) | undefined
      if (boundary === 'assembly') {
        const assemble = f.ctx.systemPrompt.assemble.bind(f.ctx.systemPrompt)
        const spy = vi.spyOn(f.ctx.systemPrompt, 'assemble').mockImplementationOnce(async (...args) => {
          await barrier()
          return assemble(...args)
        })
        restore = () => { spy.mockRestore() }
      } else if (boundary === 'pre-step') {
        restore = f.ctx.on('agent/pre-step', async (_payload, next) => { await barrier(); return next() })
      } else if (boundary === 'stream-middleware') {
        restore = f.ctx.on('llm/stream', async function* (_request, next) {
          await barrier()
          yield* next()
        })
      } else {
        const prepare = f.ctx.llm.prepareCall.bind(f.ctx.llm)
        const spy = vi.spyOn(f.ctx.llm, 'prepareCall').mockImplementationOnce(async (...args) => {
          const call = await prepare(...args)
          await barrier()
          return call
        })
        restore = () => { spy.mockRestore() }
      }
      try {
        const response = await f.post(f.body)
        expect(response.status).toBe(200)
        const ack = await response.json() as CustodyAck
        expect(ack.accepted).toBe(true)
        expect(ack.delivery).not.toBe('delivered')
        await reached.promise
        await holdAtEntry(f, race)
        release.resolve(undefined)
        await f.agent.whenIdle()
        expect(f.adapter.requests).toHaveLength(0)
        // Stream middleware follows native user/message acceptance, but still
        // cannot dispatch a model after a hold. It never manufactures a delivery ACK.
        const accepted = f.agent.session.snapshotEvents().filter(e => e.type === 'user/message')
        expect(accepted.map(e => e.data.id)).toEqual(boundary === 'stream-middleware' ? ack.receipts.map(r => r.messageId) : [])
        expect(f.agent.inbox.nextStep.map(m => m.id)).toEqual(boundary === 'stream-middleware' ? [] : ack.receipts.map(r => r.messageId))
        expect(f.agent.inbox.nextStep.every(m => f.agent.inbox.notifications!.isHeld(m))).toBe(true)
        const before = f.agent.session.seq
        const retry = await f.post(f.body)
        expect(await retry.json()).toMatchObject({ accepted: true, delivery: 'held',
          receipts: ack.receipts.map(r => ({ ...r, duplicate: true })) })
        await f.read()
        f.agent.wakeInbox?.()
        await f.agent.whenIdle()
        expect(f.agent.session.seq).toBe(before)
        expect(f.adapter.requests).toHaveLength(0)
      } finally {
        release.resolve(undefined)
        restore?.()
        await f.close()
      }
    })
  }
}

it('fresh interaction releases retained custody once; read/retry and Focus Check never authorize it', async () => {
  const f = await fixture()
  const flush = f.ctx.sessions.flush.bind(f.ctx.sessions)
  const spy = vi.spyOn(f.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
    f.agent.inbox.notifications!.setFocus(true)
    return flush(session)
  })
  try {
    const ack = await (await f.post(f.body)).json() as CustodyAck
    expect(ack.delivery).toBe('held')
    spy.mockRestore()
    f.agent.inbox.notifications!.setFocus(false)
    expect(f.agent.inbox.notifications!.check('not-activity-release')).toEqual([])
    await f.read()
    await f.post(f.body)
    f.agent.wakeInbox?.()
    await f.agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(0)
    await f.stream.gesture()
    await f.agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(1)
    expect(f.agent.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => e.data.id))
      .toEqual(ack.receipts.map(r => r.messageId))
    await f.stream.gesture()
    await f.post(f.body)
    await f.agent.whenIdle()
    expect(f.adapter.requests).toHaveLength(1)
  } finally { spy.mockRestore(); await f.close() }
})
