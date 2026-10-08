/** Native compiler/acceptance/settlement races, genuine Host admission and JSONL, keyless LLM. */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { Agent, HostInitialAdmission } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { markAdjacentAgentSendMessageTool } from '../../../subagent/subagent/src/internal.ts'
import AgentLoop from '../src/index.ts'
import HostMaintenance from '../src/maintenance.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

it.each([
  { phase: 'prepare', guidance: true },
  { phase: 'materialize', guidance: true },
  { phase: 'image', guidance: true },
  { phase: 'prepare', guidance: false },
])('compiles once after actual composition, closes during $phase, guidance=$guidance', async ({ phase, guidance }) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-continuable-compiler-'))
  const ctx = new Context()
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
    await ctx.plugin(HostMaintenance)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    ctx.tools.register(markAdjacentAgentSendMessageTool(defineTool({
      name: 'send_message', description: 'standard adjacent-Agent marker', parameters: {},
      output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [{ type: 'text', text: 'unused' }] },
      execute: () => Promise.resolve({}),
    })))
    const adapter = new MockAdapter([textResponse('original result')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = await ctx.agents.create({ sessionId: SessionId('compiler-parent'), agentOptions: { provider: 'mock', model: 'mock' } })
    parent.agent.inbox.notifications!.setFocus(true) // independent settlement notice must not create a parent turn
    let cap: HostInitialAdmission | undefined
    const compile = vi.spyOn(ctx.hostMaintenance, 'compileInitial')
    let imageReading = false
    const image = vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation(async () => {
      if (phase === 'image' && !imageReading) { imageReading = true; entered.resolve(); await gate.promise }
      return { inputModalities: ['text', 'image'] } as never
    })
    ctx.on('agent/created', async ({ agent }) => {
      if (agent.id !== SessionId('compiler-child')) return
      if (phase === 'materialize') { entered.resolve(); await gate.promise }
    })
    ctx.subagents.registerProvider({
      name: 'compiler-provider', inheritsParentContext: false,
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      start: async () => { throw new Error('one-shot unused') },
      prepareContinuable: async () => { if (phase === 'prepare') { entered.resolve(); await gate.promise }; return {} },
    })
    const original = [{ type: 'text' as const, text: 'immutable original' }, { type: 'image' as const, attachment: { attachmentId: 'compiler-image' as never, mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 } }]
    const spec = { provider: 'compiler-provider', label: 'compiler task', childId: SessionId('compiler-child'), request: { parent: parent.agent, prompt: original, ...(guidance ? {} : { toolFilter: { deny: ['send_message'] } }) }, signal: new AbortController().signal }
    const starting = ctx.subagents.startContinuable(spec)
    void starting.catch(() => {})
    await Promise.race([entered.promise, starting.then(() => { throw new Error('accepted before expected gate') })])
    if (phase === 'image') {
      const before = compile.mock.results[0]!.value as ReturnType<HostMaintenance['compileInitial']>
      const authority = compile.mock.calls[0]![0]
      const child = ctx.agents.get(authority.sessionId)!
      expect(() => child.followup({ ...before.message, content: [{ type: 'text', text: 'mutated before acceptance' }] }, authority)).toThrow('compiled initial input refused')
      expect(() => ctx.hostMaintenance.compileInitial(authority, child)).toThrow('compiler consumed')
      expect(() => ctx.hostMaintenance.compileInitial({ ...authority }, child)).toThrow('compiler refused')
    }
    await ctx.hostMaintenance.receive('owner', { action: 'close', runId: 'compiler' })
    spec.provider = 'late invalid provider'
    spec.signal = new AbortController().signal
    if (original[0]?.type === 'text') original[0].text = 'late mutation denied'
    gate.resolve()
    const accepted = await starting
    const child = ctx.agents.get(accepted.childId)!
    cap = compile.mock.calls[0]![0]
    const receipt = child.inbox.notifications!.receipt('native:admitted-child', accepted.messageId)!
    expect(receipt.id).toBe(cap.messageId)
    expect(receipt.content[0]).toEqual({ type: 'text', text: 'immutable original' })
    expect(receipt.content.filter(block => block.type === 'text' && block.text.startsWith('Your parent agent id is '))).toHaveLength(guidance ? 1 : 0)
    expect(child.inbox.nextTurn.map(message => message.id)).toEqual([accepted.messageId])
    expect(parent.agent.session.snapshotEvents().filter(event => event.type === 'subagent/catalog' && event.data.childId === accepted.childId)).toHaveLength(1)
    expect(adapter.requests).toEqual([])
    expect(image).toHaveBeenCalled()
    expect(compile.mock.calls.filter((call, index) => call[2] === undefined && compile.mock.results[index]?.type === 'return')).toHaveLength(1)
    expect(() => ctx.hostMaintenance.compileInitial(cap!, child)).toThrow('compiler refused')
    expect(() => child.followup(receipt, cap)).toThrow()
    expect(() => child.followup({ ...receipt, content: [{ type: 'text', text: 'arbitrary replacement' }] }, cap)).toThrow()
    expect(() => child.followup(receipt, { ...cap! })).toThrow('compiler refused')
    expect(() => child.followup(createUserMessage({ source: { kind: 'user' }, content: [] }))).toThrow('closed')
    const read = await ctx.sessionPersistence.open(accepted.childId, 'read')
    try {
      const durable = await read.read()
      expect(durable.events.filter(event => event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.id === accepted.messageId))).toHaveLength(1)
    } finally { await read.close() }
    image.mockRestore()
    await ctx.hostMaintenance.receive('owner', { action: 'release', runId: 'compiler' })
    await child.whenIdle()
    expect(child.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === accepted.messageId)).toHaveLength(1)
    expect(adapter.requests).toHaveLength(1)
    await ctx.subagents.drainContinuableChildren(parent.agent, [accepted.childId])
    expect(ctx.agents.get(accepted.childId)).toBeUndefined()
    expect(await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'compiler' })).toMatchObject({ activity: { activeReservations: [] } })
    await parent.dispose()
  } finally { gate.resolve(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it.each(['unsupported-image', 'cancel'] as const)('retains authority until actual child handle close after %s during image check', async reason => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-continuable-join-'))
  const ctx = new Context()
  const imageGate = Promise.withResolvers<void>()
  const readingImage = Promise.withResolvers<void>()
  const joinGate = Promise.withResolvers<void>()
  const joining = Promise.withResolvers<void>()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
    await ctx.plugin(HostMaintenance)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    const adapter = new MockAdapter([])
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = await ctx.agents.create({ sessionId: SessionId('failure-parent'), agentOptions: { provider: 'mock', model: 'mock' } })
    const actualCreate = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
    vi.spyOn(ctx.sessionPersistence, 'create').mockImplementation(async (...args) => {
      const handle = await actualCreate(...args)
      const actualClose = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => { joining.resolve(); await joinGate.promise; await actualClose() })
      return handle
    })
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation(async () => {
      readingImage.resolve(); await imageGate.promise
      return { inputModalities: reason === 'cancel' ? ['text', 'image'] : ['text'] } as never
    })
    ctx.subagents.registerProvider({
      name: 'failure-provider', inheritsParentContext: false,
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      start: async () => { throw new Error('one-shot unused') }, prepareContinuable: async () => ({}),
    })
    const controller = new AbortController()
    const spec = { provider: 'failure-provider', label: 'failure task', childId: SessionId('failure-child'), request: { parent: parent.agent, prompt: [{ type: 'image' as const, attachment: { attachmentId: 'failure-image' as never, mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 } }] }, signal: controller.signal }
    const starting = ctx.subagents.startContinuable(spec)
    const outcome = starting.then(() => undefined, error => error)
    await Promise.race([readingImage.promise, outcome.then(error => { throw error ?? new Error('unexpected early acceptance') })])
    await ctx.hostMaintenance.receive('owner', { action: 'close', runId: 'failure' })
    spec.signal = new AbortController().signal
    if (reason === 'cancel') controller.abort(new Error('original signal cancelled'))
    imageGate.resolve()
    await joining.promise
    let settled = false
    void outcome.then(() => { settled = true })
    expect(settled).toBe(false)
    expect(await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'failure' })).toMatchObject({ activity: { busy: true, activeReservations: [
      { kind: 'delegate', sessionId: parent.agent.id }, { kind: 'publication', sessionId: 'failure-child' },
    ] } })
    expect(adapter.requests).toEqual([])
    expect(ctx.agents.get(SessionId('failure-child'))!.inbox.nextTurn).toEqual([])
    expect(parent.agent.session.snapshotEvents().filter(event => event.type === 'subagent/catalog')).toEqual([])
    joinGate.resolve()
    const error = await outcome
    expect(error).toBeDefined()
    if (reason === 'unsupported-image') expect(error).toMatchObject({ code: 'MODEL_DOES_NOT_SUPPORT_IMAGES' })
    else expect(String(error)).toContain('original signal cancelled')
    expect(ctx.agents.get(SessionId('failure-child'))).toBeUndefined()
    expect(await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'failure' })).toMatchObject({ activity: { activeReservations: [], busy: true } })
    await parent.dispose()
  } finally { imageGate.resolve(); joinGate.resolve(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it.each(['throw', 'identity'] as const)('consumes a failed native compiler once (%s), with no raw-input fallback', async failure => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-compiler-once-'))
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
    await ctx.plugin(HostMaintenance)
    await ctx.plugin(AgentLoop, { agents: [] })
    const parent = await ctx.agents.create({ sessionId: SessionId('once-parent') })
    const reservation = ctx.hostMaintenance.reserve('delegate', parent.agent.id)
    const original = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'immutable request' }] })
    const compiler = vi.fn((_child: Agent, message: ReturnType<typeof createUserMessage>) => {
      if (failure === 'throw') throw new Error('compiler failure')
      return { ...message, id: MessageId('wrong-identity') }
    })
    const cap = reservation.child!(SessionId('once-child'), original, parent.agent, new AbortController().signal, compiler)
    await ctx.hostMaintenance.receive('owner', { action: 'close', runId: 'once' })
    const child = await ctx.agents.create({ sessionId: cap.sessionId, parentAgent: parent.agent, initialAdmission: cap })
    expect(() => ctx.hostMaintenance.compileInitial(cap, child.agent)).toThrow(failure === 'throw' ? 'compiler failure' : 'identity refused')
    expect(() => ctx.hostMaintenance.compileInitial(cap, child.agent)).toThrow('compiler consumed')
    expect(() => child.agent.followup(original, cap)).toThrow('compiled initial input refused')
    expect(compiler).toHaveBeenCalledTimes(1)
    expect(child.agent.inbox.nextTurn).toEqual([])
    await child.dispose()
    expect(await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'once' })).toMatchObject({ activity: { activeReservations: [], busy: true } })
    await parent.dispose()
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
