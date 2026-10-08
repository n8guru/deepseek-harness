import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import WorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'

class Keyless extends LlmAdapter {
  calls = 0
  evidence = false
  override async resolveModel(provider: string, id: string) { return { provider, id, name: id } }
  override backendStatus() {
    return { state: this.evidence ? 'JOINED' as const : 'UNKNOWN' as const, turns: [],
      startingTurns: 0, uncertainStarts: this.evidence ? 0 : 1, unattributedEvents: 0 }
  }
  async *stream() { this.calls++; yield { type: 'finish' as const, reason: { kind: 'stop' as const } } }
}
async function harness(closed = false) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry, { admissionClosed: closed })
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}
const message = () => createUserMessage({ content: [{ type: 'text', text: 'fixed' }], source: { kind: 'user' } })
describe('exact old-source cutoff', () => {
  it('fences held followup AND direct inbox insertion, leaves owned Agent intact', async () => {
    const ctx = await harness()
    try {
      const adapter = new Keyless()
      ctx.llm.registerAdapter(['keyless'], adapter)
      const agent = ctx.agentLoop.create(SessionId('held'), { provider: 'keyless', model: 'none' })
      const held = agent.followup.bind(agent)
      ctx.hostAdmission.close()
      expect(() => held(message())).toThrow('CLOSED')
      expect(() => agent.inbox.splice('next-turn', 0, 0, [message()])).toThrow('CLOSED')
      expect(ctx.agents.get(agent.id)).toBe(agent)
      expect(adapter.calls).toBe(0)
      expect(() => ctx.agentLoop.create(SessionId('later'))).toThrow('CLOSED')
    } finally { await ctx.fiber.dispose() }
  })
  it('preserves exact already admitted factory across setup await/close', async () => {
    const ctx = await harness()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    try {
      const pending = ctx.agents.create({ sessionId: SessionId('reserved'),
        setup: async () => { entered.resolve(); await release.promise } })
      await entered.promise
      ctx.hostAdmission.close()
      expect(ctx.hostAdmission.status().pending).toContain('publication')
      release.resolve()
      const handle = await pending
      expect(ctx.agents.get(handle.agent.id)).toBe(handle.agent)
      expect(ctx.hostAdmission.status().pending).not.toContain('publication')
      await handle.dispose()
    } finally { release.resolve(); await ctx.fiber.dispose() }
  })
  it('cancellation does not retire raw delayed setup publication evidence', async () => {
    const ctx = await harness()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const controller = new AbortController()
    try {
      const pending = ctx.agents.create({ sessionId: SessionId('cancelled'), signal: controller.signal,
        setup: async () => { entered.resolve(); await release.promise } })
      await entered.promise
      ctx.hostAdmission.close()
      controller.abort()
      await expect(pending).rejects.toThrow()
      expect(ctx.hostAdmission.status().unknown).toContain('publication')
      release.resolve()
    } finally { release.resolve(); await ctx.fiber.dispose() }
  })
  it('job cancellation retains producer reservation until genuine done', async () => {
    const ctx = await harness()
    const done = Promise.withResolvers<{ status: 'completed' }>()
    try {
      await ctx.plugin(LocalJobRegistry)
      ctx.jobs.attachController('test')
      const id = ctx.jobs.start({ kind: 'bash', label: 'held', run: () => ({
        done: done.promise, cancel() {},
      }) })
      ctx.hostAdmission.close()
      ctx.jobs.kill(id)
      expect(ctx.hostAdmission.status().pending).toContain('job')
      let launched = false
      expect(() => ctx.jobs.start({ kind: 'bash', label: 'new', run: () => {
        launched = true; return { done: done.promise, cancel() {} }
      } })).toThrow('CLOSED')
      expect(launched).toBe(false)
      done.resolve({ status: 'completed' })
      await done.promise
      expect(ctx.hostAdmission.status().pending).not.toContain('job')
    } finally { done.resolve({ status: 'completed' }); await ctx.fiber.dispose() }
  })
  it('retains unsupported/withdrawn backend identity and true instance generation', async () => {
    const ctx = await harness()
    try {
      const adapter = new Keyless()
      const registration = ctx.llm.registerAdapter(['keyless'], adapter)
      expect(ctx.llm.backendCoverage().state).toBe('UNKNOWN')
      registration()
      expect(ctx.llm.backendCoverage().state).toBe('UNKNOWN')
      adapter.evidence = true
      expect(ctx.llm.backendCoverage().state).toBe('JOINED')
      ctx.llm.registerAdapter(['keyless'], new Keyless())
      expect(ctx.llm.backendCoverage().state).toBe('UNKNOWN')
      expect(ctx.llm.backendCoverage().participants).toHaveLength(2)
    } finally { await ctx.fiber.dispose() }
  })
  it('captures actual pending prepare/stream consumers through route withdrawal', async () => {
    const ctx = await harness()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    class Delayed extends Keyless {
      override async resolveModel(provider: string, id: string) {
        entered.resolve()
        await release.promise
        return { provider, id, name: id }
      }
    }
    try {
      const adapter = new Delayed()
      adapter.evidence = true
      const remove = ctx.llm.registerAdapter(['delayed-llm'], adapter)
      const pending = ctx.llm.prepareCall({ provider: 'delayed-llm', model: 'none' })
      await entered.promise
      remove()
      expect(ctx.llm.backendCoverage().state).toBe('UNKNOWN')
      expect(ctx.hostAdmission.status().backend).toBe('UNKNOWN')
      release.resolve()
      const prepared = await pending
      expect(ctx.llm.backendCoverage().state).toBe('JOINED')
      const iterator = prepared.stream({ ...prepared.config, messages: [message()] })[Symbol.asyncIterator]()
      await iterator.next()
      expect(ctx.llm.backendCoverage().state).toBe('UNKNOWN')
      await iterator.next()
      expect(ctx.llm.backendCoverage().state).toBe('JOINED')
    } finally { release.resolve(); await ctx.fiber.dispose() }
  })
  it('demonstrates the exact missing delayed provider-internal child authority', async () => {
    const ctx = await harness()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    try {
      await ctx.plugin(SubagentRuntime)
      const parent = ctx.agentLoop.create(SessionId('parent'))
      ctx.subagents.registerProvider({
        name: 'delayed', capabilities: {},
        async start(request) {
          entered.resolve()
          await release.promise
          const handle = await request.parent.ctx.agents.create({ sessionId: SessionId('delayed-child') })
          return { id: handle.agent.id, localAgent: handle.agent,
            result: Promise.resolve({ output: [], stopReason: 'completed' as const }),
            dispose: () => handle.dispose() }
        },
      })
      const pending = ctx.subagents.start('delayed', { parent, prompt: [], signal: new AbortController().signal })
      await entered.promise
      ctx.hostAdmission.close()
      release.resolve()
      await expect(pending).rejects.toThrow('CLOSED')
      expect(ctx.hostAdmission.status().pending).toContain('delegate')
      expect(ctx.agents.get(SessionId('delayed-child'))).toBeUndefined()
      // This is negative feasibility evidence of a source contract still needing
      // the current native exact initialAdmission backport, NOT acceptance.
    } finally { release.resolve(); await ctx.fiber.dispose() }
  })
  it('refuses delegate/workflow startup without touching providers or workers', async () => {
    const ctx = await harness()
    try {
      await ctx.plugin(SubagentRuntime)
      let starts = 0
      ctx.subagents.registerProvider({ name: 'unused', capabilities: {}, async start() {
        starts++
        throw new Error('must not start')
      } })
      await ctx.plugin(WorkflowEngine, { provider: 'unused' })
      const parent = ctx.agentLoop.create(SessionId('parent-cold'))
      ctx.hostAdmission.close()
      await expect(ctx.subagents.start('unused', { parent, prompt: [], signal: new AbortController().signal })).rejects.toThrow('CLOSED')
      expect(() => ctx.workflowEngine.start({ parent, meta: { name: 'closed', description: 'closed' }, script: 'return 1' })).toThrow('CLOSED')
      expect(starts).toBe(0)
    } finally { await ctx.fiber.dispose() }
  })
  it('closed boot config precedes direct factory construction', async () => {
    const ctx = await harness(true)
    try {
      expect(ctx.hostAdmission.open).toBe(false)
      expect(() => ctx.agentLoop.create(SessionId('never'))).toThrow('CLOSED')
      expect(ctx.sessions.get(SessionId('never'))).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })
})
