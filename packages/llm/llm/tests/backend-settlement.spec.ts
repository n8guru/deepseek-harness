import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { backendStatusJoined, LlmAdapter, LlmBackendLedger, type LlmBackendStatus } from '@deepseek-ai/dsh-llm'

class EvidenceAdapter extends LlmAdapter {
  evidence: LlmBackendStatus = { state: 'JOINED', turns: [], startingTurns: 0, uncertainStarts: 0, unattributedEvents: 0 }
  override backendStatus() { return structuredClone(this.evidence) }
  async * stream() {}
}

it('retains never-streamed owned instance/lost-start authority across withdrawal and re-registration', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  try {
    const old = new EvidenceAdapter()
    old.evidence.uncertainStarts = 1
    old.evidence.state = 'UNKNOWN'
    const dispose = ctx.llm.registerAdapter(['fixture'], old)
    const generation = ctx.llm.backendCoverage().participants[0]!.registrations[0]!.generation
    dispose()
    const replacement = new EvidenceAdapter()
    ctx.llm.registerAdapter(['fixture'], replacement)
    const status = ctx.llm.backendCoverage()
    expect(status.state).toBe('UNKNOWN')
    expect(status.participants).toHaveLength(2)
    expect(status.participants[0]!.registrations).toEqual([{ provider: 'fixture', generation }])
    expect(status.participants[1]!.registrations[0]!.generation).toBeGreaterThan(generation)
    expect(status.participants[0]!.status!.uncertainStarts).toBe(1)
    // Only adapter-owned authoritative evidence, never withdrawal or the replacement, can settle old work.
    old.evidence = { state: 'JOINED', turns: [{ threadId: 'old-thread', turnId: 'old-turn',
      state: 'JOINED', pendingRequests: [], terminal: { threadId: 'old-thread', turnId: 'old-turn', status: 'interrupted' } }],
    startingTurns: 0, uncertainStarts: 0, unattributedEvents: 0 }
    expect(ctx.llm.backendCoverage().state).toBe('JOINED')
  } finally { await ctx.fiber.dispose() }
})

it('retains unsupported withdrawn routes and assigns a new generation when the same instance is re-routed', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  try {
    class Unsupported extends LlmAdapter { async * stream() {} }
    const dispose = ctx.llm.registerAdapter(['unsupported'], new Unsupported())
    dispose()
    expect(ctx.llm.backendCoverage().state).toBe('UNKNOWN')
    const adapter = new EvidenceAdapter()
    const route = ctx.llm.registerAdapter(['supported'], adapter)
    route.replace(['supported'])
    const participant = ctx.llm.backendCoverage().participants.find(p => p.providers.includes('supported'))!
    expect(participant.registrations).toHaveLength(2)
    expect(participant.registrations[0]!.generation).not.toBe(participant.registrations[1]!.generation)
    expect(participant.reason).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})

it('LlmBackendLedger: starting and in-flight are busy, provider terminal joins, unanswered close stays unknown', () => {
  const ledger = new LlmBackendLedger()
  expect(backendStatusJoined(ledger.status())).toBe(true)
  const call = ledger.begin('s1')
  expect(ledger.status()).toMatchObject({ state: 'UNKNOWN', startingTurns: 1, turns: [] })
  call.dispatch()
  expect(ledger.status()).toMatchObject({ state: 'UNKNOWN', startingTurns: 0, turns: [{ threadId: 's1', turnId: 'call-1', state: 'UNKNOWN', pendingRequests: ['request-1'] }] })
  // A complete provider error answer, then a retried request: still in flight.
  call.answered()
  call.dispatch()
  expect(ledger.status().turns[0]!.pendingRequests).toEqual(['request-2'])
  call.terminal('completed')
  call.close()
  expect(backendStatusJoined(ledger.status())).toBe(true)
  // Answered-then-closed settles as provider failure.
  const failed = ledger.begin()
  failed.dispatch(); failed.answered(); failed.close()
  expect(ledger.status().turns[1]).toMatchObject({ threadId: 'unattributed-calls', state: 'JOINED', terminal: { status: 'failed' } })
  // Error/abort with no provider terminal: unknown forever, never idle.
  const lost = ledger.begin('s2')
  lost.dispatch(); lost.close(); lost.terminal('completed')
  expect(ledger.status()).toMatchObject({ state: 'UNKNOWN', turns: [{}, {}, { threadId: 's2', state: 'UNKNOWN', pendingRequests: ['request-1'] }] })
  const truly = new LlmBackendLedger()
  const gone = truly.begin('s3')
  gone.dispatch(); gone.close()
  expect(truly.status()).toMatchObject({ state: 'UNKNOWN', turns: [{ state: 'UNKNOWN', pendingRequests: ['request-1'] }] })
  // Never-dispatched calls leave no turn and no starting count.
  const never = truly.begin(); never.close(); never.close()
  expect(truly.status().startingTurns).toBe(0)
})

it('throwing or malformed backendStatus is unknown, never idle', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  try {
    class Throws extends LlmAdapter { override backendStatus(): LlmBackendStatus { throw new Error('probe failed') } async * stream() {} }
    ctx.llm.registerAdapter(['throws'], new Throws())
    expect(ctx.llm.backendCoverage()).toMatchObject({ state: 'UNKNOWN', participants: [{ reason: 'backend settlement unavailable or malformed' }] })
  } finally { await ctx.fiber.dispose() }
  const ctx2 = new Context()
  await ctx2.plugin(LlmRuntime)
  try {
    const adapter = new EvidenceAdapter()
    adapter.evidence = { state: 'UNKNOWN', turns: [], startingTurns: 0, uncertainStarts: 0, unattributedEvents: 0 }
    ctx2.llm.registerAdapter(['errored'], adapter)
    expect(ctx2.llm.backendCoverage().state).toBe('UNKNOWN')
  } finally { await ctx2.fiber.dispose() }
})
