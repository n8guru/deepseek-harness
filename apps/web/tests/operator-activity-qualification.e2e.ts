/** Shipped trusted GUI activity drives real HTTP custody and native model entry in isolated state. */
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { build } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { expect, it, vi } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import GoalService from '@deepseek-ai/dsh-goal'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import HostMaintenance from '../../../packages/core/agent-loop/src/maintenance.ts'
import Gateway from '../../../packages/api/gateway/src/index.ts'
import * as Connection from '../../../packages/client/connection/src/index.ts'
import type { ActivitySnapshot } from '../../../packages/client/connection/src/rpc.ts'
import { provideBrowserCredentials } from '../../../packages/client/connection/tests/browser-credentials.ts'
import { MockAdapter, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'

type CustodyAck = { accepted: true; delivery: 'held' | 'eligible'; receipts: { sequence: string; messageId: string; duplicate: boolean }[] }

it('releases trusted GUI custody once and holds a real Focus race across flush', async () => {
  const output = await build({
    configFile: false, root: fileURLToPath(new URL('../../..', import.meta.url)),
    plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
    esbuild: { jsx: 'automatic', jsxDev: false },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: { write: false, minify: false, lib: {
      entry: fileURLToPath(new URL('../../../packages/client/ui-conversation/tests/browser/operator-activity.client.tsx', import.meta.url)),
      formats: ['iife'], name: 'ActivityFixture',
    } },
    logLevel: 'warn',
  })
  const bundle = Array.isArray(output) ? output[0] : output
  if (bundle === undefined || !('output' in bundle)) throw new Error('unexpected fixture build')
  const script = bundle.output.find(chunk => chunk.type === 'chunk')
  if (script?.type !== 'chunk') throw new Error('fixture bundle missing')
  const root = await mkdtemp(join(tmpdir(), 'dsh-activity-qualification-'))
  const ctx = new Context()
  let browser: Browser | undefined
  const release = Promise.withResolvers<undefined>()
  let pending: Promise<Response> | undefined
  try {
    browser = await chromium.launch({ headless: process.env.DSH_ACTIVITY_HEADED !== '1' })
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
    const adapter = new MockAdapter(Array.from({ length: 4 }, () => textResponse('noted')))
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('activity-browser'), { provider: 'mock', model: 'mock' })
    const bearer = 'test-only-activity-qualification-1234567890'
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    provideBrowserCredentials(ctx)
    await ctx.plugin(Connection, { notificationProducers: [{
      origin: 'test:qualification', bearerSha256: createHash('sha256').update(bearer).digest('hex'),
      sessionIds: [agent.id], urgency: [], activityRead: true, activityGated: true,
    }] })
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(Gateway, { websocketHeartbeatIntervalMs: 500 })
    ctx.webServer.register({ kind: 'exact', path: '/', handler: (req, res) => {
      if (!ctx.connection.authorizeIndex(req, res)) { res.writeHead(401); res.end(); return }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body><script src="/activity-fixture.js"></script></body></html>')
    } })
    ctx.webServer.register({ kind: 'exact', path: '/activity-fixture.js', handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(script.code)
    } })
    const base = `http://127.0.0.1:${ctx.webServer.port}`
    const post = (body: object, token = bearer) => fetch(base + '/api/notifications.admit', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const read = async (): Promise<ActivitySnapshot> => {
      const response = await post({ version: 1, action: 'activity', sessionId: agent.id })
      expect(response.status).toBe(200)
      return response.json() as Promise<ActivitySnapshot>
    }
    const guarded = (snapshot: ActivitySnapshot, sequence: string) => ({
      sessionId: agent.id,
      activityGuard: { version: 1, hostEpoch: snapshot.hostEpoch,
        bindingEpoch: snapshot.binding!.bindingEpoch, activityRevision: snapshot.activityRevision,
        controlRevision: snapshot.controlRevision },
      items: [{ sequence, text: sequence + ' evidence' }],
    })
    const page = await browser.newPage()
    if (process.env.DSH_ACTIVITY_HEADED === '1') {
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    }
    const errors: string[] = []
    let bindingReady = false
    page.on('websocket', socket => socket.on('framereceived', (frame) => {
      if (typeof frame.payload !== 'string') return
      const message = JSON.parse(frame.payload) as { value?: { bindingEpoch?: string } }
      if (typeof message.value?.bindingEpoch === 'string') bindingReady = true
    }))
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(ctx.connection.authenticatedUrl(base))
    const composer = page.locator('[data-composer-input]')
    await expect.poll(() => composer.count()).toBe(1)
    await expect.poll(() => bindingReady).toBe(true)
    expect((await read()).eligible).toBe(false)
    await composer.press('a')
    await expect.poll(async () => (await read()).eligible).toBe(true)
    expect(adapter.requests).toHaveLength(0)
    const active = await read()
    const first = guarded(active, 'first')
    const before = agent.session.seq
    expect((await post(first, 'wrong-bearer')).status).toBe(403)
    expect((await post({ ...first, activityGuard: { ...first.activityGuard, bindingEpoch: 'forged' } })).status).toBe(409)
    expect(agent.session.seq).toBe(before)
    expect(adapter.requests).toHaveLength(0)
    const accepted = await post(first)
    expect(accepted.status).toBe(200)
    const receipt = await accepted.json() as CustodyAck
    expect(receipt).toMatchObject({ accepted: true, receipts: [{ sequence: 'first', duplicate: false }] })
    const firstReceipt = receipt.receipts[0]
    if (firstReceipt === undefined) throw new Error('first receipt missing')
    expect(['held', 'eligible']).toContain(receipt.delivery)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const acceptedIds = () => agent.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => e.data.id)
    expect(acceptedIds()).toEqual(receipt.receipts.map((r: { messageId: string }) => r.messageId))
    const replay = await post(first)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ receipts: [{ ...receipt.receipts[0], duplicate: true }] })
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)

    const second = guarded(await read(), 'second')
    const reached = Promise.withResolvers<undefined>()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    const spy = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      reached.resolve(undefined)
      await release.promise
      return flush(session)
    })
    try {
      pending = post(second)
      await Promise.race([reached.promise, pending.then(() => { throw new Error('admission missed flush barrier') })])
      await page.getByRole('button', { name: 'Focus off', exact: true }).click()
      await expect.poll(async () => (await read()).focus).toBe('enabled')
      release.resolve(undefined)
      const held = await pending
      expect(held.status).toBe(200)
      const heldReceipt = await held.json() as CustodyAck
      expect(heldReceipt).toMatchObject({ accepted: true, delivery: 'held', receipts: [{ sequence: 'second' }] })
      const secondReceipt = heldReceipt.receipts[0]
      if (secondReceipt === undefined) throw new Error('second receipt missing')
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(1)
      expect(acceptedIds()).not.toContain(secondReceipt.messageId)
      const readOnly = await read()
      expect(readOnly.eligible).toBe(false)
      expect((await post(second)).status).toBe(200)
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(1)
      await page.getByRole('button', { name: 'Focus on', exact: true }).click()
      await expect.poll(async () => (await read()).focus).toBe('disabled')
      // Disabling the busy Focus button blurs it and withdraws that GUI binding.
      // Clearing Focus cannot bypass stale activity; a fresh bound gesture is required.
      expect(await read()).toMatchObject({ state: 'stale', eligible: false })
      expect(adapter.requests).toHaveLength(1)
      bindingReady = false
      await composer.focus()
      await expect.poll(() => bindingReady).toBe(true)
      await composer.press('b')
      await expect.poll(() => adapter.requests.length).toBe(2)
      await agent.whenIdle()
      expect(acceptedIds()).toEqual([firstReceipt.messageId, secondReceipt.messageId])
      expect((await post(second)).status).toBe(200)
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(2)
      expect(errors).toEqual([])
    } finally {
      release.resolve(undefined)
      await pending?.catch(() => undefined)
      spy.mockRestore()
    }
  } finally {
    release.resolve(undefined)
    await pending?.catch(() => undefined)
    try { await browser?.close() } finally {
      try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
    }
  }
})
