import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as commandCompact from '../src/index.ts'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import Approval, { setApprovalPolicy, effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.reverse()) await dispose(); cleanup.length = 0 })

class Compact extends BasicCompactionEngine {
  override async summarize() {
    return { summary: [{ type: 'text' as const, text: 'small checkpoint' }], provider: 'mock', model: 'exact' }
  }
}

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'hand-forward-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const baton = join(directory, 'baton.md')
  await writeFile(baton, '# Fixture baton')
  const ctx = new Context()
  for (const plugin of [LlmRuntime, SessionStore, SystemPrompt, ToolRuntime, AgentRegistry, TokenMeter, LocalFileSystem]) {
    await ctx.plugin(plugin)
  }
  await ctx.plugin(JsonlSessionPersistence, { root: join(directory, 'sessions') })
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access', workspaceRoot: directory })
  await ctx.plugin(Approval, { policy: 'ask' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  cleanup.push(() => ctx.fiber.dispose())
  const adapter = new MockAdapter([
    textResponse('history '.repeat(150)),
    toolCallResponse('pass', 'hand_forward', { reason: 'natural break' }),
    textResponse('turn finished'),
    textResponse('bootstrap state'),
    textResponse('child received'),
  ])
  adapter.resolveModel = async (provider, model) => ({ provider, id: model, name: model, context: { contextWindow: 100000 } })
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(Compact, { auto: false })
  const compact = ctx.compaction as Compact
  const compaction = vi.spyOn(compact, 'compactNow')
  const auditDirectory = join(directory, 'audit')
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(commandCompact, { handForward: { auditDirectory, batonPath: baton } })
  const agent = ctx.agentLoop.create(SessionId('same-parent'), { provider: 'mock', model: 'exact' }, { cwd: directory })
  const workspace = await ctx.workspaceRegistry.create(directory)
  await workspace.attachSession(agent.id)
  setSandboxMode(agent.session, 'workspace-write')
  setApprovalPolicy(agent.session, 'never')
  const call = (args: object) => ctx.tools.execute({
    callId: CallId('direct-fixture'), name: 'hand_forward', arguments: args,
    agent, signal: new AbortController().signal,
  })
  const audit = async () => {
    const [name] = await readdir(auditDirectory)
    const state = JSON.parse(await readFile(join(auditDirectory, name!, 'baton-state.json'), 'utf8')) as { records: object[] }
    return state.records.map(record => JSON.stringify(record)).join('\n')
  }
  return { ctx, agent, adapter, compact, compaction, call, audit, baton, workspace, directory }
}

it('defers a real mid-turn tool, compacts same session at idle, and queues bootstrap once', async () => {
  const h = await harness()
  h.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'history '.repeat(150) }], source: { kind: 'user' } }))
  await h.agent.whenIdle()
  const session = h.agent.session
  const options = structuredClone(h.agent.options)
  const header = structuredClone(session.header)
  const before = {
    workspace: h.workspace.id, members: [...h.workspace.sessionIds], cwd: h.agent.session.header.cwd,
    policy: h.ctx.sandboxPolicy.resolve({ session }), approval: effectiveApprovalPolicy(session.events),
    model: session.requestHeader()?.config.model,
  }
  expect(before).toMatchObject({
    members: [h.agent.id], cwd: h.directory, policy: { mode: 'workspace-write' }, approval: 'never', model: 'exact',
  })
  const childAdapter = new MockAdapter(['hang'])
  h.ctx.llm.registerAdapter(['child-mock'], childAdapter)
  const started = await h.ctx.subagents.startContinuable({
    provider: 'spawn', label: 'fixture child', signal: new AbortController().signal,
    request: { parent: h.agent, prompt: [{ type: 'text', text: 'wait for parent compaction' }],
      agentOptions: { provider: 'child-mock', model: 'child' } },
  })
  await vi.waitFor(() => { expect(childAdapter.requests).toHaveLength(1) })
  const child = h.ctx.agents.get(started.childId)!
  let statusAtCompact = ''
  h.compaction.mockImplementation(async (...args) => {
    statusAtCompact = h.agent.status
    expect(session.events.at(-1)?.type).toBe('turn/end')
    const result = await BasicCompactionEngine.prototype.compactNow.apply(h.compact, args)
    expect(session.events.some(event => event.type === 'compaction/summary')).toBe(true)
    await h.ctx.subagents.reportFrom(child, [{ type: 'text', text: 'real late child report' }], {
      delivery: 'quiet', signal: new AbortController().signal,
    })
    return result
  })
  let deferred = false
  h.ctx.on('tools/result', () => {
    deferred = h.compaction.mock.calls.length === 0 && h.agent.status === 'running'
  })
  h.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'pass now' }], source: { kind: 'user' } }))
  await vi.waitFor(async () => { expect(await h.audit()).toContain('bootstrap-queued') })
  await h.agent.whenIdle()
  expect(deferred).toBe(true)
  expect(statusAtCompact).toBe('idle')
  expect(h.compaction).toHaveBeenCalledTimes(1)
  expect(h.compaction.mock.calls[0]?.[0]).toBe(h.agent)
  expect(h.agent.session).toBe(session)
  expect(h.agent.options).toEqual(options)
  expect(session.header).toEqual(header)
  expect(session.events.some(event => event.type === 'compaction/summary')).toBe(true)
  const bootstraps = session.events.filter(event => event.type === 'user/message'
    && event.data.content.some(block => block.type === 'text' && block.text.startsWith('Baton generation start.')))
  expect(bootstraps).toHaveLength(1)
  const log = (await h.audit()).trim().split('\n').map(line => JSON.parse(line) as { baton_sha256: string })
  expect(log[0]).toMatchObject({ generation: 1, session_id: h.agent.id, model: 'exact', status: 'scheduled' })
  expect(log[0]?.baton_sha256).toMatch(/^[0-9a-f]{64}$/u)
  const bootstrap = h.adapter.requests.find(request => JSON.stringify(request.messages).includes('Baton generation start.'))
  expect(JSON.stringify(bootstrap?.messages)).toContain('real late child report')
  expect(session.events.filter(event => event.type === 'user/message' && event.data.source.kind === 'subagent-report')).toHaveLength(1)
  expect({
    workspace: h.workspace.id, members: [...h.workspace.sessionIds], cwd: h.agent.session.header.cwd,
    policy: h.ctx.sandboxPolicy.resolve({ session }), approval: effectiveApprovalPolicy(session.events),
    model: session.requestHeader()?.config.model,
  }).toEqual(before)
  expect(bootstrap?.model).toBe('exact')
  expect(JSON.stringify(bootstrap?.messages)).toContain('workspace-write')
  expect(JSON.stringify(bootstrap?.messages)).toContain('Approval prompts are disabled')
  expect(h.ctx.agents.get(started.childId)).toBe(child)
})

it('refuses a concurrent second call while the first waits for idle', async () => {
  const h = await harness()
  const release = Promise.withResolvers<undefined>()
  const held = h.agent.runMaintenance(() => release.promise)
  const first = await h.call({ reason: 'test' })
  expect(first.isError).not.toBe(true)
  expect(JSON.stringify(first)).toContain('context_capacity')
  const second = await h.call({ reason: 'duplicate' })
  expect(second.isError).toBe(true)
  expect(JSON.stringify(second)).toContain('already pending')
  expect(h.compaction).not.toHaveBeenCalled()
  release.resolve(undefined)
  await held
  await vi.waitFor(async () => { expect(await h.audit()).toContain('bootstrap-queued') })
})

it('records a compaction failure without queueing bootstrap', async () => {
  const h = await harness()
  h.compaction.mockRejectedValue(new Error('summary failed'))
  await h.call({ reason: 'test' })
  await vi.waitFor(async () => { expect(await h.audit()).toContain('failed') })
  expect(h.agent.inbox.hasPending).toBe(false)
  expect(h.adapter.requests).toHaveLength(0)
})

it('rejects unknown exact model capacity', async () => {
  const h = await harness()
  h.adapter.resolveModel = async (provider, model) => ({ provider, id: model, name: model })
  const result = await h.call({ reason: 'test' })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result)).toContain('capacity unavailable')
  expect(h.compaction).not.toHaveBeenCalled()
})

it.each(['missing', 'empty'])('refuses a %s baton without compacting', async (kind) => {
  const h = await harness()
  if (kind === 'empty') await writeFile(h.baton, '  ')
  const result = await h.call({ reason: 'test', baton_path: kind === 'missing' ? h.baton + '.absent' : h.baton })
  expect(result.isError).toBe(true)
  expect(h.compaction).not.toHaveBeenCalled()
})
