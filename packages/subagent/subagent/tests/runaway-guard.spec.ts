import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime, {
  DEFAULT_MAX_REPEAT_CALLS,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOKENS,
  guardStopOf,
  resolveRunawayLimits,
} from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** Boot loop + subagent runtime + spawn provider with a scripted model and a `noop` tool. */
async function setup(script: Script, options: { persistence?: boolean } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  if (options.persistence === true) {
    const root = mkdtempSync(join(tmpdir(), 'dsh-runaway-guard-'))
    roots.push(root)
    await ctx.plugin(JsonlSessionPersistence, { root })
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.tools.register(defineContentToolFixture({
    name: 'noop',
    description: 'probe',
    parameters: {},
    execute: () => Promise.resolve([{ type: 'text', text: 'ok' }]),
  }))
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, adapter }
}

/** Run one one-shot child to its result. */
async function runChild(ctx: Context, parent: Agent) {
  const run = await ctx.subagents.start('spawn', {
    prompt: [{ type: 'text', text: 'child task' }],
    parent,
    signal: new AbortController().signal,
  })
  const result = await run.result
  const child = ctx.agents.get(run.id)!
  const stop = guardStopOf(child.session.events)
  await run.dispose()
  return { result, stop }
}

function text(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

/** `n` tool-call steps with distinct arguments, then a final answer. */
function distinctCalls(n: number): Script {
  return [
    ...Array.from({ length: n }, (_, i) => toolCallResponse(`c${String(i)}`, 'noop', { i })),
    textResponse('done'),
  ]
}

/** Disable every guard limit except those the test names. */
function onlyLimit(name: 'STEPS' | 'TOKENS' | 'REPEAT_CALLS', value: string): void {
  for (const other of ['STEPS', 'TOKENS', 'REPEAT_CALLS']) vi.stubEnv(`DSH_SUBAGENT_MAX_${other}`, 'off')
  vi.stubEnv(`DSH_SUBAGENT_MAX_${name}`, value)
}

describe('resolveRunawayLimits', () => {
  it('defaults to 200 steps, 20M tokens, 20 identical calls', () => {
    expect(resolveRunawayLimits({})).toEqual({ maxSteps: 200, maxTokens: 20_000_000, maxRepeatCalls: 20 })
    expect([DEFAULT_MAX_STEPS, DEFAULT_MAX_TOKENS, DEFAULT_MAX_REPEAT_CALLS]).toEqual([200, 20_000_000, 20])
  })

  it('honors overrides, disables on 0 or off, and ignores garbage', () => {
    expect(resolveRunawayLimits({
      DSH_SUBAGENT_MAX_STEPS: '5',
      DSH_SUBAGENT_MAX_TOKENS: '0',
      DSH_SUBAGENT_MAX_REPEAT_CALLS: ' OFF ',
    })).toEqual({ maxSteps: 5, maxTokens: undefined, maxRepeatCalls: undefined })
    expect(resolveRunawayLimits({
      DSH_SUBAGENT_MAX_STEPS: 'many',
      DSH_SUBAGENT_MAX_TOKENS: '-3',
      DSH_SUBAGENT_MAX_REPEAT_CALLS: '',
    })).toEqual({ maxSteps: 200, maxTokens: 20_000_000, maxRepeatCalls: 20 })
  })
})

describe('runaway guard on one-shot children', () => {
  it('stops a child that reaches the step cap with a clear error result', async () => {
    onlyLimit('STEPS', '3')
    const { ctx, parent, adapter } = await setup(distinctCalls(10))
    const { result, stop } = await runChild(ctx, parent)
    expect(result.stopReason).toBe('error')
    expect(text(result.output)).toContain('Subagent stopped by runaway guard: step cap 3 reached (3 steps taken)')
    expect(stop).toMatchObject({ limit: 'steps', limitValue: 3, observed: 3 })
    expect(adapter.requests).toHaveLength(3)
  })

  it('stops a child that reaches or exceeds the token budget', async () => {
    // Each scripted tool-call step reports 10 input + 5 output tokens.
    onlyLimit('TOKENS', '20')
    const { ctx, parent, adapter } = await setup(distinctCalls(10))
    const { result, stop } = await runChild(ctx, parent)
    expect(result.stopReason).toBe('error')
    expect(text(result.output)).toContain('Subagent stopped by runaway guard: token budget 20 reached (30 uncached tokens used; 0 cache-read tokens not counted)')
    expect(stop).toMatchObject({ limit: 'tokens', limitValue: 20, observed: 30 })
    expect(adapter.requests).toHaveLength(2)
  })

  it('does not admit another step at exact token equality', async () => {
    onlyLimit('TOKENS', '30')
    const { ctx, parent, adapter } = await setup(distinctCalls(10))
    const { stop } = await runChild(ctx, parent)
    expect(stop).toMatchObject({ limit: 'tokens', limitValue: 30, observed: 30 })
    expect(adapter.requests).toHaveLength(2)
  })

  it('stops a child cycling the same calls, counting total rather than consecutive repeats', async () => {
    onlyLimit('REPEAT_CALLS', '3')
    // Two files visited alternately: never two identical calls in a row.
    const script: Script = [
      ...Array.from({ length: 10 }, (_, i) =>
        // Key order differs between visits: canonical JSON must still match.
        toolCallResponse(`c${String(i)}`, 'noop', i % 2 === 0 ? { path: 'a', page: 1 } : { path: 'b' })),
      textResponse('done'),
    ]
    script[2] = toolCallResponse('c2', 'noop', { page: 1, path: 'a' })
    const { ctx, parent, adapter } = await setup(script)
    const { result, stop } = await runChild(ctx, parent)
    expect(result.stopReason).toBe('error')
    expect(text(result.output)).toContain(
      'Subagent stopped by runaway guard: repeated-call guard: tool "noop" was called with identical arguments 3 times (limit 3)',
    )
    expect(stop).toMatchObject({ limit: 'repeat-call', limitValue: 3, observed: 3 })
    expect(adapter.requests).toHaveLength(5)
  })

  it('lets a child under every limit finish normally', async () => {
    vi.stubEnv('DSH_SUBAGENT_MAX_STEPS', '5')
    vi.stubEnv('DSH_SUBAGENT_MAX_TOKENS', '1000')
    vi.stubEnv('DSH_SUBAGENT_MAX_REPEAT_CALLS', '3')
    const { ctx, parent } = await setup(distinctCalls(2))
    const { result, stop } = await runChild(ctx, parent)
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('done')
    expect(stop).toBeUndefined()
  })

  it.each(['0', 'off'])('does not enforce a limit disabled with %s', async (disabled) => {
    vi.stubEnv('DSH_SUBAGENT_MAX_STEPS', disabled)
    vi.stubEnv('DSH_SUBAGENT_MAX_TOKENS', disabled)
    vi.stubEnv('DSH_SUBAGENT_MAX_REPEAT_CALLS', disabled)
    // Twenty-four identical calls: past the default repeat limit of 20.
    const script: Script = [
      ...Array.from({ length: 24 }, (_, i) => toolCallResponse(`c${String(i)}`, 'noop', { same: true })),
      textResponse('done'),
    ]
    const { ctx, parent } = await setup(script)
    const { result, stop } = await runChild(ctx, parent)
    expect(result.stopReason).toBe('completed')
    expect(stop).toBeUndefined()
  })

  it('applies the default repeated-call limit of 20 with no environment', async () => {
    const script: Script = [
      ...Array.from({ length: 24 }, (_, i) => toolCallResponse(`c${String(i)}`, 'noop', { same: true })),
      textResponse('done'),
    ]
    const { ctx, parent, adapter } = await setup(script)
    const { result } = await runChild(ctx, parent)
    expect(result.stopReason).toBe('error')
    expect(adapter.requests).toHaveLength(20)
  })
})

describe('runaway guard on continuable children', () => {
  it('stops the child and tells the parent which limit tripped', async () => {
    onlyLimit('STEPS', '2')
    const { ctx, parent } = await setup([...distinctCalls(5), textResponse('parent ack')], { persistence: true })
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'child task',
      request: { prompt: [{ type: 'text', text: 'child task' }], parent },
      signal: new AbortController().signal,
    })
    await vi.waitFor(() => { expect(ctx.agents.get(started.childId)).toBeUndefined() })
    const notices = await vi.waitFor(() => {
      const found = parent.session.events.flatMap(event => event.type === 'user/message'
        && event.data.source.kind === 'subagent-settled'
        ? [event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')]
        : [])
      expect(found).toHaveLength(1)
      return found
    })
    expect(notices[0]).toContain(
      `Background subagent ${started.childId} stopped by runaway guard: step cap 2 reached (2 steps taken).`,
    )
  })
})
