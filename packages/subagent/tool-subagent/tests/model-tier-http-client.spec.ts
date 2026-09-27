import { describe, expect, it, vi } from 'vitest'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import { createModelTierHttpClient } from '../src/model-tier-http-client.ts'

const testSignal = new AbortController().signal

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('createModelTierHttpClient', () => {
  it('returns undefined without calling fetch when no bearer resolves', async () => {
    const fetchImpl = vi.fn()
    const client = createModelTierHttpClient({
      baseURL: 'https://forage.ink',
      resolveBearer: async () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(client.resolveClass('subagent-basic', testSignal)).resolves.toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('posts the class resolution request with the bearer and splits the returned model id', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://forage.ink/api/llm/decisions')
      expect(init.method).toBe('POST')
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer vk_test123')
      expect(JSON.parse(init.body as string)).toEqual({
        domain: 'llm_model_class',
        resolve: 'class:subagent-capable',
      })
      return jsonResponse(200, { models: ['anthropic/claude-opus-5-5'] })
    })
    const client = createModelTierHttpClient({
      baseURL: 'https://forage.ink',
      resolveBearer: async () => 'vk_test123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(client.resolveClass('subagent-capable', testSignal)).resolves.toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
    })
  })

  it('returns undefined on a non-ok response other than 403 (read miss, not a throw)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: 'internal' }))
    const client = createModelTierHttpClient({
      baseURL: 'https://forage.ink',
      resolveBearer: async () => 'vk_test123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(client.resolveClass('subagent-mid', testSignal)).resolves.toBeUndefined()
  })

  it('returns undefined when the response carries no models array', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}))
    const client = createModelTierHttpClient({
      baseURL: 'https://forage.ink',
      resolveBearer: async () => 'vk_test123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(client.resolveClass('subagent-mid', testSignal)).resolves.toBeUndefined()
  })

  it('throws TIER_ACCESS_DENIED on a 403 instead of returning undefined', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, { error: 'class_access_denied' }))
    const client = createModelTierHttpClient({
      baseURL: 'https://forage.ink',
      resolveBearer: async () => 'vk_test123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const error = await client.resolveClass('subagent-capable', testSignal).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SubagentError)
    expect((error as SubagentError).code).toBe('TIER_ACCESS_DENIED')
  })

  it('returns undefined (not a throw) when fetch itself rejects (network failure)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET') })
    const client = createModelTierHttpClient({
      baseURL: 'https://forage.ink',
      resolveBearer: async () => 'vk_test123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(client.resolveClass('subagent-basic', testSignal)).resolves.toBeUndefined()
  })

  it('aborts the request once the per-call timeout elapses', async () => {
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init.signal as AbortSignal
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const client = createModelTierHttpClient({
      baseURL: 'https://forage.ink',
      resolveBearer: async () => 'vk_test123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 10,
    })
    await expect(client.resolveClass('subagent-basic', testSignal)).resolves.toBeUndefined()
  })

  it('propagates a caller-signal abort raised WHILE the request is in flight into the underlying fetch', async () => {
    const controller = new AbortController()
    let started: (() => void) | undefined
    const startedGate = new Promise<void>((resolve) => { started = resolve })
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init.signal as AbortSignal
      signal.addEventListener('abort', () => reject(new Error('aborted')))
      started?.()
    }))
    const client = createModelTierHttpClient({
      baseURL: 'https://forage.ink',
      resolveBearer: async () => 'vk_test123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const pending = client.resolveClass('subagent-basic', controller.signal)
    await startedGate
    controller.abort()
    await expect(pending).resolves.toBeUndefined()
  })

  it('propagates a caller signal that is ALREADY aborted before the request starts (resolveBearer race)', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      const signal = init.signal as AbortSignal
      if (signal.aborted) { reject(new Error('aborted')); return }
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const client = createModelTierHttpClient({
      baseURL: 'https://forage.ink',
      // resolveBearer is async, so by the time resolveClass reaches the abort
      // check, the caller's signal is already aborted — the listener-only
      // path would never fire for an event that already happened.
      resolveBearer: async () => 'vk_test123',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(client.resolveClass('subagent-basic', controller.signal)).resolves.toBeUndefined()
  })
})
