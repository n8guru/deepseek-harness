/** Keyless assembled native HTTP admission with actual durable JSONL receipts. */
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
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
    const maintenance = (body: unknown) => post('/api/maintenance.receive', body, { authorization: `Bearer ${bearer}` })
    expect((await post('/api/maintenance.receive', { action: 'close', runId: 'http-run' }, { cookie })).status).toBe(403)
    const closed = await maintenance({ action: 'close', runId: 'http-run' })
    expect(closed.status).toBe(200)
    expect(await closed.json()).toMatchObject({ owner: 'test:caller', runId: 'http-run', phase: 'closed' })
    expect(() => agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'blocked new work' }] }))).toThrow('admission closed')
    const delivery = { action: 'deliver-receipts', runId: 'http-run', items: [{ sequence: 'typed-supervisor', kind: 'supervisor', payload: 'trusted caller checkpoint', target: { kind: 'agent', sessionId: agent.id } }] }
    expect((await post('/api/maintenance.receive', delivery, { cookie })).status).toBe(403)
    const receiveTrace = vi.spyOn(ctx.hostMaintenance, 'receive')
    const delivered = await Promise.all([0, 1].map(() => maintenance(delivery)))
    const receiverErrors = await Promise.all(receiveTrace.mock.results.map(result => Promise.resolve(result.value).then(() => undefined, error => String(error))))
    receiveTrace.mockRestore()
    expect({ statuses: delivered.map(response => response.status), receiverErrors }).toEqual({ statuses: [200, 200], receiverErrors: [undefined, undefined] })
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
    expect(adapter.requests).toHaveLength(2)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
