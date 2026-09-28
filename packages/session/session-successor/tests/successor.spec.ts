/**
 * Session-successor lineage: readiness gating (completed first turn + pointer
 * naming the exact successor), idempotency by handoff id, refusal classes
 * (self-link, conflict, cycle, wrong workspace, not live / not ready), the
 * `successor` projection unit (live feed and cold restore — the archive /
 * reload replay path), and the invariant companion.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionSuccessorService, {
  foldSuccessor, hasCompletedTurn, SessionSuccessorError,
  type RecordSuccessorRequest,
} from '@deepseek-ai/dsh-session-successor'

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionSuccessorService)
  return ctx
}

function session(ctx: Context, id: string, cwd = '/work/forge-agent-os'): Session {
  return ctx.sessions.create(SessionId(id), { meta: { cwd } })
}

/** Commit one turn on the successor with the given end reason. */
function turn(target: Session, kind: 'completed' | 'blocked' | 'open'): void {
  const n = target.events.filter(event => event.type === 'turn/start').length + 1
  target.append('turn/start', { turn: n })
  if (kind === 'open') return
  target.append('turn/end', { turn: n, reason: kind === 'completed' ? { kind: 'completed' } : { kind: 'blocked' } })
}

function claim(successor: string, overrides: Partial<RecordSuccessorRequest> = {}): RecordSuccessorRequest {
  return { successorSessionId: successor, successorGeneration: 11, handoffId: 'h-10-11', pointerSessionId: successor, ...overrides }
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(SessionSuccessorError)
    return (error as SessionSuccessorError).code
  }
  throw new Error('expected a refusal')
}

describe('readiness', () => {
  it('refuses a created-but-idle successor, a running turn, and a failed turn; old log stays unchanged', async () => {
    const ctx = await harness()
    const old = session(ctx, 'gen-10')
    const next = session(ctx, 'gen-11')
    expect(await refusal(ctx.sessionSuccessor.record(old, claim('gen-11')))).toBe('successor-not-ready')
    turn(next, 'open')
    expect(await refusal(ctx.sessionSuccessor.record(old, claim('gen-11')))).toBe('successor-not-ready')
    turn(next, 'blocked')
    expect(await refusal(ctx.sessionSuccessor.record(old, claim('gen-11')))).toBe('successor-not-ready')
    expect(foldSuccessor(old.events)).toBeNull()
    expect(ctx.sessionProjections.snapshot(old).values.successor).toBeNull()
  })

  it('refuses when the pointer names another session or nothing', async () => {
    const ctx = await harness()
    const old = session(ctx, 'gen-10')
    const next = session(ctx, 'gen-11')
    turn(next, 'completed')
    expect(await refusal(ctx.sessionSuccessor.record(old, claim('gen-11', { pointerSessionId: 'gen-10' })))).toBe('pointer-mismatch')
    expect(await refusal(ctx.sessionSuccessor.record(old, claim('gen-11', { pointerSessionId: null })))).toBe('pointer-mismatch')
    // A live resolver overrides the caller's claim.
    const resolvePointer = vi.fn(() => Promise.resolve('gen-12'))
    expect(await refusal(ctx.sessionSuccessor.record(old, claim('gen-11'), { resolvePointer }))).toBe('pointer-mismatch')
    expect(resolvePointer).toHaveBeenCalledOnce()
    expect(foldSuccessor(old.events)).toBeNull()
  })

  it('records exactly one durable fact once the first turn completed and the pointer names the successor', async () => {
    const ctx = await harness()
    const old = session(ctx, 'gen-10')
    const next = session(ctx, 'gen-11')
    turn(next, 'completed')
    const flushed: string[] = []
    ctx.on('session/flush', (s: Session) => { flushed.push(s.id) })
    const result = await ctx.sessionSuccessor.record(old, claim('gen-11'))
    expect(result.status).toBe('recorded')
    expect(result.fact).toEqual({ successorSessionId: 'gen-11', successorGeneration: 11, handoffId: 'h-10-11' })
    // Successor readiness is flushed before the check; the old log is flushed before returning (persist before archive).
    expect(flushed).toEqual(['gen-11', 'gen-10'])
    expect(old.events.filter(event => event.type === 'session/successor')).toHaveLength(1)
    expect(ctx.sessionProjections.snapshot(old).values.successor).toEqual(result.fact)
    expect(ctx.sessionProjections.snapshot(next).values.successor).toBeNull()
  })
})

describe('idempotency and refusals', () => {
  it('replays the same handoff as existing, concurrently and sequentially', async () => {
    const ctx = await harness()
    const old = session(ctx, 'gen-10')
    turn(session(ctx, 'gen-11'), 'completed')
    const [a, b] = await Promise.all([
      ctx.sessionSuccessor.record(old, claim('gen-11')),
      ctx.sessionSuccessor.record(old, claim('gen-11')),
    ])
    expect([a.status, b.status]).toEqual(['recorded', 'existing'])
    const again = await ctx.sessionSuccessor.record(old, claim('gen-11'))
    expect(again).toEqual({ status: 'existing', fact: a.fact, seq: a.seq })
    expect(old.events.filter(event => event.type === 'session/successor')).toHaveLength(1)
  })

  it('rejects a conflicting successor or a different handoff for the same target', async () => {
    const ctx = await harness()
    const old = session(ctx, 'gen-10')
    turn(session(ctx, 'gen-11'), 'completed')
    turn(session(ctx, 'gen-11b'), 'completed')
    await ctx.sessionSuccessor.record(old, claim('gen-11'))
    expect(await refusal(ctx.sessionSuccessor.record(old, claim('gen-11b')))).toBe('conflict')
    expect(await refusal(ctx.sessionSuccessor.record(old, claim('gen-11', { handoffId: 'other' })))).toBe('conflict')
    expect(await refusal(ctx.sessionSuccessor.record(old, claim('gen-11', { successorGeneration: 12 })))).toBe('conflict')
  })

  it('rejects self-links, cycles, wrong workspaces, dead successors and malformed claims', async () => {
    const ctx = await harness()
    const a = session(ctx, 'a')
    const b = session(ctx, 'b')
    turn(a, 'completed')
    turn(b, 'completed')
    expect(await refusal(ctx.sessionSuccessor.record(a, claim('a')))).toBe('self-link')
    await ctx.sessionSuccessor.record(a, claim('b', { handoffId: 'a-b' }))
    expect(await refusal(ctx.sessionSuccessor.record(b, claim('a', { handoffId: 'b-a' })))).toBe('cycle')

    const elsewhere = session(ctx, 'elsewhere', '/work/other-repo')
    turn(elsewhere, 'completed')
    const c = session(ctx, 'c')
    expect(await refusal(ctx.sessionSuccessor.record(c, claim('elsewhere')))).toBe('wrong-workspace')
    const d = session(ctx, 'd')
    turn(d, 'completed')
    expect(await refusal(ctx.sessionSuccessor.record(c, claim('d'), { sameWorkspace: () => false }))).toBe('wrong-workspace')
    expect(await refusal(ctx.sessionSuccessor.record(c, claim('ghost')))).toBe('successor-not-live')
    expect(await refusal(ctx.sessionSuccessor.record(c, claim('d', { successorGeneration: 0 })))).toBe('invalid')
    expect(await refusal(ctx.sessionSuccessor.record(c, claim('d', { handoffId: ' ' })))).toBe('invalid')
    expect(foldSuccessor(c.events)).toBeNull()
  })

  it('rejects an old session that is no longer live', async () => {
    const ctx = await harness()
    const foreign = session(await harness(), 'gen-10')
    turn(session(ctx, 'gen-11'), 'completed')
    const old = foreign
    expect(await refusal(ctx.sessionSuccessor.record(old, claim('gen-11')))).toBe('old-not-live')
  })
})

describe('projection replay (archive / reload / reconnect)', () => {
  it('folds the fact from a stored log with no live session (cold restore)', async () => {
    const ctx = await harness()
    const old = session(ctx, 'gen-10')
    turn(session(ctx, 'gen-11'), 'completed')
    await ctx.sessionSuccessor.record(old, claim('gen-11'))
    const stored = [...old.events]
    const restored = ctx.sessionProjections.restore({}, stored, 0)
    expect(restored.snapshot.values.successor).toEqual({ successorSessionId: 'gen-11', successorGeneration: 11, handoffId: 'h-10-11' })
    // A checkpoint row round-trips (the persisted projection cache served by session.list for archived rows).
    expect(ctx.sessionProjections.viewCheckpoint(restored.checkpoint).successor).toEqual(restored.snapshot.values.successor)
  })

  it('emits exactly one change-feed value for the old session', async () => {
    const ctx = await harness()
    const seen: unknown[] = []
    ctx.sessionProjections.onChanged((s, key, value) => { if (key === 'successor') seen.push([s.id, value]) })
    const old = session(ctx, 'gen-10')
    turn(session(ctx, 'gen-11'), 'completed')
    await ctx.sessionSuccessor.record(old, claim('gen-11'))
    await ctx.sessionSuccessor.record(old, claim('gen-11'))
    expect(seen).toEqual([['gen-10', { successorSessionId: 'gen-11', successorGeneration: 11, handoffId: 'h-10-11' }]])
  })
})

describe('pure helpers', () => {
  it('hasCompletedTurn ignores non-completed endings', async () => {
    const ctx = await harness()
    const s = session(ctx, 's')
    expect(hasCompletedTurn(s.events)).toBe(false)
    turn(s, 'blocked')
    expect(hasCompletedTurn(s.events)).toBe(false)
    turn(s, 'completed')
    expect(hasCompletedTurn(s.events)).toBe(true)
  })
})
