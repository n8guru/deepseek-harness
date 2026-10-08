/**
 * Keyless runtime smoke for the source-mode workflow worker. The Node
 * compatibility matrix runs this WHOLE file, so renaming or removing its test
 * cannot turn the runtime proof into a successful zero-match filter.
 */

import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import WorkerThreadWorkflowEngine from '../src/index.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

// A fresh thread compiles the source runtime. Leave contention headroom on
// shared CI runners without weakening any engine-level timeout assertion.
vi.setConfig({ testTimeout: 30_000 })

it('runs the default config through the source worker', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const subagents = await ctx.plugin(SubagentRuntime)
  const provider: SubagentProvider = {
    name: 'spawn',
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    start: () => Promise.reject(new Error('source-worker compat script must not start a child')),
  }
  ctx.subagents.registerProvider(provider)
  const engine = await ctx.plugin(WorkerThreadWorkflowEngine, {})
  const parent = ctx.agentLoop.create(SessionId('workflow-compat-parent'), {})
  try {
    const run = ctx.workflowEngine.start({
      script: 'return 6 * 7',
      meta: { name: 'source-worker-compat', description: 'exercise the unbuilt worker entry' },
      parent,
    })
    try {
      await expect(run.result).resolves.toMatchObject({ value: 42, stopReason: 'completed', agentsStarted: 0 })
    } finally {
      await run.dispose()
    }
  } finally {
    await engine.dispose()
    await subagents.dispose()
  }
})
