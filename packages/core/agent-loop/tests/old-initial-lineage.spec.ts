import { it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SubagentRuntime, { type ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { startInProcessRun } from '../../../subagent/subagent-in-process-driver/src/index.ts'

class Keyless extends LlmAdapter {
  calls = 0
  override async resolveModel(provider: string, id: string) { return { provider, id, name: id } }
  async *stream() { this.calls++; yield { type: 'finish' as const, reason: { kind: 'stop' as const } } }
}
async function harness() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  const adapter = new Keyless()
  ctx.llm.registerAdapter(['keyless'], adapter)
  const parent = ctx.agentLoop.create(SessionId('original-parent'), { provider: 'keyless', model: 'fixture' })
  return { ctx, parent, adapter }
}

it('canonical old service/provider await -> CLOSED -> canonical driver publishes exactly original input, zero forced turns', async () => {
  const { ctx, parent, adapter } = await harness()
  const entered = Promise.withResolvers<ResolvedSubagentStartRequest>()
  const release = Promise.withResolvers<void>()
  const abort = new AbortController()
  let run: Awaited<ReturnType<typeof startInProcessRun>> | undefined
  try {
    ctx.subagents.registerProvider({ name: 'delayed', capabilities: {}, async start(request) {
      entered.resolve(request); await release.promise
      return startInProcessRun(request, {})
    } })
    const prompt = [{ type: 'text' as const, text: 'immutable original' }]
    const pending = ctx.subagents.start('delayed', { parent, signal: abort.signal, prompt })
    const resolved = await entered.promise
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.prompt[0])).toBe(true)
    expect(Reflect.set(resolved.prompt[0]!, 'text', 'provider mutation')).toBe(false)
    const capability = resolved.initialAdmission!
    ctx.hostAdmission.close()
    prompt[0]!.text = 'caller mutated after await'
    // All failures occur before publication/consume; original capability remains usable.
    const options = { sessionId: capability.sessionId, parentAgent: parent, signal: abort.signal,
      initialAdmission: capability, meta: { parentSession: parent.id } }
    for (const change of [
      { initialAdmission: { ...capability } },
      { sessionId: SessionId('wrong-child') },
      { parentAgent: { ...parent } },
      { signal: new AbortController().signal },
      { meta: { parentSession: SessionId('wrong-parent') } },
    ]) {
      await expect(ctx.agents.create({ ...options, ...change } as never)).rejects.toThrow('initial')
    }
    // Copied or modified resolved request cannot reuse original child authority.
    await expect(startInProcessRun({ ...resolved }, {})).rejects.toThrow('initial request')
    await expect(startInProcessRun({ ...resolved, prompt: [{ type: 'text', text: 'replacement' }] }, {})).rejects.toThrow('initial request')
    release.resolve()
    run = await pending
    const child = run.localAgent!
    expect(child.id).toBe(capability.sessionId)
    expect(child.inbox.nextTurn).toHaveLength(1)
    expect(child.inbox.nextTurn[0]!.content).toEqual([{ type: 'text', text: 'immutable original' }])
    expect(child.inbox.nextTurn[0]!.id).toBe(capability.messageId)
    expect(adapter.calls).toBe(0)
    expect(ctx.hostAdmission.open).toBe(false)
    expect(ctx.hostAdmission.status().pending).toContain('publication')
    expect(() => child.followup(child.inbox.nextTurn[0]!, capability)).toThrow('initial input')
    expect(() => child.inbox.splice('next-turn', 0, 0, [{ ...child.inbox.nextTurn[0]!, content: [{ type: 'text', text: 'mutation' }] }], capability)).toThrow('initial input')
    expect(() => child.followup(child.inbox.nextTurn[0]!)).toThrow('CLOSED')
    await expect(ctx.agents.create(options)).rejects.toThrow('initial')
    await expect(ctx.subagents.start('delayed', { parent: child, signal: abort.signal, prompt: [] })).rejects.toThrow('CLOSED')
    let finished = false
    void run.result.then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false) // Agent idle alone must not pretend the held input ran.
    abort.abort()
    await run.result
    expect(ctx.hostAdmission.status().pending).toContain('delegate')
    expect(ctx.hostAdmission.status().pending).toContain('publication')
    await run.dispose()
    expect(ctx.hostAdmission.status().pending).not.toContain('delegate')
    expect(ctx.hostAdmission.status().pending).not.toContain('publication')
    expect(adapter.calls).toBe(0)
  } finally { release.resolve(); abort.abort(); await run?.dispose(); await ctx.fiber.dispose() }
})

it('OPEN canonical one-shot accepts only one initial input and result is not owned disposal/join', async () => {
  const { ctx, parent, adapter } = await harness()
  let run: Awaited<ReturnType<typeof startInProcessRun>> | undefined
  try {
    ctx.subagents.registerProvider({ name: 'immediate', capabilities: {},
      start: request => startInProcessRun(request, {}) })
    run = await ctx.subagents.start('immediate', { parent, signal: new AbortController().signal,
      prompt: [{ type: 'text', text: 'one original' }] })
    await run.result
    expect(adapter.calls).toBe(1)
    expect(run.localAgent!.session.events.filter(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.length > 0)).toHaveLength(1)
    expect(ctx.hostAdmission.status().pending).toContain('publication')
    expect(ctx.hostAdmission.status().pending).toContain('delegate')
    await run.dispose()
    expect(ctx.hostAdmission.status().pending).not.toContain('publication')
    expect(ctx.hostAdmission.status().pending).not.toContain('delegate')
  } finally { await run?.dispose(); await ctx.fiber.dispose() }
})

it('post-close starts and aborted prepublication initial requests stay fail closed with honest unresolved ownership', async () => {
  const { ctx, parent } = await harness()
  const entered = Promise.withResolvers<ResolvedSubagentStartRequest>()
  const release = Promise.withResolvers<void>()
  const abort = new AbortController()
  try {
    ctx.subagents.registerProvider({ name: 'aborted', capabilities: {}, async start(request) {
      entered.resolve(request); await release.promise
      return startInProcessRun(request, {})
    } })
    const pending = ctx.subagents.start('aborted', { parent, signal: abort.signal, prompt: [] })
    const outcome = pending.catch(error => error)
    const resolved = await entered.promise
    ctx.hostAdmission.close(); abort.abort(); release.resolve()
    expect(await outcome).toBeInstanceOf(Error)
    expect(ctx.agents.get(resolved.initialAdmission!.sessionId)).toBeUndefined()
    expect(ctx.hostAdmission.status().pending).toContain('delegate')
    expect(ctx.hostAdmission.status().pending).toContain('publication')
    await expect(ctx.subagents.start('aborted', { parent, signal: new AbortController().signal, prompt: [] })).rejects.toThrow('CLOSED')
  } finally { release.resolve(); await ctx.fiber.dispose() }
})
