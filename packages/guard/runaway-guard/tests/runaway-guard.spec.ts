import { describe, expect, it } from 'vitest'
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
import RunawayGuard from '../src/index.ts'

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

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    expect(cancelled).toEqual(['owner stopped by runaway guard'])
    expect(ctx.jobs.list(agent)[0]?.status).toBe('killed')
    expect(agent.session.events.some(event => event.type === 'agent/runaway-stop')).toBe(true)
    expect(agent.session.events.some(event => event.type === 'subagent/guard-stop')).toBe(false)
  })
})
