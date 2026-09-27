/**
 * Integration coverage for registry-backed complexity-tier model selection
 * (mesh-dsh-merge step 55): basic/mid/capable resolution, explicit route
 * selection alongside tiers, invalid/conflicting requests, paused/unavailable
 * tiers, parent-selected-model mismatch reporting, and both the `spawn`
 * (fresh child) and `fork` (parent-context-inheriting) delegation shapes.
 */
import { describe, expect, it } from 'vitest'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { ModelTierRegistryClient, ResolvedTierRoute } from '@deepseek-ai/dsh-subagent'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import {
  callSubagent,
  modelSelectionSetupAgent,
  setup,
  text,
} from './harness.ts'

/** A tier registry client backed by an in-memory routing table, for deterministic tests. */
function tableClient(
  routes: Record<string, ResolvedTierRoute | undefined>,
): ModelTierRegistryClient {
  return {
    resolveClass: async (className: string) => routes[className],
  }
}

describe('tool-subagent tier model selection (spawn provider)', () => {
  it('exposes tier as a model-facing field only when modelTiers is configured', async () => {
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      maxDepth: 'provider-managed',
      modelTiers: {
        client: tableClient({ 'subagent-basic': { provider: 'alpha', model: 'basic-model' } }),
      },
    })
    const schema = ctx.tools.schemas(modelSelectionSetupAgent(ctx)).find(s => s.name === 'subagent')
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props)).toContain('tier')
  })

  it('omits tier from the schema when modelTiers is not configured, even with model selection enabled', async () => {
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      maxDepth: 'provider-managed',
    })
    const schema = ctx.tools.schemas(modelSelectionSetupAgent(ctx)).find(s => s.name === 'subagent')
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props)).not.toContain('tier')
  })

  it('resolves tier: basic to the registry-served basic-class route and starts the child on it', async () => {
    let seen: SubagentStartRequest | undefined
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      maxDepth: 'provider-managed',
      modelTiers: {
        client: tableClient({ 'subagent-basic': { provider: 'alpha', model: 'basic-model' } }),
      },
    }, { onStart: (request) => { seen = request } })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', tier: 'basic' })
    expect(result.isError).toBe(false)
    expect(seen?.agentOptions).toMatchObject({ provider: 'alpha', model: 'basic-model' })
  })

  it('resolves tier: mid independently of basic/capable', async () => {
    let seen: SubagentStartRequest | undefined
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      maxDepth: 'provider-managed',
      modelTiers: {
        client: tableClient({
          'subagent-basic': { provider: 'alpha', model: 'basic-model' },
          'subagent-mid': { provider: 'alpha', model: 'mid-model' },
          'subagent-capable': { provider: 'alpha', model: 'capable-model' },
        }),
      },
    }, { onStart: (request) => { seen = request } })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', tier: 'mid' })
    expect(result.isError).toBe(false)
    expect(seen?.agentOptions).toMatchObject({ provider: 'alpha', model: 'mid-model' })
  })

  it('resolves tier: capable independently of basic/mid', async () => {
    let seen: SubagentStartRequest | undefined
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      maxDepth: 'provider-managed',
      modelTiers: {
        client: tableClient({
          'subagent-basic': { provider: 'alpha', model: 'basic-model' },
          'subagent-mid': { provider: 'alpha', model: 'mid-model' },
          'subagent-capable': { provider: 'alpha', model: 'capable-model' },
        }),
      },
    }, { onStart: (request) => { seen = request } })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', tier: 'capable' })
    expect(result.isError).toBe(false)
    expect(seen?.agentOptions).toMatchObject({ provider: 'alpha', model: 'capable-model' })
  })

  it('still allows a fully explicit provider/model route alongside tier support', async () => {
    let seen: SubagentStartRequest | undefined
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      maxDepth: 'provider-managed',
      modelTiers: {
        client: tableClient({ 'subagent-capable': { provider: 'alpha', model: 'capable-model' } }),
      },
    }, { onStart: (request) => { seen = request } })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))

    // The caller bypasses tiers entirely and pins a route directly.
    const result = await callSubagent(ctx, {
      description: 'd',
      prompt: 'p',
      provider: 'alpha',
      model: 'selected-model',
    })
    expect(result.isError).toBe(false)
    expect(seen?.agentOptions).toMatchObject({ provider: 'alpha', model: 'selected-model' })
  })

  it('rejects a tier mixed with an explicit provider/model as ambiguous, before any registry read', async () => {
    let reads = 0
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      maxDepth: 'provider-managed',
      modelTiers: {
        client: {
          resolveClass: async () => {
            reads += 1
            return { provider: 'alpha', model: 'capable-model' }
          },
        },
      },
    })
    const result = await callSubagent(ctx, {
      description: 'd',
      prompt: 'p',
      tier: 'capable',
      provider: 'alpha',
      model: 'selected-model',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('ambiguous')
    expect(reads).toBe(0)
  })

  it('rejects an unknown tier name before any registry read (schema enum, defense in depth in execute())', async () => {
    let reads = 0
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      maxDepth: 'provider-managed',
      modelTiers: {
        client: { resolveClass: async () => { reads += 1; return undefined } },
      },
    })
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', tier: 'legendary' })
    expect(result.isError).toBe(true)
    // The tool schema's `enum: MODEL_TIERS` rejects this at the arg-validation
    // boundary; `assertValidTierSelection`'s identical check (see
    // model-tier.spec.ts) is defense in depth for a caller that bypasses the
    // registered tool's schema validator.
    expect(text(result)).toContain('must be one of')
    expect(reads).toBe(0)
  })

  it('rejects tier selection when this tool instance has no modelTiers configured', async () => {
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      maxDepth: 'provider-managed',
    })
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', tier: 'basic' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not configured')
  })

  it('fails the call when the requested tier is paused/unavailable and no fallback exists', async () => {
    // The class resolves to no usable model (paused, over budget, or unseeded)
    // and no prior successful resolution is cached: fail closed rather than
    // silently substitute an ambient default.
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      maxDepth: 'provider-managed',
      modelTiers: {
        client: tableClient({ 'subagent-mid': undefined }),
      },
    })
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', tier: 'mid' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no usable route')
  })

  it('rejects a tier the registry fences away from this caller (TIER_ACCESS_DENIED)', async () => {
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      maxDepth: 'provider-managed',
      modelTiers: {
        client: {
          resolveClass: async () => {
            throw new SubagentError('caller not on the fence', 'TIER_ACCESS_DENIED')
          },
        },
      },
    })
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', tier: 'capable' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('caller not on the fence')
  })

  it('rejects a resolved tier route that is not on this Session\'s allowed-model fence', async () => {
    // The tier resolves successfully, but to a route the operator never put
    // on the allowlist: the SAME fence an explicit pin obeys must still apply.
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      maxDepth: 'provider-managed',
      modelTiers: {
        client: tableClient({ 'subagent-capable': { provider: 'nowhere', model: 'ghost-model' } }),
      },
    })
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', tier: 'capable' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not allowed for this Session')
  })

  it('reports requested-vs-actual model mismatch when the child executes on a different route than requested', async () => {
    // Reproduces the exact failure mode the step's notes describe (tools/dsh-subagent-model/RESULT.md):
    // a conductor requested one model, but the child executed on a different one.
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      maxDepth: 'provider-managed',
      modelTiers: {
        client: tableClient({ 'subagent-capable': { provider: 'alpha', model: 'capable-model' } }),
      },
    }, {
      // The child's OWN recorded route differs from what was requested —
      // exactly the silent-substitution scenario this step makes observable.
      actualRoute: { provider: 'alpha', model: 'actual-model' },
    })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', tier: 'capable' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toMatchObject({
      actualProvider: 'alpha',
      actualModel: 'actual-model',
      modelMismatch: true,
    })
    expect(text(result)).toContain('differs from the requested selection')
  })

  it('reports no mismatch when the actual route matches the requested tier route', async () => {
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      maxDepth: 'provider-managed',
      modelTiers: {
        client: tableClient({ 'subagent-basic': { provider: 'alpha', model: 'basic-model' } }),
      },
    }, {
      actualRoute: { provider: 'alpha', model: 'basic-model' },
    })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', tier: 'basic' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toMatchObject({
      actualProvider: 'alpha',
      actualModel: 'basic-model',
      modelMismatch: false,
    })
  })

  it('omits actual-model fields entirely when the caller made no selection (no mismatch to report)', async () => {
    const ctx = await setup({
      provider: 'mock',
      withModelSelection: true,
      maxDepth: 'provider-managed',
    }, {
      actualRoute: { provider: 'alpha', model: 'whatever-model' },
    })
    const result = await callSubagent(ctx, { description: 'd', prompt: 'p' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).not.toHaveProperty('modelMismatch')
  })
})

describe('tool-subagent tier model selection (fork provider)', () => {
  // `subagent` and `subagent_fork` are the SAME tool plugin configured onto
  // different `ctx.subagents` providers (`spawn` vs `fork`); the model-facing
  // tool name stays `subagent` here (harness's callSubagent dials that name),
  // matching the shipped `tool-subagent-fork` preset row's provider-only
  // distinction from the ordinary `tool-subagent` row.
  it('resolves a tier identically for the fork (conversation-inheriting) delegation shape', async () => {
    let seen: SubagentStartRequest | undefined
    const ctx = await setup({
      provider: 'fork',
      withModelSelection: true,
      maxDepth: 'provider-managed',
      modelTiers: {
        client: tableClient({ 'subagent-mid': { provider: 'alpha', model: 'mid-model' } }),
      },
    }, { name: 'fork', onStart: (request) => { seen = request }, inheritsParentContext: true })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', tier: 'mid' })
    expect(result.isError).toBe(false)
    expect(seen?.agentOptions).toMatchObject({ provider: 'alpha', model: 'mid-model' })
  })

  it('rejects an unknown tier on the fork tool the same way as on spawn', async () => {
    const ctx = await setup({
      provider: 'fork',
      withModelSelection: true,
      maxDepth: 'provider-managed',
      modelTiers: { client: tableClient({}) },
    }, { name: 'fork', inheritsParentContext: true })

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', tier: 'legendary' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('must be one of')
  })

  it('records requested-vs-actual mismatch on the fork tool identically to spawn', async () => {
    const ctx = await setup({
      provider: 'fork',
      withModelSelection: true,
      maxDepth: 'provider-managed',
      modelTiers: {
        client: tableClient({ 'subagent-basic': { provider: 'alpha', model: 'basic-model' } }),
      },
    }, {
      name: 'fork',
      inheritsParentContext: true,
      actualRoute: { provider: 'alpha', model: 'actual-model' },
    })
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))

    const result = await callSubagent(ctx, { description: 'd', prompt: 'p', tier: 'basic' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toMatchObject({ modelMismatch: true, actualModel: 'actual-model' })
  })
})
