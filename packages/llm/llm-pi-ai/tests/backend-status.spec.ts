/** backendStatus(): provider-terminal settlement evidence for the shipped pi-ai adapter. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { backendStatusJoined, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(async () => {
  vi.unstubAllEnvs()
  await closeMockServers()
})

function adapterOf(baseURL: string): PiAiAdapter {
  vi.stubEnv('PI_TEST_KEY', 'test-key')
  return new PiAiAdapter({
    profiles: () => resolveProfiles({ deepseek: { apiKeyEnv: 'PI_TEST_KEY', baseURL } }),
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
  })
}
const request = (overrides: Partial<GenerateOptions> = {}): GenerateOptions => ({
  provider: 'deepseek', model: 'deepseek-flash',
  messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })], ...overrides,
})
async function drain(iterator: AsyncIterator<StreamChunk>) {
  const seen: StreamChunk[] = []
  while (true) {
    const next = await iterator.next()
    if (next.done) return seen
    seen.push(next.value)
  }
}

describe('pi-ai backendStatus', () => {
  it('in-flight => busy, provider stop => joined completed terminal', async () => {
    const server = await mockServer([{ events: textEvents, delayMs: 150 }])
    const llm = adapterOf(server.url)
    expect(backendStatusJoined(llm.backendStatus())).toBe(true)
    const iterator = llm.stream(request({ sessionId: 'session-p' as never }))[Symbol.asyncIterator]()
    await iterator.next()
    const busy = llm.backendStatus()
    expect(busy).toMatchObject({ state: 'UNKNOWN', turns: [{ threadId: 'session-p', turnId: 'call-1', state: 'UNKNOWN', pendingRequests: ['request-1'] }] })
    expect(backendStatusJoined(busy)).toBe(false)
    const rest = await drain(iterator)
    expect(rest.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const settled = llm.backendStatus()
    expect(settled.turns[0]).toMatchObject({ state: 'JOINED', pendingRequests: [], terminal: { threadId: 'session-p', turnId: 'call-1', status: 'completed' } })
    expect(backendStatusJoined(settled)).toBe(true)
  })

  it('a provider HTTP error answer is a joined failed terminal', async () => {
    const server = await mockServer([{ status: 400, body: '{"error":{"message":"invalid request"}}' }])
    const llm = adapterOf(server.url)
    const chunks = await drain(llm.stream(request())[Symbol.asyncIterator]())
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST' } } })
    const status = llm.backendStatus()
    expect(status.turns[0]).toMatchObject({ state: 'JOINED', terminal: { status: 'failed' } })
    expect(backendStatusJoined(status)).toBe(true)
  })

  it('caller abort mid-stream stays unknown (cancellation is not settlement)', async () => {
    const server = await mockServer([{ events: textEvents, delayMs: 200 }])
    const llm = adapterOf(server.url)
    const abort = new AbortController()
    const iterator = llm.stream(request({ signal: abort.signal }))[Symbol.asyncIterator]()
    await iterator.next()
    abort.abort()
    await drain(iterator).catch(() => undefined)
    const status = llm.backendStatus()
    expect(status).toMatchObject({ state: 'UNKNOWN', turns: [{ state: 'UNKNOWN', pendingRequests: ['request-1'] }] })
    expect(status.turns[0]!.terminal).toBeUndefined()
  })

  it('transport truncation before the provider terminal stays unknown', async () => {
    const server = await mockServer([{ events: textEvents.slice(0, 2) }])
    const llm = adapterOf(server.url)
    const chunks = await drain(llm.stream(request())[Symbol.asyncIterator]()).catch(() => [])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(llm.backendStatus()).toMatchObject({ state: 'UNKNOWN', turns: [{ state: 'UNKNOWN' }] })
  })

  it('drives LlmRuntime.backendCoverage: unknown while in flight, joined only after real settlement', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    try {
      const server = await mockServer([{ events: textEvents, delayMs: 150 }])
      const llm = adapterOf(server.url)
      ctx.llm.registerAdapter(['deepseek'], llm)
      const iterator = llm.stream(request())[Symbol.asyncIterator]()
      await iterator.next()
      expect(ctx.llm.backendCoverage()).toMatchObject({ state: 'UNKNOWN', participants: [{ reason: 'backend has unjoined or ambiguous work' }] })
      await drain(iterator)
      expect(ctx.llm.backendCoverage().state).toBe('JOINED')
    } finally { await ctx.fiber.dispose() }
  })
})
