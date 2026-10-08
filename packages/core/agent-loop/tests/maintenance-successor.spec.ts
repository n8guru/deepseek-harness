/** Production maintenanceSuccessorSetup composer: real native control log, real Agent lifecycle, mock model. */
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import AgentLoop from '../src/index.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import HostMaintenance from '../src/maintenance.ts'
import MaintenanceSuccessorComposer from '../src/maintenance-successor.ts'
import type { MaintenanceLaunchConfig } from '../src/maintenance.ts'

async function host(root: string, launch: MaintenanceLaunchConfig, adapter: MockAdapter, presets?: object) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
  await ctx.plugin(HostMaintenance, { successor: launch })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  if (presets !== undefined) ctx.provide('agentPresets', presets)
  await ctx.plugin(MaintenanceSuccessorComposer)
  return ctx
}

const baton = JSON.stringify({ project: 'p', release: 'r', cursor: 'c', evidence_refs: ['e'], obligations: ['o'], lineage: { run_id: 'run' } })
const start = { action: 'start-successor', runId: 'run', baton, batonDigest: createHash('sha256').update(baton).digest('hex') } as const

it('starts exactly one persistent successor through the shipped composer and returns the same id after Host restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-successor-composer-'))
  const launch = { owner: 'owner', agentPreset: 'default', provider: 'mock', model: 'mock', cwd: root }
  const first = new MockAdapter([textResponse('successor resumed the baton')])
  let ctx = await host(root, launch, first)
  try {
    expect(ctx.get('maintenanceSuccessorSetup')).toBeInstanceOf(MaintenanceSuccessorComposer)
    await ctx.hostMaintenance.receive('owner', { action: 'close', runId: 'run' })
    const started = await ctx.hostMaintenance.receive('owner', start)
    expect(['started', 'complete']).toContain(started.successor?.status)
    const id = started.successor!.sessionId
    const again = await ctx.hostMaintenance.receive('owner', start)
    expect(again.successor?.sessionId).toBe(id)
    expect(first.requests).toHaveLength(1)
    const events = ctx.agents.get(SessionId(id))!.session.snapshotEvents()
    expect(events.filter(event => event.type === 'host/maintenance-successor')).toHaveLength(1)
    expect(events.filter(event => event.type === 'user/message' && event.data.id === started.successor!.intent!.messageId)).toHaveLength(1)
    await ctx.fiber.dispose()
    const restarted = new MockAdapter([])
    ctx = await host(root, launch, restarted)
    expect(ctx.hostMaintenance.open).toBe(false)
    const retried = await ctx.hostMaintenance.receive('owner', start)
    expect(retried.successor).toEqual(again.successor)
    expect(restarted.requests).toHaveLength(0)
    await ctx.hostMaintenance.receive('owner', { action: 'release', runId: 'run' })
    expect(ctx.hostMaintenance.open).toBe(true)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it.each([
  ['unregistered provider route', { provider: 'absent' }, 'provider route not registered'],
  ['missing workspace', { cwd: '/nonexistent-dsh-successor-workspace' }, 'not an existing directory'],
  ['named preset without a registry', { agentPreset: 'cordis' }, 'requires an agent preset registry'],
])('refuses a %s before any child effect and keeps the intent retryable', async (_label, override, message) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-successor-refuse-'))
  const launch = { owner: 'owner', agentPreset: 'default', provider: 'mock', model: 'mock', cwd: root, ...override }
  const adapter = new MockAdapter([])
  const ctx = await host(root, launch, adapter)
  try {
    await ctx.hostMaintenance.receive('owner', { action: 'close', runId: 'run' })
    await expect(ctx.hostMaintenance.receive('owner', start)).rejects.toThrow(message)
    const status = await ctx.hostMaintenance.receive('owner', { action: 'status', runId: 'run' })
    expect(status.successor?.status).toBe('accepted-intent')
    expect(ctx.agents.get(SessionId(status.successor!.sessionId))).toBeUndefined()
    expect(adapter.requests).toHaveLength(0)
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

it('mounts the exact preset through the canonical registry and refuses a broken one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-successor-preset-'))
  const mounted: string[] = []
  let broken: string | undefined = 'activation failed'
  const presets = {
    resolve: async (id?: string) => ({ id: id!, ...(broken === undefined ? {} : { broken }) }),
    mount: async (_ctx: Context, id?: string) => { mounted.push(id!); return { id: id! } },
  }
  const launch = { owner: 'owner', agentPreset: 'cordis', provider: 'mock', model: 'mock', cwd: root }
  const adapter = new MockAdapter([textResponse('ok')])
  const ctx = await host(root, launch, adapter, presets)
  try {
    await ctx.hostMaintenance.receive('owner', { action: 'close', runId: 'run' })
    await expect(ctx.hostMaintenance.receive('owner', start)).rejects.toThrow('preset unavailable')
    expect(mounted).toEqual([])
    broken = undefined
    const started = await ctx.hostMaintenance.receive('owner', start)
    expect(['started', 'complete']).toContain(started.successor?.status)
    expect(mounted).toEqual(['cordis'])
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
