/** Actual native services/JSONL, only child/job producers are keyless controlled contracts. */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalJobs from '@deepseek-ai/dsh-jobs-local'
import Subagents from '@deepseek-ai/dsh-subagent'
import PtcWorkflowEngine from '../../../workflow/workflow-ptc/src/index.ts'
import { mountWorkflowRuntime } from '../../../workflow/workflow-ptc/tests/setup.ts'
import AgentLoop from '../src/index.ts'
import HostMaintenance from '../src/maintenance.ts'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'

const microtasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
async function assembly(late = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-global-coverage-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  const preexistingDone = Promise.withResolvers<JobOutcome>()
  if (late) {
    await ctx.plugin(LocalJobs)
    ctx.jobs.attachController('preexisting')
    ctx.jobs.start({kind: 'bash', label: 'before receiver', run: () => ({done: preexistingDone.promise, cancel() {}})})
  }
  await ctx.plugin(HostMaintenance)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const jobs = late ? undefined : await ctx.plugin(LocalJobs)
  ctx.jobs.attachController('fixture')
  await ctx.plugin(Subagents)
  await mountWorkflowRuntime(ctx, { cwd: root })
  const workflow = await ctx.plugin(PtcWorkflowEngine, { provider: 'fixture' })
  const status = async () => (await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'run' }) as unknown as {activity: {busy: boolean; unknownParticipants: string[]; activeReservations: {kind: string}[]}}).activity
  return {ctx, root, jobs, workflow, preexistingDone, status, close: () => ctx.hostMaintenance.receive('owner', {action: 'close', runId: 'run'}),
    dispose: async () => { preexistingDone.resolve({status: 'completed'}); await ctx.fiber.dispose(); await rm(root, {recursive: true, force: true}) }}
}

it('truthfully reports empty supported assembled Host and refuses retrospective coverage of a preexisting producer', async () => {
  for (const late of [false, true]) {
    const h = await assembly(late)
    try {
      await h.close()
      const status = await h.status()
      expect(status.unknownParticipants).toEqual(late ? ['jobs-global'] : [])
      expect(status.busy).toBe(late)
      if (!late) {
        const unsupported = vi.spyOn(h.ctx.sessionPersistence, 'writeJoined').mockReturnValue(undefined)
        expect((await h.status()).unknownParticipants).toEqual(['preclose-publications'])
        unsupported.mockRestore()
        expect((await h.status()).busy).toBe(false)
        const captured = Reflect.get(h.ctx.jobs, 'maintenanceCoverage')
        const otherOwner = h.ctx.hostMaintenance.coverage('job', {})
        Reflect.set(h.ctx.jobs, 'maintenanceCoverage', otherOwner)
        expect((await h.status()).unknownParticipants).toContain('jobs-global')
        Reflect.set(h.ctx.jobs, 'maintenanceCoverage', captured)
        expect((await h.status()).busy).toBe(false)
      }
      if (late) {
        h.preexistingDone.resolve({status: 'completed'})
        await h.preexistingDone.promise
        await microtasks()
        expect((await h.status()).unknownParticipants).toEqual(['jobs-global'])
      }
      expect(() => h.ctx.jobs.start({kind: 'bash', label: 'closed', run: () => { throw new Error('must not run') }})).toThrow('admission closed')
    } finally { await h.dispose() }
  }
})

it('actual buffered durable session writes block idle even for a locally idle native Agent', async () => {
  const h = await assembly()
  try {
    const parent = await h.ctx.agents.create({sessionId: SessionId('durable-parent')})
    await h.ctx.sessions.flush(parent.agent.session)
    await h.close()
    expect(parent.agent.status).toBe('idle')
    parent.agent.session.append('user/message', createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: 'already owned durable record'}]}), {surfaceOp: 'append'})
    expect((await h.status()).unknownParticipants).toContain('preclose-publications')
    await h.ctx.sessions.flush(parent.agent.session)
    expect((await h.status()).unknownParticipants).toEqual([])
    expect((await h.status()).busy).toBe(false)
    await parent.dispose()
  } finally { await h.dispose() }
})

it('cancellation and service withdrawal cannot erase producerDone authority; replacement joins only after old producer settles', async () => {
  const h = await assembly()
  const done = Promise.withResolvers<JobOutcome>()
  try {
    const id = h.ctx.jobs.start({kind: 'bash', label: 'pending', run: () => ({done: done.promise, cancel() {}})})
    await h.close()
    h.ctx.jobs.kill(id)
    expect((await h.status()).unknownParticipants).toEqual(['jobs-global'])
    // Disposer waits actual producerDone, not the killed local record.
    const retiring = h.jobs!.dispose()
    expect((await h.status()).busy).toBe(true)
    done.resolve({status: 'completed'})
    await retiring
    await h.ctx.plugin(LocalJobs)
    const status = await h.status()
    expect(status.unknownParticipants).toEqual([])
    expect(status.activeReservations).toEqual([])
    expect(status.busy).toBe(false)
  } finally { done.resolve({status: 'completed'}); await h.dispose() }
})

it('close during actual delegate provider await preserves old publication; result and provider removal do not substitute for dispose join', async () => {
  const h = await assembly()
  const entered = Promise.withResolvers<void>(), publish = Promise.withResolvers<void>()
  const result = Promise.withResolvers<SubagentResult>(), disposed = Promise.withResolvers<void>()
  try {
    const parent = await h.ctx.agents.create({sessionId: SessionId('parent')})
    await h.ctx.sessions.flush(parent.agent.session)
    const unregister = h.ctx.subagents.registerProvider({name: 'fixture', inheritsParentContext: false,
      capabilities: {agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false},
      async start() { entered.resolve(); await publish.promise; return {id: SessionId('external-child'), localAgent: undefined, result: result.promise, dispose: () => disposed.promise} }})
    const pending = h.ctx.subagents.start('fixture', {parent: parent.agent, signal: new AbortController().signal, prompt: [{type: 'text', text: 'original'}]})
    await entered.promise
    await h.close()
    expect((await h.status()).unknownParticipants).toContain('delegates-global')
    unregister()
    publish.resolve()
    const run = await pending
    result.resolve({output: [], stopReason: 'completed'})
    await run.result
    const retiring = run.dispose()
    expect((await h.status()).unknownParticipants).toContain('delegates-global')
    disposed.resolve()
    await retiring
    await h.ctx.sessions.flush(parent.agent.session) // Durable delegate lifecycle records also belong to publication.
    expect((await h.status()).unknownParticipants).toEqual([])
    expect((await h.status()).busy).toBe(false)
    await expect(h.ctx.subagents.start('fixture', {parent: parent.agent, signal: new AbortController().signal, prompt: []})).rejects.toThrow('admission closed')
    await parent.dispose()
  } finally { publish.resolve(); result.resolve({output: [], stopReason: 'completed'}); disposed.resolve(); await h.dispose() }
})

it('actual workflow result and engine withdrawal retain authority until holder disposal joins', async () => {
  const h = await assembly()
  try {
    const parent = await h.ctx.agents.create({sessionId: SessionId('workflow-parent'), meta: {cwd: h.root}})
    await h.ctx.sessions.flush(parent.agent.session)
    h.ctx.subagents.registerProvider({name: 'fixture', inheritsParentContext: false,
      capabilities: {agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false},
      async start() { throw new Error('pure workflow must not request a child') }})
    const run = h.ctx.workflowEngine.start({parent: parent.agent, meta: {name: 'global-proof', description: 'keyless pure workflow'}, script: 'return 7'})
    await h.close()
    expect((await h.status()).unknownParticipants).toContain('workflows-global')
    expect(await run.result).toMatchObject({stopReason: 'completed', value: 7})
    expect((await h.status()).unknownParticipants).toContain('workflows-global')
    await h.workflow.dispose()
    await h.ctx.plugin(PtcWorkflowEngine, {provider: 'fixture'})
    expect((await h.status()).unknownParticipants).toContain('workflows-global')
    await run.dispose()
    await h.ctx.sessions.flush(parent.agent.session)
    expect((await h.status()).unknownParticipants).toEqual([])
    expect((await h.status()).busy).toBe(false)
    await parent.dispose()
  } finally { await h.dispose() }
})

for (const failClose of [false, true]) it('tracks abandoned real write handle through actual close; failed close remains UNKNOWN ' + failClose, async () => {
  const h = await assembly()
  const entered = Promise.withResolvers<void>(), backend = Promise.withResolvers<void>()
  const closing = Promise.withResolvers<void>(), closeGate = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>()
  const abort = new AbortController()
  const original = h.ctx.sessionPersistence.create.bind(h.ctx.sessionPersistence)
  let actual: Awaited<ReturnType<typeof original>> | undefined
  const spy = vi.spyOn(h.ctx.sessionPersistence, 'create').mockImplementation(async (header, options) => {
    entered.resolve()
    await backend.promise
    const {signal: _signal, ...createOptions} = options ?? {}
    actual = await original(header, createOptions)
    return new Proxy(actual, {get(target, key) {
      if (key === 'close') return async () => {
        closing.resolve()
        await closeGate.promise
        try {
          if (failClose) throw new Error('actual close evidence unavailable')
          await target.close()
        } finally { closed.resolve() }
      }
      return Reflect.get(target, key)
    }})
  })
  try {
    const pending = h.ctx.agents.create({sessionId: SessionId('write-child'), signal: abort.signal})
    await entered.promise
    await h.close()
    abort.abort(new Error('abandon waiter'))
    await expect(pending).rejects.toThrow('abandon waiter')
    expect((await h.status()).unknownParticipants).toContain('preclose-publications')
    backend.resolve()
    await closing.promise
    expect((await h.status()).unknownParticipants).toContain('preclose-publications')
    closeGate.resolve()
    await closed.promise
    await microtasks()
    await microtasks()
    const status = await h.status()
    expect(status.unknownParticipants).toEqual(failClose ? ['preclose-publications'] : [])
    expect(status.busy).toBe(failClose)
  } finally {
    backend.resolve(); closeGate.resolve(); spy.mockRestore()
    await actual?.close()
    await h.dispose()
  }
})

it('cancelled public creation retains actual unfinished setup beyond local rollback until setup settles', async () => {
  const h = await assembly()
  const entered = Promise.withResolvers<void>(), setup = Promise.withResolvers<void>()
  const abort = new AbortController()
  try {
    const pending = h.ctx.agents.create({sessionId: SessionId('setup-child'), signal: abort.signal, setup: async () => {entered.resolve(); await setup.promise}})
    await entered.promise
    await h.close()
    abort.abort(new Error('test cancellation'))
    await expect(pending).rejects.toThrow('test cancellation')
    expect((await h.status()).unknownParticipants).toContain('preclose-publications')
    setup.resolve()
    await setup.promise
    await microtasks()
    expect((await h.status()).unknownParticipants).toEqual([])
    expect((await h.status()).busy).toBe(false)
  } finally { setup.resolve(); await h.dispose() }
})
