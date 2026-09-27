import { describe, expect, it, vi } from 'vitest'
import { SubagentError } from '../src/error.ts'
import {
  assertValidModelSelection,
  DEFAULT_MODEL_TIER_CLASS_NAMES,
  isModelTier,
  MODEL_TIERS,
  ModelTierResolver,
  resolveModelSelection,
} from '../src/model-tier.ts'
import type { ModelTierRegistryClient, ResolvedTierRoute } from '../src/model-tier.ts'

const testSignal = new AbortController().signal

function fakeClient(
  resolve: (className: string) => Promise<ResolvedTierRoute | undefined> | ResolvedTierRoute | undefined,
): ModelTierRegistryClient {
  return { resolveClass: async (className: string) => resolve(className) }
}

describe('MODEL_TIERS / isModelTier', () => {
  it('names exactly basic, mid, and capable', () => {
    expect(MODEL_TIERS).toEqual(['basic', 'mid', 'capable'])
  })

  it('accepts only the three named tiers', () => {
    expect(isModelTier('basic')).toBe(true)
    expect(isModelTier('mid')).toBe(true)
    expect(isModelTier('capable')).toBe(true)
    expect(isModelTier('opus')).toBe(false)
    expect(isModelTier(undefined)).toBe(false)
    expect(isModelTier(42)).toBe(false)
  })
})

describe('DEFAULT_MODEL_TIER_CLASS_NAMES', () => {
  it('names one registry class per tier, not a model literal', () => {
    expect(DEFAULT_MODEL_TIER_CLASS_NAMES).toEqual({
      basic: 'subagent-basic',
      mid: 'subagent-mid',
      capable: 'subagent-capable',
    })
  })
})

describe('ModelTierResolver', () => {
  it('resolves basic to whatever the registry currently serves for the basic class', async () => {
    const client = fakeClient(className =>
      className === 'subagent-basic' ? { provider: 'anthropic', model: 'claude-sonnet-5' } : undefined)
    const resolver = new ModelTierResolver({ client })
    await expect(resolver.resolve('basic', testSignal)).resolves.toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    })
  })

  it('resolves mid to the mid class independently of basic', async () => {
    const client = fakeClient(className =>
      className === 'subagent-mid' ? { provider: 'openai-codex', model: 'gpt-6-sol' } : undefined)
    const resolver = new ModelTierResolver({ client })
    await expect(resolver.resolve('mid', testSignal)).resolves.toEqual({
      provider: 'openai-codex',
      model: 'gpt-6-sol',
    })
  })

  it('resolves capable to the capable class independently of the other tiers', async () => {
    const client = fakeClient(className =>
      className === 'subagent-capable' ? { provider: 'anthropic', model: 'claude-opus-5-5' } : undefined)
    const resolver = new ModelTierResolver({ client })
    await expect(resolver.resolve('capable', testSignal)).resolves.toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
    })
  })

  it('never invents a model the registry did not declare for a different tier', async () => {
    // Only "capable" resolves; "basic" must fail closed rather than silently
    // borrow the capable route or any other ambient default.
    const client = fakeClient(className =>
      className === 'subagent-capable' ? { provider: 'anthropic', model: 'claude-opus-5-5' } : undefined)
    const resolver = new ModelTierResolver({ client })
    await expect(resolver.resolve('basic', testSignal)).rejects.toThrow(/no usable route/)
  })

  it('caches a resolution within the TTL window without a second registry read', async () => {
    let calls = 0
    const client = fakeClient(() => {
      calls += 1
      return { provider: 'anthropic', model: 'claude-sonnet-5' }
    })
    let now = 1000
    const resolver = new ModelTierResolver({ client, ttlMs: 5000, now: () => now })
    await resolver.resolve('basic', testSignal)
    now += 1000
    await resolver.resolve('basic', testSignal)
    expect(calls).toBe(1)
  })

  it('re-reads the registry once the TTL window elapses', async () => {
    let calls = 0
    const client = fakeClient(() => {
      calls += 1
      return { provider: 'anthropic', model: 'claude-sonnet-5' }
    })
    let now = 1000
    const resolver = new ModelTierResolver({ client, ttlMs: 5000, now: () => now })
    await resolver.resolve('basic', testSignal)
    now += 5001
    await resolver.resolve('basic', testSignal)
    expect(calls).toBe(2)
  })

  it('falls back to the last good resolution when a later read fails (paused/unavailable)', async () => {
    let paused = false
    const client = fakeClient(() => {
      if (paused) return undefined // paused/over-budget/unreachable: a read miss, not a throw
      return { provider: 'anthropic', model: 'claude-sonnet-5' }
    })
    let now = 1000
    const resolver = new ModelTierResolver({ client, ttlMs: 100, now: () => now })
    await expect(resolver.resolve('mid', testSignal)).resolves.toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    })
    paused = true
    now += 200 // past the TTL, forcing a fresh read that now misses
    await expect(resolver.resolve('mid', testSignal)).resolves.toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    })
  })

  it('falls back to the last good resolution when the client throws (transient network failure)', async () => {
    let fail = false
    const client: ModelTierRegistryClient = {
      resolveClass: async () => {
        if (fail) throw new Error('ECONNRESET')
        return { provider: 'anthropic', model: 'claude-sonnet-5' }
      },
    }
    let now = 1000
    const resolver = new ModelTierResolver({ client, ttlMs: 100, now: () => now })
    await resolver.resolve('capable', testSignal)
    fail = true
    now += 200
    await expect(resolver.resolve('capable', testSignal)).resolves.toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    })
  })

  it('fails closed with TIER_UNAVAILABLE when unavailable AND no prior cache exists (paused with no history)', async () => {
    const client = fakeClient(() => undefined)
    const resolver = new ModelTierResolver({ client })
    const error = await resolver.resolve('mid', testSignal).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SubagentError)
    expect((error as SubagentError).code).toBe('TIER_UNAVAILABLE')
  })

  it('propagates TIER_ACCESS_DENIED from the client without caching or falling back', async () => {
    const client: ModelTierRegistryClient = {
      resolveClass: async () => {
        throw new SubagentError('caller not on the fence', 'TIER_ACCESS_DENIED')
      },
    }
    const resolver = new ModelTierResolver({ client })
    const error = await resolver.resolve('capable', testSignal).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SubagentError)
    expect((error as SubagentError).code).toBe('TIER_ACCESS_DENIED')
  })

  it('keeps each tier on its own independent cache entry', async () => {
    const routes: Record<string, ResolvedTierRoute> = {
      'subagent-basic': { provider: 'anthropic', model: 'claude-sonnet-5' },
      'subagent-mid': { provider: 'openai-codex', model: 'gpt-6-sol' },
      'subagent-capable': { provider: 'anthropic', model: 'claude-opus-5-5' },
    }
    const seen: string[] = []
    const client = fakeClient((className) => {
      seen.push(className)
      return routes[className]
    })
    const resolver = new ModelTierResolver({ client })
    await resolver.resolve('basic', testSignal)
    await resolver.resolve('mid', testSignal)
    await resolver.resolve('capable', testSignal)
    expect(seen).toEqual(['subagent-basic', 'subagent-mid', 'subagent-capable'])
  })

  it('supports operator-configured class names distinct from the defaults', async () => {
    const client = fakeClient(className =>
      className === 'ops-custom-mid' ? { provider: 'grok', model: 'grok-4.5' } : undefined)
    const resolver = new ModelTierResolver({
      client,
      classNames: { basic: 'ops-custom-basic', mid: 'ops-custom-mid', capable: 'ops-custom-capable' },
    })
    await expect(resolver.resolve('mid', testSignal)).resolves.toEqual({ provider: 'grok', model: 'grok-4.5' })
  })
})

describe('assertValidModelSelection', () => {
  it('accepts a bare tier', () => {
    expect(() => assertValidModelSelection({ tier: 'basic' })).not.toThrow()
  })

  it('accepts an explicit provider+model pair with no tier', () => {
    expect(() => assertValidModelSelection({ provider: 'anthropic', model: 'claude-opus-5-5' })).not.toThrow()
  })

  it('accepts an empty selection (no override requested)', () => {
    expect(() => assertValidModelSelection({})).not.toThrow()
  })

  it('rejects an unknown tier name', () => {
    expect(() => assertValidModelSelection({ tier: 'legendary' })).toThrow(/unknown model tier/)
  })

  it('rejects a tier mixed with an explicit provider', () => {
    expect(() => assertValidModelSelection({ tier: 'mid', provider: 'anthropic' })).toThrow(/ambiguous/)
  })

  it('rejects a tier mixed with an explicit model', () => {
    expect(() => assertValidModelSelection({ tier: 'mid', model: 'claude-opus-5-5' })).toThrow(/ambiguous/)
  })

  it('rejects a tier mixed with both explicit provider and model', () => {
    expect(() => assertValidModelSelection({ tier: 'capable', provider: 'anthropic', model: 'claude-opus-5-5' }))
      .toThrow(/ambiguous/)
  })

  it('rejects a lone provider without a model', () => {
    expect(() => assertValidModelSelection({ provider: 'anthropic' })).toThrow(/requires both/)
  })

  it('rejects a lone model without a provider', () => {
    expect(() => assertValidModelSelection({ model: 'claude-opus-5-5' })).toThrow(/requires both/)
  })
})

describe('resolveModelSelection', () => {
  it('resolves an explicit provider+model pair without consulting the resolver', async () => {
    const resolve = vi.fn()
    const resolver = new ModelTierResolver({ client: { resolveClass: resolve } })
    const result = await resolveModelSelection(
      { provider: 'anthropic', model: 'claude-opus-5-5' },
      resolver,
      testSignal,
    )
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('resolves a named tier through the resolver', async () => {
    const client = fakeClient(className =>
      className === 'subagent-capable' ? { provider: 'anthropic', model: 'claude-opus-5-5' } : undefined)
    const resolver = new ModelTierResolver({ client })
    const result = await resolveModelSelection({ tier: 'capable' }, resolver, testSignal)
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' })
  })

  it('returns undefined when the caller named neither a tier nor an explicit route', async () => {
    const resolver = new ModelTierResolver({ client: fakeClient(() => undefined) })
    const result = await resolveModelSelection({}, resolver, testSignal)
    expect(result).toBeUndefined()
  })
})
