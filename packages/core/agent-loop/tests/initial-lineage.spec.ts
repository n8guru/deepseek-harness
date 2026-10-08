/** Exact native receiver + canonical factory, keyless admitted publication and join races. */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentLoop from '../src/index.ts'
import HostMaintenance from '../src/maintenance.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import PtcWorkflowEngine from '../../../workflow/workflow-ptc/src/index.ts'
import { mountWorkflowRuntime } from '../../../workflow/workflow-ptc/tests/setup.ts'

it('publishes only an individually admitted child and immutable input after delayed provider/close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-initial-lineage-'))
  const ctx = new Context()
  const gate = Promise.withResolvers<void>()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
    await ctx.plugin(HostMaintenance)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    const adapter = new MockAdapter([textResponse('accepted')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = await ctx.agents.create({ sessionId: SessionId('original-parent'), agentOptions: { provider: 'mock', model: 'mock' } })
    const entered = Promise.withResolvers<ResolvedSubagentStartRequest>()
    ctx.subagents.registerProvider({
      name: 'delayed-native', inheritsParentContext: false,
      capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      start: async request => { entered.resolve(request); await gate.promise; return startInProcessRun(request, {}) },
    })
    const prompt = [{ type: 'text' as const, text: 'immutable original' }]
    const starting = ctx.subagents.start('delayed-native', { parent: parent.agent, prompt, signal: new AbortController().signal })
    const request = await entered.promise
    const cap = request.initialAdmission!
    expect(cap).toBeDefined()
    const validated = ctx.hostMaintenance.initial(cap, cap.sessionId, parent.agent, false)
    await expect(ctx.agents.create({ sessionId: cap.sessionId, parentAgent: parent.agent, maintenancePermit: validated.ticket })).rejects.toThrow('not general maintenance authority')
    expect(() => ctx.hostMaintenance.assertReceipt(validated.ticket, createUserMessage({ source: { kind: 'user' }, content: prompt }))).toThrow('initial input refused')
    prompt[0]!.text = 'mutation must not gain authority'
    const raceReservation = ctx.hostMaintenance.reserve('delegate', parent.agent.id)
    const raceCap = raceReservation.child!(SessionId('concurrent-child'), createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'one immutable race input' }] }), parent.agent, new AbortController().signal)
    await ctx.hostMaintenance.receive('owner', { action: 'close', runId: 'lineage' })
    await expect(ctx.subagents.start('delayed-native', { parent: parent.agent, prompt, signal: new AbortController().signal })).rejects.toThrow('closed')
    await expect(ctx.agents.create({ sessionId: cap.sessionId, parentAgent: parent.agent, initialAdmission: { ...cap } })).rejects.toThrow('initial admission refused')
    await expect(ctx.agents.create({ sessionId: SessionId('wrong-child'), parentAgent: parent.agent, initialAdmission: cap })).rejects.toThrow('initial admission refused')
    await expect(ctx.agents.create({ sessionId: cap.sessionId, parentAgent: { ...parent.agent }, initialAdmission: cap })).rejects.toThrow('initial admission refused')
    const race = await Promise.allSettled([0, 1].map(() => ctx.agents.create({ sessionId: raceCap.sessionId, parentAgent: parent.agent, initialAdmission: raceCap })))
    expect(race.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(race.filter(result => result.status === 'rejected')).toHaveLength(1)
    const winner = race.find(result => result.status === 'fulfilled')!
    if (winner.status !== 'fulfilled') throw new Error('missing race winner')
    expect(winner.value.agent.inbox.nextTurn.map(message => message.id)).toEqual([raceCap.messageId])
    await winner.value.dispose()
    raceReservation.release()
    gate.resolve()
    const run = await starting
    void run.result.catch(() => {})
    const child = run.localAgent!
    expect(child.id).toBe(cap.sessionId)
    expect(child.inbox.nextTurn).toHaveLength(1)
    expect(child.inbox.nextTurn[0]!.content).toEqual([{ type: 'text', text: 'immutable original' }])
    expect(adapter.requests).toEqual([])
    expect(() => child.followup(createUserMessage({ source: { kind: 'user' }, content: prompt }))).toThrow('closed')
    await expect(ctx.agents.create({ sessionId: child.id, parentAgent: parent.agent, initialAdmission: cap })).rejects.toThrow('initial admission refused')
    await expect(ctx.subagents.start('delayed-native', { parent: child, prompt, signal: new AbortController().signal })).rejects.toThrow('closed')
    const status = await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'lineage' })
    expect(status).toMatchObject({ activity: { activeReservations: [{ kind: 'delegate', sessionId: parent.agent.id }] } })
    await ctx.hostMaintenance.receive('owner', { action: 'release', runId: 'lineage' })
    expect((await run.result).stopReason).toBe('completed')
    expect(adapter.requests).toHaveLength(1)
    expect(child.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === cap.messageId)).toHaveLength(1)
    await run.dispose()
    expect(await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'lineage' })).toMatchObject({ activity: { activeReservations: [] } })
    await parent.dispose()
  } finally { gate.resolve(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('keeps an individually admitted workflow child across close, refuses later workflow/spawn and joins cancellation', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workflow-lineage-'))
  const ctx = new Context()
  const gate = Promise.withResolvers<void>()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
    await ctx.plugin(HostMaintenance)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await mountWorkflowRuntime(ctx, { cwd: root })
    const adapter = new MockAdapter([])
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = await ctx.agents.create({ sessionId: SessionId('workflow-parent'), meta: { cwd: root }, agentOptions: { provider: 'mock', model: 'mock' } })
    const entered = Promise.withResolvers<ResolvedSubagentStartRequest>()
    const published = Promise.withResolvers<void>()
    ctx.subagents.registerProvider({
      name: 'delayed-workflow-native', inheritsParentContext: false,
      capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      start: async request => { entered.resolve(request); await gate.promise; const run = await startInProcessRun(request, {}); published.resolve(); return run },
    })
    await ctx.plugin(PtcWorkflowEngine, { provider: 'delayed-workflow-native' })
    const input = { script: "return await agent('original workflow child')", meta: { name: 'lineage', description: 'keyless native lineage' }, parent: parent.agent }
    const workflow = ctx.workflowEngine.start(input)
    try {
      const request = await Promise.race([entered.promise, workflow.result.then(result => { throw new Error(JSON.stringify(result)) })])
      await ctx.hostMaintenance.receive('owner', { action: 'close', runId: 'workflow' })
      expect(() => ctx.workflowEngine.start(input)).toThrow('closed')
      gate.resolve()
      await published.promise
      const child = ctx.agents.get(request.initialAdmission!.sessionId)!
      expect(child.inbox.nextTurn.map(message => message.id)).toEqual([request.initialAdmission!.messageId])
      await expect(ctx.subagents.start('delayed-workflow-native', { parent: child, prompt: [], signal: new AbortController().signal })).rejects.toThrow('closed')
      expect(adapter.requests).toEqual([])
      workflow.cancel('bounded test cancellation')
      await workflow.dispose()
      expect((await workflow.result).stopReason).toBe('cancelled')
      expect(ctx.agents.get(child.id)).toBeUndefined()
      expect(await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'workflow' })).toMatchObject({ activity: { activeReservations: [] } })
    } finally { gate.resolve(); await workflow.dispose() }
    await parent.dispose()
  } finally { gate.resolve(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('does not retire an aborted remote result or cancellation until the actual dispose join', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-initial-join-'))
  const ctx = new Context()
  const joinGate = Promise.withResolvers<void>()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
    await ctx.plugin(HostMaintenance)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    const parent = await ctx.agents.create({ sessionId: SessionId('join-parent') })
    ctx.subagents.registerProvider({
      name: 'remote-join', inheritsParentContext: false,
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      start: async () => ({ id: SessionId('remote'), localAgent: undefined, result: Promise.resolve({ output: [], stopReason: 'aborted' }), dispose: () => joinGate.promise }),
    })
    const signal = new AbortController()
    const run = await ctx.subagents.start('remote-join', { parent: parent.agent, prompt: [], signal: signal.signal })
    await ctx.hostMaintenance.receive('owner', { action: 'close', runId: 'join' })
    signal.abort('cancel backend')
    expect((await run.result).stopReason).toBe('aborted')
    const disposal = run.dispose()
    expect(await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'join' })).toMatchObject({ activity: { busy: true, activeReservations: [
      { kind: 'delegate', sessionId: parent.agent.id }, { kind: 'publication', sessionId: expect.any(String) },
    ] } })
    joinGate.resolve()
    await disposal
    expect(await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'join' })).toMatchObject({ activity: { activeReservations: [], busy: true } })
    await parent.dispose()
  } finally { joinGate.resolve(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('preserves the compiled continuable input after prepare/close without granting a CLOSED bypass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-continuable-negative-'))
  const ctx = new Context()
  const gate = Promise.withResolvers<void>()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
    await ctx.plugin(HostMaintenance)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    const adapter = new MockAdapter([])
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = await ctx.agents.create({ sessionId: SessionId('continuable-parent'), agentOptions: { provider: 'mock', model: 'mock' } })
    const entered = Promise.withResolvers<void>()
    ctx.subagents.registerProvider({
      name: 'continuable-preparation', inheritsParentContext: false,
      capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      start: async () => { throw new Error('one-shot unused') },
      prepareContinuable: async () => { entered.resolve(); await gate.promise; return {} },
    })
    const starting = ctx.subagents.startContinuable({ provider: 'continuable-preparation', label: 'original continuable task', childId: SessionId('continuable-child'), request: { parent: parent.agent, prompt: [{ type: 'text', text: 'original' }] }, signal: new AbortController().signal })
    void starting.catch(() => {})
    await Promise.race([entered.promise, starting.then(() => { throw new Error('unexpected early acceptance') })])
    await ctx.hostMaintenance.receive('owner', { action: 'close', runId: 'continuable' })
    gate.resolve()
    const accepted = await starting
    const child = ctx.agents.get(accepted.childId)!
    expect(child.inbox.nextTurn.map(message => message.id)).toEqual([accepted.messageId])
    expect(adapter.requests).toEqual([])
    expect(await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'continuable' })).toMatchObject({ activity: { busy: true, activeReservations: [{ kind: 'delegate', sessionId: parent.agent.id }] } })
    await ctx.subagents.drainContinuableChildren(parent.agent, [accepted.childId])
    expect(ctx.agents.get(accepted.childId)).toBeUndefined()
    expect(await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'continuable' })).toMatchObject({ activity: { activeReservations: [] } })
    await parent.dispose()
  } finally { gate.resolve(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
