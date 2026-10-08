/** backendStatus(): provider-terminal settlement evidence for the shipped Messages adapter (api-key and account routes). */
import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { backendStatusJoined } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { adapter, end, options, server, sse, start, textEvents } from './helpers.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
async function endpoint(reply: (response: ServerResponse, count: number) => void) {
  const instance = await server(reply)
  cleanup.push(() => instance.close())
  return instance
}
/** Send everything up to (not including) message_stop, then hold: the provider is still working (generation or server-side tools). */
function held() {
  let response: ServerResponse | undefined
  const ready = Promise.withResolvers<undefined>()
  const reply = (res: ServerResponse) => {
    response = res
    res.write(sse([start, textEvents[1]!, textEvents[2]!]))
    ready.resolve(undefined)
  }
  return { reply, ready: ready.promise,
    finish: () => { response!.end(sse([textEvents[3]!, ...end()])) }, drop: () => { response!.destroy() } }
}
async function drain(iterator: AsyncIterator<StreamChunk>) {
  const seen: StreamChunk[] = []
  while (true) {
    const next = await iterator.next()
    if (next.done) return seen
    seen.push(next.value)
  }
}

describe('DeepSeek Messages backendStatus', () => {
  it('reports no work (joined, empty) before any call', () => {
    const status = adapter().backendStatus()
    expect(status).toEqual({ state: 'JOINED', turns: [], startingTurns: 0, uncertainStarts: 0, unattributedEvents: 0 })
    expect(backendStatusJoined(status)).toBe(true)
  })

  it('in-flight => busy until the provider message_stop, then joined terminal completed', async () => {
    const hold = held()
    const http = await endpoint(hold.reply)
    const llm = adapter({ baseURL: http.url })
    const iterator = llm.stream(options({ sessionId: 'session-a' as never }))[Symbol.asyncIterator]()
    const first = iterator.next()
    await hold.ready
    await first
    const busy = llm.backendStatus()
    expect(busy.state).toBe('UNKNOWN')
    expect(busy.turns).toEqual([{ threadId: 'session-a', turnId: 'call-1', state: 'UNKNOWN', pendingRequests: ['request-1'] }])
    expect(backendStatusJoined(busy)).toBe(false)
    hold.finish()
    const rest = await drain(iterator)
    expect(rest.at(-1)?.type).toBe('finish')
    const settled = llm.backendStatus()
    expect(settled.turns[0]).toEqual({ threadId: 'session-a', turnId: 'call-1', state: 'JOINED', pendingRequests: [],
      terminal: { threadId: 'session-a', turnId: 'call-1', status: 'completed' } })
    expect(backendStatusJoined(settled)).toBe(true)
  })

  it('a fully read provider error response is a joined failed terminal', async () => {
    const http = await endpoint((response) => {
      response.statusCode = 400
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } }))
    })
    const llm = adapter({ baseURL: http.url })
    await expect(drain(llm.stream(options())[Symbol.asyncIterator]())).rejects.toThrow()
    const status = llm.backendStatus()
    expect(status.turns).toEqual([{ threadId: 'unattributed-calls', turnId: 'call-1', state: 'JOINED', pendingRequests: [],
      terminal: { threadId: 'unattributed-calls', turnId: 'call-1', status: 'failed' } }])
    expect(backendStatusJoined(status)).toBe(true)
  })

  it('caller abort after dispatch is not settlement: stays unknown (never idle)', async () => {
    const hold = held()
    const http = await endpoint(hold.reply)
    const llm = adapter({ baseURL: http.url })
    const abort = new AbortController()
    const iterator = llm.stream(options({ signal: abort.signal }))[Symbol.asyncIterator]()
    const first = iterator.next()
    await hold.ready
    await first
    abort.abort()
    await expect(drain(iterator)).rejects.toThrow()
    const status = llm.backendStatus()
    expect(status.state).toBe('UNKNOWN')
    expect(status.turns[0]).toMatchObject({ state: 'UNKNOWN', pendingRequests: ['request-1'] })
    expect(status.turns[0]!.terminal).toBeUndefined()
    expect(backendStatusJoined(status)).toBe(false)
  })

  it('transport error before the provider terminal stays unknown', async () => {
    const hold = held()
    const http = await endpoint(hold.reply)
    const llm = adapter({ baseURL: http.url })
    const iterator = llm.stream(options())[Symbol.asyncIterator]()
    const first = iterator.next()
    await hold.ready
    await first
    hold.drop()
    await expect(drain(iterator)).rejects.toThrow()
    expect(llm.backendStatus()).toMatchObject({ state: 'UNKNOWN', turns: [{ state: 'UNKNOWN', pendingRequests: ['request-1'] }] })
  })

  it('a consumer that stops reading before message_stop leaves the call unknown', async () => {
    const hold = held()
    const http = await endpoint(hold.reply)
    const llm = adapter({ baseURL: http.url })
    const iterator = llm.stream(options())[Symbol.asyncIterator]()
    const first = iterator.next()
    await hold.ready
    await first
    await iterator.return!(undefined)
    expect(llm.backendStatus().state).toBe('UNKNOWN')
  })

  it('counts a starting call, and drops it without a turn when nothing reached the provider', async () => {
    const auth = Promise.withResolvers<{ headers: Record<string, string> }>()
    const llm = adapter({ baseURL: 'http://127.0.0.1:9/anthropic' }, { resolveAuth: () => auth.promise })
    const pending = drain(llm.stream(options())[Symbol.asyncIterator]())
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(llm.backendStatus()).toMatchObject({ state: 'UNKNOWN', startingTurns: 1, turns: [] })
    auth.reject(new Error('credential unavailable'))
    await expect(pending).rejects.toThrow()
    expect(llm.backendStatus()).toEqual({ state: 'JOINED', turns: [], startingTurns: 0, uncertainStarts: 0, unattributedEvents: 0 })
  })

  it('drives LlmRuntime.backendCoverage: busy while in flight, joined only after real settlement', async () => {
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    await ctx.plugin(LlmRuntime)
    const hold = held()
    const http = await endpoint(hold.reply)
    const llm = adapter({ baseURL: http.url })
    ctx.llm.registerAdapter(['deepseek-official'], llm)
    expect(ctx.llm.backendCoverage().state).toBe('JOINED')
    const iterator = llm.stream(options())[Symbol.asyncIterator]()
    const first = iterator.next()
    await hold.ready
    await first
    expect(ctx.llm.backendCoverage()).toMatchObject({ state: 'UNKNOWN', participants: [{ reason: 'backend has unjoined or ambiguous work' }] })
    hold.finish()
    await drain(iterator)
    expect(ctx.llm.backendCoverage().state).toBe('JOINED')
  })
})
