/** Real Chromium DOM -> shipped GUI adapter -> authenticated mux -> native diagnostic owner. */
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { build } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { expect, it } from 'vitest'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '../../../packages/api/gateway/src/index.ts'
import * as Connection from '../../../packages/client/connection/src/index.ts'
import { provideBrowserCredentials } from '../../../packages/client/connection/tests/browser-credentials.ts'
import { MockAdapter } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'

it('records only current trusted visible GUI gestures with server epochs/time and never clears holds', async () => {
  const output = await build({
    configFile: false, root: fileURLToPath(new URL('../../..', import.meta.url)),
    plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
    esbuild: { jsx: 'automatic', jsxDev: false },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      write: false, minify: false,
      lib: { entry: fileURLToPath(new URL('../../../packages/client/ui-conversation/tests/browser/operator-activity.client.tsx', import.meta.url)), formats: ['iife'], name: 'ActivityFixture' },
    },
    logLevel: 'warn',
  })
  const bundle = Array.isArray(output) ? output[0] : output
  if (bundle === undefined || !('output' in bundle)) throw new Error('unexpected fixture build')
  const script = bundle.output.find(chunk => chunk.type === 'chunk')
  if (script?.type !== 'chunk') throw new Error('fixture bundle missing')
  const root = await mkdtemp(join(tmpdir(), 'dsh-gui-activity-'))
  const ctx = new Context()
  const headed = process.env.DSH_ACTIVITY_HEADED === '1'
  let browser: Browser | undefined
  try {
    browser = await chromium.launch({ headless: !headed })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('activity-browser'), { provider: 'mock', model: 'mock' })
    await ctx.agentLoop.create(SessionId('other-session'), { provider: 'mock', model: 'mock' })
    const bearer = 'test-only-gui-activity-read-1234567890'
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    provideBrowserCredentials(ctx)
    await ctx.plugin(Connection, { notificationProducers: [{
      origin: 'test:gui', bearerSha256: createHash('sha256').update(bearer).digest('hex'),
      sessionIds: [agent.id, 'other-session'], urgency: [], activityRead: true, activityGated: true,
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
    const read = async (sessionId = agent.id) => {
      const response = await fetch(base + '/api/notifications.admit', {
        method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, action: 'activity', sessionId }),
      })
      expect(response.status).toBe(200)
      return response.json()
    }
    const browserContext = await browser.newContext()
    const page = await browserContext.newPage()
    // Headed/Xvfb uses real focus. Playwright otherwise emulates every headless tab as focused.
    if (headed) {
      const cdp = await browserContext.newCDPSession(page)
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })
    }
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const frames: Array<{ endpoint?: string; type: string; value?: { interaction?: string } }> = []
    page.on('websocket', socket => socket.on('framesent', (frame) => {
      if (typeof frame.payload === 'string') frames.push(JSON.parse(frame.payload))
    }))
    await page.goto(ctx.connection.authenticatedUrl(base))
    const composer = page.locator('[data-composer-input]')
    await expect.poll(async () => ({ count: await composer.count(), errors })).toEqual({ count: 1, errors: [] })
    await expect.poll(() => frames.filter(frame => frame.endpoint === 'session.operatorActivity').length).toBe(1)
    // Host opening carries no gesture; inspect traffic and browser focus do not qualify.
    expect(await read()).toMatchObject({ state: 'unknown', lastActivityAt: null, eligible: false })
    const before = Date.now()
    await composer.press('a')
    await expect.poll(async () => (await read()).state).toBe('active')
    const active = await read()
    expect(active.lastActivityAt).toBeGreaterThanOrEqual(before)
    expect(active.lastActivityAt).toBeLessThanOrEqual(Date.now())
    expect(active.binding.bindingEpoch).toEqual(expect.any(String))
    expect(active.hostEpoch).toEqual(expect.any(String))
    expect(frames.some(frame => frame.value?.interaction === 'input')).toBe(true)
    // Only Pong/inspect during this interval: time and revision remain unchanged.
    await page.waitForTimeout(1100)
    expect(await read()).toMatchObject({ lastActivityAt: active.lastActivityAt, activityRevision: active.activityRevision })
    await page.evaluate(() => {
      const input = document.querySelector('[data-composer-input]')!
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'synthetic' }))
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'x' }))
      input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(await read()).toMatchObject({ lastActivityAt: active.lastActivityAt, activityRevision: active.activityRevision })
    // The fixture invokes generic composer APIs; they keep their ordinary behavior, not GUI qualification.
    await page.evaluate("activityFixture.draft('programmatic'); activityFixture.programmaticSubmit()")
    expect(await read()).toMatchObject({ lastActivityAt: active.lastActivityAt, activityRevision: active.activityRevision })
    await page.evaluate("activityFixture.draft('human')")
    await composer.press('Enter')
    await expect.poll(() => frames.filter(frame => frame.value?.interaction === 'submit').length).toBe(1)
    await page.evaluate("activityFixture.draft('clicked')")
    await page.getByRole('button', { name: 'input.send', exact: true }).click()
    await expect.poll(() => frames.filter(frame => frame.value?.interaction === 'submit').length).toBe(2)
    const submitted = await read()
    await page.evaluate('activityFixture.replay()')
    expect(await read()).toMatchObject({ lastActivityAt: submitted.lastActivityAt, activityRevision: submitted.activityRevision })
    await page.getByRole('button', { name: 'Focus off', exact: true }).click()
    await expect.poll(async () => (await read()).focus).toBe('enabled')
    expect(frames.some(frame => frame.value?.interaction === 'focus-control')).toBe(true)
    await page.evaluate('activityFixture.running()')
    await page.getByRole('button', { name: 'input.stop', exact: true }).click()
    await expect.poll(() => frames.filter(frame => frame.value?.interaction === 'stop').length).toBe(1)
    expect(await read()).toMatchObject({ focus: 'enabled', eligible: false, stop: 'unknown' })
    const durableSeq = agent.session.seq
    const gated = await fetch(base + '/api/notifications.admit', {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: agent.id, items: [{ sequence: 'still-held', text: 'never enter' }] }),
    })
    expect(gated.status).toBe(409)
    expect(agent.session.seq).toBe(durableSeq)
    expect(adapter.requests).toHaveLength(0)
    // A genuine event reported with a different session id cannot refresh that session.
    await page.evaluate("document.addEventListener('keydown', event => activityFixture.wrongSession(event), { once: true })")
    await composer.press('x')
    expect((await read(SessionId('other-session'))).lastActivityAt).toBeNull()
    const beforeHidden = await read()
    await page.locator('[data-conversation-session]').evaluate((element) => { (element as HTMLElement).hidden = true })
    await expect.poll(async () => (await read()).state).not.toBe('active')
    expect((await read()).lastActivityAt).toBe(beforeHidden.lastActivityAt)
    // Trusted browser key dispatch cannot qualify the hidden occurrence either.
    await page.keyboard.press('h')
    expect((await read()).lastActivityAt).toBe(beforeHidden.lastActivityAt)
    await page.locator('[data-conversation-session]').evaluate((element) => { (element as HTMLElement).hidden = false })
    await composer.focus()
    await composer.press('v')
    await expect.poll(async () => (await read()).state).toBe('active')
    const beforeBlur = await read()
    const background = await page.context().newPage()
    await background.goto('about:blank')
    await background.bringToFront()
    if (!headed) await page.evaluate(() => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false })
      window.dispatchEvent(new Event('blur'))
    })
    await expect.poll(async () => (await read()).state).not.toBe('active')
    await page.evaluate("activityFixture.draft('background'); activityFixture.programmaticSubmit(); activityFixture.replay()")
    expect((await read()).lastActivityAt).toBe(beforeBlur.lastActivityAt)
    await background.close()
    await page.bringToFront()
    if (!headed) await page.evaluate(() => {
      Reflect.deleteProperty(document, 'hasFocus')
      window.dispatchEvent(new Event('focus'))
    })
    await composer.focus()
    await composer.press('b')
    await expect.poll(async () => (await read()).state).toBe('active')
    const prior = await read()
    await page.evaluate('activityFixture.reconnect()')
    await expect.poll(() => frames.filter(frame => frame.endpoint === 'session.operatorActivity').length).toBeGreaterThanOrEqual(2)
    await expect.poll(async () => (await read()).state).not.toBe('active')
    expect((await read()).lastActivityAt).toBe(prior.lastActivityAt)
    await composer.press('z')
    await expect.poll(async () => (await read()).state).toBe('active')
    expect((await read()).binding.bindingEpoch).not.toBe(prior.binding.bindingEpoch)
    const submitCount = frames.filter(frame => frame.value?.interaction === 'submit').length
    await page.evaluate("activityFixture.hold(); activityFixture.draft('deferred submit')")
    await composer.press('Enter')
    await expect.poll(() => frames.filter(frame => frame.value?.interaction === 'submit').length).toBe(submitCount + 1)
    await page.evaluate("activityFixture.switch('other-session'); activityFixture.release()")
    await expect.poll(async () => (await read()).state).not.toBe('active')
    expect((await read(SessionId('other-session'))).lastActivityAt).toBeNull()
    expect(errors).toEqual([])
  } finally {
    // Each owner is awaited, even when launch or an earlier cleanup fails.
    try {
      await browser?.close()
    } finally {
      try {
        await ctx.fiber.dispose()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
}, 60000)
