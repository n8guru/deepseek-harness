/** Native admission only: real authenticated transport and JSONL, no model-entry authority. */
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
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '../../../api/gateway/src/index.ts'
import { expect, it, vi } from 'vitest'
import * as Connection from '../src/index.ts'
import type { ActivitySnapshot } from '../src/rpc.ts'

type CustodyAck = { accepted: true; delivery: 'held'; activity: ActivitySnapshot; receipts: { sequence: string; messageId: string; duplicate: boolean }[] }
import { provideBrowserCredentials } from './browser-credentials.ts'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function fixture() {
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
    const adapter = new MockAdapter([])
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

it('requires a current exact guard and returns only ordered durable held custody; idle replay adds nothing', async () => {
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
    expect(receipt).toMatchObject({ accepted: true, delivery: 'held', origin: 'test:gated',
      receipts: [{ sequence: 'first', duplicate: false }, { sequence: 'second', duplicate: false }] })
    expect(receipt.receipts.map((r: { messageId: string }) => r.messageId)).toEqual(f.agent.inbox.nextStep.map(m => m.id))
    expect(f.agent.inbox.nextStep.every(m => f.agent.inbox.notifications!.isHeld(m))).toBe(true)
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
    expect(f.adapter.requests).toHaveLength(0)
    expect(f.agent.session.snapshotEvents().some(e => e.type === 'user/message')).toBe(false)
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
