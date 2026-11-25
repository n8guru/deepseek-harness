import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import RunawayGuard, { conductorSeats } from '../src/index.ts'

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

describe('preset-scoped runaway guard', () => {
  it('rejects the next model step and quiesces owned background jobs', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('test')
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(RunawayGuard, {
      maxSteps: 2,
      maxTokens: 0,
      maxRepeatCalls: 0,
      jobSettleTimeoutMs: 1000,
    })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'noop', { n: 1 }),
      toolCallResponse('c2', 'noop', { n: 2 }),
      textResponse('must not run'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'noop', description: 'probe', parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'ok' }]),
    }))
    const agent = ctx.agentLoop.create(SessionId('mesh-worker'), { provider: 'mock', model: 'mock' })
    let settle!: (outcome: JobOutcome) => void
    const cancelled: string[] = []
    ctx.jobs.start({
      kind: 'bash', label: 'poll forever', owner: agent,
      run: () => ({
        cancel(reason) { cancelled.push(reason ?? ''); settle({ status: 'killed' }) },
        done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
      }),
    })
    ctx.jobs.start({
      kind: 'bash', label: 'unowned shared work',
      run: () => ({
        cancel() { cancelled.push('unowned') },
        done: new Promise<JobOutcome>(() => {}),
      }),
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    expect(cancelled).toEqual(['owner stopped by runaway guard'])
    expect(ctx.jobs.list(agent).find(job => job.ownerSession === agent.id)?.status).toBe('killed')
    expect(ctx.jobs.list(agent).find(job => job.ownerSession === undefined)?.status).toBe('running')
    expect(agent.session.events.some(event => event.type === 'agent/runaway-stop')).toBe(true)
    expect(agent.session.events.some(event => event.type === 'subagent/guard-stop')).toBe(false)
  })

  it('does not apply the parent preset guard to delegated children', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('test')
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(RunawayGuard, {
      maxSteps: 1, maxTokens: 0, maxRepeatCalls: 0, jobSettleTimeoutMs: 1000,
    })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'noop', { n: 1 }),
      textResponse('child completed'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'noop', description: 'probe', parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'ok' }]),
    }))
    const child = ctx.agentLoop.create(
      SessionId('mesh-child'),
      { provider: 'mock', model: 'mock' },
      { origin: 'subagent', delegationDepth: 1 } as never,
    )

    child.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, child)

    expect(adapter.requests).toHaveLength(2)
    expect(child.session.events.some(event => event.type === 'agent/runaway-stop')).toBe(false)
  })

  async function runSeatProbe(sessionId: string, opened: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), 'runaway-seat-'))
    const registry = join(dir, 'state.json')
    writeFileSync(registry, JSON.stringify({ opened, closed: { 'cadence-gen-1': {} } }))
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('test')
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(RunawayGuard, {
      maxSteps: 1, maxTokens: 0, maxRepeatCalls: 0, jobSettleTimeoutMs: 1000, conductorSeatRegistry: registry,
    })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'noop', { n: 1 }),
      textResponse('conductor completed'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'noop', description: 'probe', parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'ok' }]),
    }))
    const agent = ctx.agentLoop.create(SessionId(sessionId), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    rmSync(dir, { recursive: true, force: true })
    return { requests: adapter.requests.length, stopped: agent.session.events.some(event => event.type === 'agent/runaway-stop') }
  }

  it('never stops a session holding a conductor seat in the registry, whatever its id', async () => {
    const seat = await runSeatProbe('standing-conductor-7', { 'standing-conductor-7': { opened_at: 'now' } })
    expect(seat).toEqual({ requests: 2, stopped: false })
  })

  it('guards a cadence-gen-* session that holds no registry seat (no id-pattern exemption)', async () => {
    const unseated = await runSeatProbe('cadence-gen-142', { 'standing-conductor-7': { opened_at: 'now' } })
    expect(unseated).toEqual({ requests: 1, stopped: true })
  })

  it('seats nobody when the registry file is missing or malformed', () => {
    expect(conductorSeats('')('x')).toBe(false)
    expect(conductorSeats(join(tmpdir(), 'no-such-runaway-seat.json'))('x')).toBe(false)
    const dir = mkdtempSync(join(tmpdir(), 'runaway-seat-'))
    writeFileSync(join(dir, 'state.json'), '{not json')
    expect(conductorSeats(join(dir, 'state.json'))('x')).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('attempts every owned cancellation and fails closed when cleanup cannot settle', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('test')
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(RunawayGuard, {
      maxSteps: 1, maxTokens: 0, maxRepeatCalls: 0, jobSettleTimeoutMs: 10,
    })
    const adapter = new MockAdapter([toolCallResponse('c1', 'noop', { n: 1 })])
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'noop', description: 'probe', parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'ok' }]),
    }))
    const agent = ctx.agentLoop.create(SessionId('cleanup-failure'), { provider: 'mock', model: 'mock' })
    const cancelled: string[] = []
    ctx.jobs.start({
      kind: 'bash', label: 'throws on cancel', owner: agent,
      run: () => ({ cancel() { cancelled.push('bad'); throw new Error('cancel boom') }, done: new Promise<JobOutcome>(() => {}) }),
    })
    let settle!: (outcome: JobOutcome) => void
    ctx.jobs.start({
      kind: 'bash', label: 'settles on cancel', owner: agent,
      run: () => ({
        cancel() { cancelled.push('good'); settle({ status: 'killed' }) },
        done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
      }),
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(cancelled).toEqual(['bad', 'good'])
    expect(agent.session.events.some(event => event.type === 'agent/runaway-stop')).toBe(true)
    const end = agent.session.events.findLast(event => event.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.data.reason.kind).toBe('error')
  })
})

/**
 * g143: the mesh-worker preset values (see `~/.dsh/.agent-presets/mesh-worker/agent.cordis.yml`).
 * Replayed over 208 recorded forge mesh sessions: only the 164112 runaway stops on tokens (step 114,
 * 623k uncached / 20.6M cache reads); 164299/164307/164408/164413 (~10M incl. cache reads, ~2.6k
 * uncached per step) run to the end.
 */
const MESH_WORKER = {
  maxSteps: 300,
  maxTokens: 600_000,
  maxTokensPerHour: 500_000,
  maxDelegationsPerHour: 20,
  maxRepeatCalls: 12,
  jobSettleTimeoutMs: 1000,
}

type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }

/** A scripted tool-call step whose provider usage is `usage`. */
function step(index: number, name: string, args: object, usage: Usage) {
  return toolCallResponse(`c${String(index)}`, name, args)
    .map(chunk => (chunk.type === 'usage' ? { ...chunk, usage } : chunk))
}

/** Run one top-level mesh-worker session over `script` under the mesh-worker guard values. */
async function runMeshWorker(script: ReturnType<typeof step>[], tools: string[] = ['noop'], onCall = () => {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('test')
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(RunawayGuard, MESH_WORKER)
  const adapter = new MockAdapter([...script, textResponse('done')])
  ctx.llm.registerAdapter(['mock'], adapter)
  for (const name of tools) {
    ctx.tools.register(defineContentToolFixture({
      name, description: 'probe', parameters: {},
      execute: () => { onCall(); return Promise.resolve([{ type: 'text', text: 'ok' }]) },
    }))
  }
  const agent = ctx.agentLoop.create(SessionId('mesh-164xxx'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)
  const stop = agent.session.events.find(event => event.type === 'agent/runaway-stop')
  return { requests: adapter.requests.length, stop: stop?.type === 'agent/runaway-stop' ? stop.data : undefined }
}

/** A ~100k-context step (164413's profile): the prefix is re-read from cache, ~2.6k is uncached. */
const CACHED: Usage = { inputTokens: 1_000, outputTokens: 600, cacheReadTokens: 100_000, cacheWriteTokens: 1_000 }

describe('g143 cache-aware mesh-worker guard', () => {
  afterEach(() => { vi.useRealTimers() })

  it('lets a 150-step cached session run to the end (15.4M tokens incl. cache reads)', async () => {
    const { requests, stop } = await runMeshWorker(
      Array.from({ length: 150 }, (_, i) => step(i, 'noop', { i }, CACHED)),
    )
    expect(stop).toBeUndefined()
    expect(requests).toBe(151)
  })

  it('stops a subagent fan-out burst and reports cache reads separately', async () => {
    const { requests, stop } = await runMeshWorker(
      Array.from({ length: 40 }, (_, i) => step(i, 'subagent', { prompt: `child ${String(i)}` }, CACHED)),
      ['subagent'],
    )
    expect(stop).toMatchObject({ limit: 'fan-out', limitValue: 20, observed: 20, cacheReadTokens: 2_000_000 })
    expect(requests).toBe(20)
  })

  it('stops an identical-call repeat loop', async () => {
    const { requests, stop } = await runMeshWorker(
      Array.from({ length: 40 }, (_, i) => step(i, 'noop', { poll: 'same' }, CACHED)),
    )
    expect(stop).toMatchObject({ limit: 'repeat-call', limitValue: 12, observed: 12 })
    expect(requests).toBe(12)
  })

  it('stops an uncached token burst within the hour', async () => {
    // A cold-cache or cache-less loop: every step pays its whole 130k context.
    const { requests, stop } = await runMeshWorker(
      Array.from({ length: 40 }, (_, i) => step(i, 'noop', { i }, { inputTokens: 129_500, outputTokens: 500 })),
    )
    expect(stop).toMatchObject({ limit: 'token-rate', limitValue: 500_000, observed: 520_000 })
    expect(requests).toBe(4)
  })

  it('stops the 164112-class long runaway on its uncached total, not on cache reads', async () => {
    // 164112: ~5.4k uncached and ~180k cache reads per step, one step a minute (it polled with sleep);
    // the replay stopped it at step 114. Its hourly rate stays under the burst check.
    vi.useFakeTimers({ toFake: ['Date'] })
    const heavy: Usage = { inputTokens: 2_000, outputTokens: 900, cacheReadTokens: 180_000, cacheWriteTokens: 2_500 }
    const { requests, stop } = await runMeshWorker(
      Array.from({ length: 200 }, (_, i) => step(i, 'noop', { i }, heavy)),
      ['noop'],
      () => { vi.setSystemTime(Date.now() + 60_000) },
    )
    expect(stop).toMatchObject({ limit: 'tokens', limitValue: 600_000, observed: 112 * 5_400, cacheReadTokens: 112 * 180_000 })
    expect(stop?.detail).toContain('cache-read tokens not counted')
    expect(requests).toBe(112)
  })
})
