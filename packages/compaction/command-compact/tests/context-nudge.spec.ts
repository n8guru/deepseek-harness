/**
 * Tests for the opt-in conductor context nudge: the pure one-line decision,
 * the session-log fold, config validation, and the mounted prompt-context
 * provider reading the host's own `contextPressure` projection.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as commandCompact from '../src/index.ts'
import {
  CONTEXT_NUDGE_NAME,
  decideContextNudge,
  readTurnFacts,
  resolveContextNudgeConfig,
  type ResolvedContextNudgeConfig,
} from '../src/context-nudge.ts'

const DEFAULTS = resolveContextNudgeConfig({})
const MINUTE = 60 * 1000

function turnStart(seq: number, time: number, turn: number): SessionEvent {
  return { type: 'turn/start', seq, time, data: { turn } }
}

function turnEnd(seq: number, time: number, turn: number): SessionEvent {
  return { type: 'turn/end', seq, time, data: { turn, reason: { kind: 'completed' } } }
}

function forwardCall(seq: number, time: number, turn: number, name = 'hand_forward'): SessionEvent {
  return {
    type: 'tool/call',
    seq,
    time,
    data: { turn, step: 1, callId: CallId(`call-${seq}`), name, arguments: '{}' },
  }
}

describe('resolveContextNudgeConfig', () => {
  it('fills the documented defaults', () => {
    expect(resolveContextNudgeConfig({})).toEqual({
      warnPct: 25,
      actPct: 30,
      maxTurnsWithoutForward: 40,
      idleGapMs: 90 * MINUTE,
      batonPath: 'tools/CONDUCTOR-BATON.md',
    })
  })

  it('keeps explicit thresholds', () => {
    expect(resolveContextNudgeConfig({
      warnPct: 10,
      actPct: 20,
      maxTurnsWithoutForward: 5,
      idleGapMs: MINUTE,
      batonPath: 'baton.md',
    })).toEqual({
      warnPct: 10,
      actPct: 20,
      maxTurnsWithoutForward: 5,
      idleGapMs: MINUTE,
      batonPath: 'baton.md',
    })
  })

  it.each([
    ['warnPct', { warnPct: 0 }],
    ['warnPct', { warnPct: 100 }],
    ['warnPct', { warnPct: Number.NaN }],
    ['warnPct', { warnPct: 30, actPct: 30 }],
    ['warnPct', { warnPct: 40, actPct: 30 }],
    ['actPct', { actPct: 0 }],
    ['actPct', { actPct: 101 }],
    ['maxTurnsWithoutForward', { maxTurnsWithoutForward: 0 }],
    ['maxTurnsWithoutForward', { maxTurnsWithoutForward: 1.5 }],
    ['idleGapMs', { idleGapMs: 0 }],
    ['idleGapMs', { idleGapMs: -MINUTE }],
    ['batonPath', { batonPath: '' }],
    ['batonPath', { batonPath: '   ' }],
  ])('rejects an invalid %s', (_field, config) => {
    expect(() => resolveContextNudgeConfig(config)).toThrow(/contextNudge/)
  })
})

describe('readTurnFacts', () => {
  it('reports nothing before the first turn', () => {
    expect(readTurnFacts([])).toBeUndefined()
  })

  it('counts from turn one with no idle gap when never forwarded', () => {
    expect(readTurnFacts([turnStart(0, 1000, 1)])).toEqual({
      currentTurn: 1,
      turnsSinceForward: 1,
    })
  })

  it('measures the idle gap before the current turn and the turns since forwarding', () => {
    const events = [
      turnStart(0, 1000, 1),
      turnEnd(1, 2000, 1),
      forwardCall(2, 3000, 2),
      turnStart(3, 4000, 2),
      turnEnd(4, 5000, 2),
      turnStart(5, 5000 + 91 * MINUTE, 3),
    ]
    expect(readTurnFacts(events)).toEqual({
      currentTurn: 3,
      turnsSinceForward: 1,
      idleGapMs: 91 * MINUTE,
    })
  })

  it('ignores other tools and keeps the latest forwarding call', () => {
    const events = [
      turnStart(0, 1000, 1),
      forwardCall(1, 2000, 1, 'bash'),
      forwardCall(2, 3000, 1),
      forwardCall(3, 4000, 2),
      turnStart(4, 5000, 3),
    ]
    expect(readTurnFacts(events)).toEqual({
      currentTurn: 3,
      turnsSinceForward: 1,
      idleGapMs: 1000,
    })
  })
})

describe('decideContextNudge', () => {
  const reading = (overrides: Partial<Parameters<typeof decideContextNudge>[0]> = {}) => ({
    turnsSinceForward: 1,
    ...overrides,
  })

  it('injects nothing below the advisory threshold', () => {
    expect(decideContextNudge(reading({ pressurePct: 24 }), DEFAULTS)).toBe('')
  })

  it('injects nothing without pressure, staleness, or idleness', () => {
    expect(decideContextNudge(reading(), DEFAULTS)).toBe('')
  })

  it('advises a natural break exactly at the warn threshold', () => {
    expect(decideContextNudge(reading({ pressurePct: 25 }), DEFAULTS)).toBe(
      'context 25% — look for a natural break; hand_forward at 30%',
    )
  })

  it('names hand_forward exactly at the action threshold', () => {
    expect(decideContextNudge(reading({ pressurePct: 30 }), DEFAULTS)).toBe(
      'context 30% — call hand_forward at the end of this turn (baton: tools/CONDUCTOR-BATON.md)',
    )
  })

  it('renders the configured baton path in the action line', () => {
    const config: ResolvedContextNudgeConfig = { ...DEFAULTS, batonPath: 'state/baton.md' }
    expect(decideContextNudge(reading({ pressurePct: 87 }), config)).toBe(
      'context 87% — call hand_forward at the end of this turn (baton: state/baton.md)',
    )
  })

  it('nudges staleness exactly at the turn threshold, with and without pressure', () => {
    expect(decideContextNudge(reading({ turnsSinceForward: 40, pressurePct: 12 }), DEFAULTS)).toBe(
      'context 12% — 40 turns since last hand_forward; hand_forward at a natural break',
    )
    expect(decideContextNudge(reading({ turnsSinceForward: 41 }), DEFAULTS)).toBe(
      '41 turns since last hand_forward — hand_forward at a natural break',
    )
    expect(decideContextNudge(reading({ turnsSinceForward: 39, pressurePct: 12 }), DEFAULTS)).toBe('')
  })

  it('reports a resume only past the idle threshold', () => {
    expect(decideContextNudge(reading({ idleGapMs: 90 * MINUTE }), DEFAULTS)).toBe('')
    expect(decideContextNudge(reading({ idleGapMs: 90 * MINUTE + 1 }), DEFAULTS)).toBe(
      'resuming after idle; re-read baton state first',
    )
  })

  it('prefers idle, then action, then staleness, then advice', () => {
    expect(decideContextNudge(
      reading({ pressurePct: 90, turnsSinceForward: 50, idleGapMs: 91 * MINUTE }),
      DEFAULTS,
    )).toBe('resuming after idle; re-read baton state first')
    expect(decideContextNudge(
      reading({ pressurePct: 90, turnsSinceForward: 50 }),
      DEFAULTS,
    )).toContain('call hand_forward at the end of this turn')
    expect(decideContextNudge(
      reading({ pressurePct: 26, turnsSinceForward: 50 }),
      DEFAULTS,
    )).toContain('turns since last hand_forward')
  })
})

describe('mounted context-nudge provider', () => {
  async function harness(config: { contextNudge?: import('../src/context-nudge.ts').ContextNudgeConfig } = {}) {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(BasicCompactionEngine, { auto: false })
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(commandCompact, config)
    return ctx
  }

  function agentFor(session: Session): Agent {
    return { session } as unknown as Agent
  }

  async function nudgeText(ctx: Context, session: Session): Promise<string | undefined> {
    const assembly = await ctx.systemPrompt.assemble({ agent: agentFor(session) })
    return assembly.contexts.find(context => context.name === CONTEXT_NUDGE_NAME)?.text
  }

  function openTurn(session: Session, turn: number): void {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
  }

  function reportUsage(session: Session, turn: number, inputTokens: number, contextWindow: number): void {
    session.append('request/context', { provider: 'mock', model: 'exact', contextWindow })
    session.append('assistant/chunk', {
      turn,
      step: 1,
      chunk: { type: 'usage', usage: { inputTokens, outputTokens: 10 } },
    })
  }

  it('registers nothing when the composition does not opt in', async () => {
    const ctx = await harness()
    try {
      const session = ctx.sessions.create()
      openTurn(session, 1)
      reportUsage(session, 1, 900, 1000)
      const assembly = await ctx.systemPrompt.assemble({ agent: agentFor(session) })
      expect(assembly.contexts.find(context => context.name === CONTEXT_NUDGE_NAME)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stays silent below the advisory threshold', async () => {
    const ctx = await harness({ contextNudge: {} })
    try {
      const session = ctx.sessions.create()
      openTurn(session, 1)
      reportUsage(session, 1, 240, 1000)
      expect(await nudgeText(ctx, session)).toBe('')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reads the host projection instead of recounting tokens', async () => {
    const ctx = await harness({ contextNudge: {} })
    try {
      const session = ctx.sessions.create()
      openTurn(session, 1)
      reportUsage(session, 1, 260, 1000)
      expect(await nudgeText(ctx, session)).toBe(
        'context 26% — look for a natural break; hand_forward at 30%',
      )
      const pressure = ctx.sessionProjections.snapshot(session).values.contextPressure
      expect(pressure?.pressureTokens).toBe(260)
      expect(pressure?.contextWindow).toBe(1000)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('names hand_forward at the action threshold', async () => {
    const ctx = await harness({ contextNudge: {} })
    try {
      const session = ctx.sessions.create()
      openTurn(session, 2)
      reportUsage(session, 2, 310, 1000)
      expect(await nudgeText(ctx, session)).toBe(
        'context 31% — call hand_forward at the end of this turn (baton: tools/CONDUCTOR-BATON.md)',
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('nudges forwarding staleness after forty quiet turns', async () => {
    const ctx = await harness({ contextNudge: {} })
    try {
      const session = ctx.sessions.create()
      for (let turn = 1; turn <= 40; turn += 1) {
        session.append('turn/start', { turn })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
      session.append('turn/start', { turn: 41 })
      expect(await nudgeText(ctx, session)).toBe(
        '41 turns since last hand_forward — hand_forward at a natural break',
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resets staleness on a hand_forward call', async () => {
    const ctx = await harness({ contextNudge: {} })
    try {
      const session = ctx.sessions.create()
      for (let turn = 1; turn <= 40; turn += 1) {
        session.append('turn/start', { turn })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
      session.append('tool/call', {
        turn: 40,
        step: 1,
        callId: CallId('forward-once'),
        name: 'hand_forward',
        arguments: '{}',
      })
      session.append('turn/start', { turn: 41 })
      expect(await nudgeText(ctx, session)).toBe('')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reflects surface growth since the last usage sample', async () => {
    const ctx = await harness({ contextNudge: {} })
    try {
      const session = ctx.sessions.create()
      openTurn(session, 1)
      reportUsage(session, 1, 200, 1000)
      expect(await nudgeText(ctx, session)).toBe('')
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'x'.repeat(600) }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      expect(await nudgeText(ctx, session)).toBe(
        'context 35% — call hand_forward at the end of this turn (baton: tools/CONDUCTOR-BATON.md)',
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not re-emit the act line from a stale sample after compaction', async () => {
    const ctx = await harness({ contextNudge: {} })
    try {
      const session = ctx.sessions.create()
      openTurn(session, 1)
      const bulky = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'y'.repeat(2000) }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      reportUsage(session, 1, 320, 1000)
      expect(await nudgeText(ctx, session)).toBe(
        'context 32% — call hand_forward at the end of this turn (baton: tools/CONDUCTOR-BATON.md)',
      )
      session.append('tool/call', {
        turn: 1,
        step: 1,
        callId: CallId('forward-then-compact'),
        name: 'hand_forward',
        arguments: '{}',
      })
      const messageTokens = ctx.sessionProjections.snapshot(session).values.contextBreakdown?.messageTokens
      expect(messageTokens).toBeGreaterThan(300)
      const prune = session.append('compaction/prune', {
        shadowedRange: { start: bulky.seq, end: bulky.seq },
        shadowedSeqs: [bulky.seq],
        shadowedTokenCount: messageTokens ?? 0,
      })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'checkpoint' }],
        source: { kind: 'user' },
      }), {
        surfaceOp: { op: 'replace', start: bulky.seq, end: bulky.seq },
        sourceEventSeqs: [bulky.seq, prune.seq],
      })
      session.append('turn/start', { turn: 2 })
      expect(await nudgeText(ctx, session)).toBe('')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('contributes nothing on an agentless assembly', async () => {
    const ctx = await harness({ contextNudge: {} })
    try {
      const assembly = await ctx.systemPrompt.assemble()
      expect(assembly.contexts.find(context => context.name === CONTEXT_NUDGE_NAME)?.text).toBe('')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('contributes nothing before the first turn', async () => {
    const ctx = await harness({ contextNudge: {} })
    try {
      const session = ctx.sessions.create()
      expect(await nudgeText(ctx, session)).toBe('')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
