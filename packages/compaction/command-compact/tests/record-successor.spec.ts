/**
 * `record_successor` executor: records through ctx.sessionSuccessor, archives
 * only AFTER the durable fact, never archives on refusal (the old session
 * stays selectable and unarchived), and enforces workspace-registry membership.
 */
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionSuccessorService from '@deepseek-ai/dsh-session-successor'
import { executeRecordSuccessor, type RecordSuccessorArgs } from '../src/record-successor.ts'

interface FakeWorkspace { id: string; sessionIds: string[] }

async function harness(workspaces?: FakeWorkspace[]) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionSuccessorService)
  const archived: string[] = []
  const order: string[] = []
  ctx.on('session/flush', (s: Session) => { order.push(`flush:${s.id}`) })
  if (workspaces !== undefined) {
    ctx.provide('workspaceRegistry')
    ;(ctx as unknown as { workspaceRegistry: unknown }).workspaceRegistry = {
      list: () => workspaces,
      archiveSession: vi.fn((id: string) => { order.push(`archive:${id}`); archived.push(id); return Promise.resolve() }),
    }
  }
  const make = (id: string): Session => ctx.sessions.create(SessionId(id), { meta: { cwd: '/w' } })
  return { ctx, archived, order, make }
}

function ready(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

const args = (extra: Partial<RecordSuccessorArgs> = {}): RecordSuccessorArgs => ({
  successor_session_id: 'gen-11', successor_generation: 11, handoff_id: 'h', pointer_session_id: 'gen-11', ...extra,
})

it('records durably, then archives the old session', async () => {
  const { ctx, archived, order, make } = await harness([{ id: 'ws', sessionIds: ['gen-10', 'gen-11'] }])
  const old = make('gen-10')
  ready(make('gen-11'))
  const out = await executeRecordSuccessor(ctx, old, args())
  expect(out).toMatchObject({ status: 'recorded', successor_session_id: 'gen-11', successor_generation: 11, archived: true })
  expect(archived).toEqual(['gen-10'])
  expect(order.indexOf('flush:gen-10')).toBeLessThan(order.indexOf('archive:gen-10'))
})

it('never archives on a failed handoff (not ready / pointer mismatch)', async () => {
  const { ctx, archived, make } = await harness([{ id: 'ws', sessionIds: ['gen-10', 'gen-11'] }])
  const old = make('gen-10')
  const next = make('gen-11')
  await expect(executeRecordSuccessor(ctx, old, args())).rejects.toThrow(/not committed a completed turn/u)
  ready(next)
  await expect(executeRecordSuccessor(ctx, old, args({ pointer_session_id: 'gen-10' }))).rejects.toThrow(/current pointer/u)
  expect(archived).toEqual([])
  expect(ctx.sessionProjections.snapshot(old).values.successor).toBeNull()
})

it('rejects a successor accounted in another workspace', async () => {
  const { ctx, archived, make } = await harness([
    { id: 'cadence', sessionIds: ['gen-10'] },
    { id: 'other', sessionIds: ['gen-11'] },
  ])
  const old = make('gen-10')
  ready(make('gen-11'))
  await expect(executeRecordSuccessor(ctx, old, args())).rejects.toThrow(/workspace/u)
  expect(archived).toEqual([])
})

it('respects archive_old=false and works without a workspace registry', async () => {
  const { ctx, make } = await harness()
  const old = make('gen-10')
  ready(make('gen-11'))
  const out = await executeRecordSuccessor(ctx, old, args({ archive_old: false }))
  expect(out).toMatchObject({ status: 'recorded', archived: false })
  const replay = await executeRecordSuccessor(ctx, old, args())
  expect(replay.status).toBe('existing')
})
