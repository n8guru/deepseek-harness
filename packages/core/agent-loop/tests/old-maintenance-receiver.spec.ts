import { it, expect, afterEach, vi } from 'vitest'
import { Service } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { HostCutoff } from '@deepseek-ai/dsh-agent'
import AgentLoop, { OldHostMaintenance } from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function boot(root: string, receiver = true) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
  if (receiver) await ctx.plugin(OldHostMaintenance)
  return ctx
}

it('durable owner-bound CLOSED survives restart; release is durable and effective only at next boot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'step73-old-maint-'))
  roots.push(root)
  let ctx = await boot(root)
  try {
    expect(ctx.hostAdmission.open).toBe(true)
    const closed = await ctx.hostMaintenance.receive('owner-a', { runId: 'r1', action: 'close' })
    expect(closed.run).toEqual({ owner: 'owner-a', runId: 'r1', phase: 'closed' })
    expect(ctx.hostAdmission.open).toBe(false)
    // Body cannot confer owner authority; other owners/runs are refused.
    await expect(ctx.hostMaintenance.receive('owner-a', { runId: 'r1', action: 'status', owner: 'owner-b' })).rejects.toThrow('refused')
    await expect(ctx.hostMaintenance.receive('owner-b', { runId: 'r1', action: 'status' })).rejects.toThrow('another owner')
    await expect(ctx.hostMaintenance.receive('owner-a', { runId: 'r2', action: 'release' })).rejects.toThrow('another owner')
  } finally { await ctx.fiber.dispose() }

  ctx = await boot(root)
  try {
    expect(ctx.hostAdmission.open).toBe(false)
    expect(() => ctx.agentLoop.create(SessionId('after-restart'))).toThrow('CLOSED')
    const status = await ctx.hostMaintenance.receive('owner-a', { runId: 'r1', action: 'status' })
    expect(status.cutoff.open).toBe(false)
    const released = await ctx.hostMaintenance.receive('owner-a', { runId: 'r1', action: 'release' })
    expect(released.run?.phase).toBe('released')
    expect(ctx.hostAdmission.open).toBe(false) // no live reopen authority
    await expect(ctx.hostMaintenance.receive('owner-a', { runId: 'r1', action: 'close' })).rejects.toThrow('already released')
  } finally { await ctx.fiber.dispose() }

  ctx = await boot(root)
  try {
    expect(ctx.hostAdmission.open).toBe(true)
  } finally { await ctx.fiber.dispose() }
})

it('a failed durable close append keeps the cutoff closed and poisons the receiver', async () => {
  const root = mkdtempSync(join(tmpdir(), 'step73-old-maint-'))
  roots.push(root)
  const ctx = await boot(root)
  try {
    ctx.sessionPersistence.append = async () => { throw new Error('disk full') }
    await expect(ctx.hostMaintenance.receive('owner-a', { runId: 'r1', action: 'close' })).rejects.toThrow('disk full')
    expect(ctx.hostAdmission.open).toBe(false)
    await expect(ctx.hostMaintenance.receive('owner-a', { runId: 'r1', action: 'status' })).rejects.toThrow('poisoned')
  } finally { await ctx.fiber.dispose() }
})

it('replay hold refuses admission until released and never reopens an explicit close', () => {
  const cutoff = new HostCutoff()
  const release = cutoff.hold()
  expect(cutoff.open).toBe(false)
  expect(() => cutoff.reserve('job')).toThrow('CLOSED')
  release(); release()
  expect(cutoff.open).toBe(true)
  cutoff.close()
  cutoff.hold()()
  expect(cutoff.open).toBe(false)
})

it('snapshots queued input and returned state; released identities remain retired across later runs and replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'step73-old-maint-'))
  roots.push(root)
  let ctx = await boot(root)
  try {
    const command = { runId: 'first', action: 'close' }
    const pending = ctx.hostMaintenance.receive('owner', command)
    command.runId = 'mutated'
    const result = await pending
    expect(result.run?.runId).toBe('first')
    Object.assign(result.run!, { owner: 'attacker', phase: 'released' })
    expect((await ctx.hostMaintenance.receive('owner', { runId: 'first', action: 'status' })).run?.phase).toBe('closed')
    await ctx.hostMaintenance.receive('owner', { runId: 'first', action: 'release' })
    await ctx.hostMaintenance.receive('owner', { runId: 'second', action: 'close' })
    await ctx.hostMaintenance.receive('owner', { runId: 'second', action: 'release' })
    await expect(ctx.hostMaintenance.receive('owner', { runId: 'first', action: 'close' })).rejects.toThrow('already released')
  } finally { await ctx.fiber.dispose() }
  ctx = await boot(root)
  try {
    await expect(ctx.hostMaintenance.receive('owner', { runId: 'first', action: 'close' })).rejects.toThrow('already released')
  } finally { await ctx.fiber.dispose() }
})

it('lost close/release replies are idempotent, including release retries after a newer run and restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'step73-old-maint-'))
  roots.push(root)
  let ctx = await boot(root)
  const command = (action: string) => ({ runId: 'first', action })
  try {
    const append = vi.spyOn(ctx.sessionPersistence, 'append')
    const closes = await Promise.all([0, 1].map(() => ctx.hostMaintenance.receive('owner', command('close'))))
    expect(closes[0]).toEqual(closes[1])
    expect(append).toHaveBeenCalledTimes(1)
    const releases = await Promise.all([0, 1].map(() => ctx.hostMaintenance.receive('owner', command('release'))))
    expect(releases[0]).toEqual(releases[1])
    expect(append).toHaveBeenCalledTimes(2)
    await ctx.hostMaintenance.receive('owner', { runId: 'second', action: 'close' })
    expect((await ctx.hostMaintenance.receive('owner', command('release'))).run).toEqual({
      owner: 'owner', runId: 'first', phase: 'released',
    })
    expect((await ctx.hostMaintenance.receive('owner', { runId: 'second', action: 'status' })).run?.phase).toBe('closed')
    expect(append).toHaveBeenCalledTimes(3)
    await expect(ctx.hostMaintenance.receive('forged-owner', command('release'))).rejects.toThrow('another owner')
  } finally { await ctx.fiber.dispose() }
  ctx = await boot(root)
  try {
    const append = vi.spyOn(ctx.sessionPersistence, 'append')
    expect((await ctx.hostMaintenance.receive('owner', command('release'))).run?.phase).toBe('released')
    expect(append).not.toHaveBeenCalled()
    expect(ctx.hostAdmission.open).toBe(false)
    expect((await ctx.hostMaintenance.receive('owner', { runId: 'second', action: 'status' })).run?.phase).toBe('closed')
  } finally { await ctx.fiber.dispose() }
})

it('failed and pending replay both hold admission; commands cannot race replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'step73-old-maint-'))
  roots.push(root)
  const ctx = await boot(root, false)
  const replay = Promise.withResolvers<never>()
  vi.spyOn(ctx.sessionPersistence, 'list').mockImplementation(() => replay.promise)
  const receiver = new OldHostMaintenance(ctx)
  const initialized = receiver[Service.init]()
  try {
    expect(ctx.hostAdmission.open).toBe(false)
    await expect(receiver.receive('owner', { runId: 'r', action: 'close' })).rejects.toThrow('not ready')
    replay.reject(new Error('replay failed'))
    await expect(initialized).rejects.toThrow('replay failed')
    expect(() => ctx.agentLoop.create(SessionId('forbidden'))).toThrow('CLOSED')
  } finally { await ctx.fiber.dispose() }
})

it.each([
  { version: 1, revision: 2, active: { owner: 'owner', runId: 'r', phase: 'closed' } },
  { version: 1, revision: 1, active: { owner: 'owner', runId: 'r', phase: 'released' } },
  { version: 1, revision: 1, active: { owner: 'owner', runId: 'r', phase: 'closed', extra: true } },
])('corrupt durable revisions cannot release the boot hold: %j', async (data) => {
  const root = mkdtempSync(join(tmpdir(), 'step73-old-maint-'))
  roots.push(root)
  let ctx = await boot(root, false)
  const id = SessionId('old-host-maintenance-control')
  await ctx.sessionPersistence.create({ id, version: 0, createdAt: Date.now() })
  await ctx.sessionPersistence.append(id, [{ type: 'host/maintenance', seq: 0, time: Date.now(), data } as never])
  await ctx.fiber.dispose()
  ctx = await boot(root, false)
  const receiver = new OldHostMaintenance(ctx)
  try {
    await expect(receiver[Service.init]()).rejects.toThrow('invalid old maintenance')
    expect(ctx.hostAdmission.open).toBe(false)
    await expect(receiver.receive('owner', { runId: 'r', action: 'release' })).rejects.toThrow('not ready')
  } finally { await ctx.fiber.dispose() }
})

it('teardown waits for the durable append and leaves admission held', async () => {
  const root = mkdtempSync(join(tmpdir(), 'step73-old-maint-'))
  roots.push(root)
  const ctx = await boot(root)
  const gate = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  const append = ctx.sessionPersistence.append.bind(ctx.sessionPersistence)
  vi.spyOn(ctx.sessionPersistence, 'append').mockImplementation(async (...args) => {
    entered.resolve(undefined)
    await gate.promise
    await append(...args)
  })
  const cutoff = ctx.hostAdmission
  const close = ctx.hostMaintenance.receive('owner', { runId: 'r', action: 'close' })
  // Observe the rejection too: Cordis may deactivate dependencies during teardown.
  const settled = close.catch(error => error)
  await entered.promise
  let disposed = false
  const disposal = ctx.fiber.dispose().then(() => { disposed = true })
  try {
    await new Promise(resolve => setImmediate(resolve))
    expect(disposed).toBe(false)
  } finally {
    gate.resolve(undefined)
    await settled
    await disposal
  }
  expect(cutoff.open).toBe(false)
})
