import { it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime, { type ResolvedSubagentStartRequest, type SubagentRun } from '@deepseek-ai/dsh-subagent'
import WorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'
import { startInProcessRun } from '../../../subagent/subagent-in-process-driver/src/index.ts'

class Keyless extends LlmAdapter {
  calls = 0
  override async resolveModel(provider: string, id: string) { return { provider, id, name: id } }
  async *stream() { this.calls++; yield { type: 'finish' as const, reason: { kind: 'stop' as const } } }
}
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function harness(options: { persistence?: boolean } = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  if (options.persistence) {
    const root = mkdtempSync(join(tmpdir(), 'step73-old-finish-'))
    roots.push(root)
    await ctx.plugin(JsonlSessionPersistence, { root })
  }
  await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  const adapter = new Keyless()
  ctx.llm.registerAdapter(['keyless'], adapter)
  const parent = ctx.agentLoop.create(SessionId('finish-parent'), { provider: 'keyless', model: 'fixture' })
  return { ctx, parent, adapter }
}
const tick = () => new Promise(resolve => setImmediate(resolve))
const pending = (ctx: Context) => ctx.hostAdmission.status().pending

it('continuable start: preclose exact initial acceptance publishes after CLOSED with original message, zero forced turns', async () => {
  const { ctx, parent, adapter } = await harness({ persistence: true })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const abort = new AbortController()
  try {
    ctx.subagents.registerProvider({ name: 'cont', inheritsParentContext: false, capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }, start: () => { throw new Error('one-shot unused') },
      async prepareContinuable() { entered.resolve(undefined); await release.promise; return {} } })
    const prompt = [{ type: 'text' as const, text: 'continuable original' }]
    const started = ctx.subagents.startContinuable({ provider: 'cont', label: 'c', request: { parent, prompt }, signal: abort.signal })
    await entered.promise
    ctx.hostAdmission.close()
    prompt[0]!.text = 'caller mutation during prepare await'
    release.resolve(undefined)
    const { childId, messageId } = await started
    const child = ctx.agents.get(childId)!
    expect(child.inbox.nextTurn).toHaveLength(1)
    expect(child.inbox.nextTurn[0]!.id).toBe(messageId)
    expect(child.inbox.nextTurn[0]!.content).toEqual([{ type: 'text', text: 'continuable original' }])
    expect(adapter.calls).toBe(0)
    // Delegate start transaction ended with acceptance; the published child stays counted.
    expect(pending(ctx)).not.toContain('delegate')
    expect(pending(ctx)).toContain('publication')
    // Later prompts, raw input and new continuable starts stay closed.
    await expect(ctx.subagents.followup(parent, childId, [{ type: 'text', text: 'later' }], { signal: abort.signal } as never)).rejects.toThrow('CLOSED')
    expect(() => child.followup(child.inbox.nextTurn[0]!)).toThrow('CLOSED')
    await expect(ctx.subagents.startContinuable({ provider: 'cont', label: 'd', request: { parent, prompt }, signal: abort.signal })).rejects.toThrow('CLOSED')
  } finally { release.resolve(undefined); abort.abort(); await ctx.fiber.dispose() }
})

it('continuable start OPEN: exactly one initial insertion and one model turn through Activation accounting', async () => {
  const { ctx, parent, adapter } = await harness({ persistence: true })
  try {
    ctx.subagents.registerProvider({ name: 'cont', inheritsParentContext: false, capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }, start: () => { throw new Error('unused') },
      async prepareContinuable() { return {} } })
    const { childId } = await ctx.subagents.startContinuable({ provider: 'cont', label: 'c',
      request: { parent, prompt: [{ type: 'text', text: 'open original' }] }, signal: new AbortController().signal })
    const child = ctx.agents.get(childId)!
    await child.whenIdle()
    await tick()
    expect(adapter.calls).toBe(1)
    expect(child.session.events.filter(event => event.type === 'agent/inbox/spliced' && event.data.inserted.length > 0)).toHaveLength(1)
  } finally { await ctx.fiber.dispose() }
})

it('continuable prepare failure is not join evidence: delegate reservation stays UNKNOWN', async () => {
  const { ctx, parent } = await harness({ persistence: true })
  try {
    ctx.subagents.registerProvider({ name: 'cont', inheritsParentContext: false, capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }, start: () => { throw new Error('unused') },
      async prepareContinuable() { throw new Error('prepare failed') } })
    await expect(ctx.subagents.startContinuable({ provider: 'cont', label: 'c',
      request: { parent, prompt: [] }, signal: new AbortController().signal })).rejects.toThrow('prepare failed')
    await tick()
    expect(pending(ctx)).toContain('delegate')
  } finally { await ctx.fiber.dispose() }
})

it('one-shot failed publication: canonical unclaimed refusal revokes capability; external or pending cleanup stays UNKNOWN', async () => {
  let { ctx, parent } = await harness()
  let captured: ResolvedSubagentStartRequest | undefined
  try {
    // Provider work outside the canonical driver is never attested: UNKNOWN.
    ctx.subagents.registerProvider({ name: 'external', inheritsParentContext: false, capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }, async start() { throw new Error('external backend failed') } })
    await expect(ctx.subagents.start('external', { parent, signal: new AbortController().signal, prompt: [] })).rejects.toThrow('external backend')
    await tick()
    expect(pending(ctx)).toContain('delegate')
    expect(pending(ctx)).toContain('publication')
    await ctx.fiber.dispose()
    ;({ ctx, parent } = await harness())
    // Canonical driver refuses before claim (aborted exact request): unpublished receipt.
    const abort = new AbortController()
    ctx.subagents.registerProvider({ name: 'reject', inheritsParentContext: false, capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }, async start(request) {
      captured = request
      await tick()
      return startInProcessRun(request, {})
    } })
    const refused = ctx.subagents.start('reject', { parent, signal: abort.signal, prompt: [] })
    abort.abort()
    await expect(refused).rejects.toThrow()
    await tick()
    expect(pending(ctx)).toEqual([])
    // Revoked: the stale capability can no longer publish, even while OPEN.
    const cap = captured!.initialAdmission!
    await expect(ctx.agents.create({ sessionId: cap.sessionId, initialAdmission: cap, parentAgent: parent,
      signal: captured!.signal, meta: { parentSession: parent.id } })).rejects.toThrow()
    expect(await ctx.hostAdmission.failure(cap)).toBeUndefined()
    // A forged receipt is not authenticated.
    expect(ctx.hostAdmission.verify({ sessionId: cap.sessionId, outcome: 'unpublished' })).toBe(false)

    // Claimed: the provider gives up while the factory's raw setup is still pending.
    const setupGate = Promise.withResolvers<undefined>()
    ctx.subagents.registerProvider({ name: 'setup-hangs', inheritsParentContext: false, capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }, async start(request) {
      void ctx.agents.create({ sessionId: request.initialAdmission!.sessionId, initialAdmission: request.initialAdmission!,
        parentAgent: request.parent, signal: request.signal, meta: { parentSession: request.parent.id },
        setup: async () => { await setupGate.promise; return undefined } } as never).catch(() => undefined)
      throw new Error('provider gave up')
    } })
    const hanging = ctx.subagents.start('setup-hangs', { parent, signal: new AbortController().signal, prompt: [] })
    await expect(hanging).rejects.toThrow('provider gave up')
    await tick()
    // Claimed publication whose raw setup has not settled: no receipt, both stay pending (UNKNOWN).
    expect(pending(ctx)).toContain('delegate')
    expect(pending(ctx)).toContain('publication')
    setupGate.resolve(undefined)
  } finally { await ctx.fiber.dispose() }
})

it('claimed initial publication whose setup rejects joins after prepared-agent disposal and raw setup settlement', async () => {
  const { ctx, parent } = await harness()
  try {
    const rawSettled = Promise.withResolvers<undefined>()
    let failure: Promise<unknown> | undefined
    ctx.subagents.registerProvider({ name: 'claimed', inheritsParentContext: false, capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }, async start(request) {
      const create = ctx.agents.create({ sessionId: request.initialAdmission!.sessionId, initialAdmission: request.initialAdmission!,
        parentAgent: request.parent, signal: request.signal, meta: { parentSession: request.parent.id },
        setup: () => rawSettled.promise.then(() => { throw new Error('late raw setup failure') }) } as never)
      failure = create.catch(error => error)
      return Promise.reject(await failure)
    } })
    const start = ctx.subagents.start('claimed', { parent, signal: new AbortController().signal, prompt: [] })
    rawSettled.resolve(undefined)
    await expect(start).rejects.toThrow('late raw setup failure')
    await tick(); await tick()
    expect(pending(ctx)).toEqual([])
  } finally { await ctx.fiber.dispose() }
})

it('workflow reservation follows actual WorkerRun join, not bounded public disposal', async () => {
  const { ctx, parent } = await harness()
  const startGate = Promise.withResolvers<undefined>()
  const disposeGate = Promise.withResolvers<undefined>()
  let failDispose = false
  let startEntered = Promise.withResolvers<undefined>()
  let disposeEntered = Promise.withResolvers<undefined>()
  try {
    ctx.subagents.registerProvider({ name: 'slow', inheritsParentContext: false, capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }, async start(request): Promise<SubagentRun> {
      startEntered.resolve(undefined)
      await startGate.promise
      return { id: request.initialAdmission!.sessionId, localAgent: undefined,
        result: new Promise(() => {}),
        dispose: async () => { disposeEntered.resolve(undefined); await disposeGate.promise; if (failDispose) throw new Error('child disposal failed') } }
    } })
    await ctx.plugin(WorkflowEngine, { provider: 'slow', disposeGraceMs: 30 })
    const runOnce = async (fail: boolean) => {
      failDispose = fail
      startEntered = Promise.withResolvers<undefined>()
      disposeEntered = Promise.withResolvers<undefined>()
      const run = ctx.workflowEngine.start({ parent: parent as Agent, meta: { name: 'join', description: 'join' },
        script: "return await agent('pending')" })
      await startEntered.promise
      await run.dispose() // bounded: returns after grace with the provider start still pending
      expect(pending(ctx)).toContain('workflow')
      return run
    }
    await runOnce(false)
    startGate.resolve(undefined)
    await disposeEntered.promise
    expect(pending(ctx)).toContain('workflow') // late run is being disposed; disposal not settled
    disposeGate.resolve(undefined)
    await vi.waitFor(() => expect(pending(ctx)).not.toContain('workflow'))
    expect(ctx.hostAdmission.status().unknown).not.toContain('workflow')

    await runOnce(true)
    await disposeEntered.promise
    // FAILED join: reservation retained AND coverage UNKNOWN.
    await vi.waitFor(() => expect(ctx.hostAdmission.status().unknown).toContain('workflow'))
    expect(pending(ctx)).toContain('workflow')
  } finally { startGate.resolve(undefined); disposeGate.resolve(undefined); await ctx.fiber.dispose() }
})
