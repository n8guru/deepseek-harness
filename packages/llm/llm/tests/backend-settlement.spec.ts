import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type LlmBackendStatus } from '@deepseek-ai/dsh-llm'

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
