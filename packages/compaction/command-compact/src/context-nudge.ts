/**
 * Opt-in per-turn context-pressure nudge for the conductor seat. A dynamic
 * prompt-context provider that reads the host's own `contextPressure`
 * projection and the session log, and contributes at most one short line per
 * model step. It never compacts and never calls `hand_forward` itself.
 *
 * @module @deepseek-ai/dsh-command-compact/context-nudge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
// Type-only: resolves the optional projection registry Context declaration.
import type {} from '@deepseek-ai/dsh-session-projection'

/** Deployment-owned nudge thresholds; every field is optional with the documented default. */
export interface ContextNudgeConfig {
  /** Pressure percent that starts the advisory line. Default 25. */
  warnPct?: number
  /** Pressure percent that names `hand_forward` directly. Default 30. */
  actPct?: number
  /** Turns without a `hand_forward` call that trigger the staleness line. Default 40. */
  maxTurnsWithoutForward?: number
  /** Idle gap before the current turn that triggers the resume line. Default 90 minutes. */
  idleGapMs?: number
  /** Baton path rendered in the action lines. Default `tools/CONDUCTOR-BATON.md`. */
  batonPath?: string
}

/** Fully resolved nudge thresholds; every field is required. */
export interface ResolvedContextNudgeConfig {
  /** Pressure percent that starts the advisory line. */
  warnPct: number
  /** Pressure percent that names `hand_forward` directly. */
  actPct: number
  /** Turns without a `hand_forward` call that trigger the staleness line. */
  maxTurnsWithoutForward: number
  /** Idle gap before the current turn that triggers the resume line. */
  idleGapMs: number
  /** Baton path rendered in the action lines. */
  batonPath: string
}

/** Prompt-context registration name for the nudge contribution. */
export const CONTEXT_NUDGE_NAME = 'compaction:context-nudge'

/** Prompt-context order: runtime context beside the sandbox and approval sentences. */
export const CONTEXT_NUDGE_ORDER = 112

const DEFAULT_BATON_PATH = 'tools/CONDUCTOR-BATON.md'
const DEFAULT_IDLE_GAP_MS = 90 * 60 * 1000

/**
 * Validate deployment thresholds and fill defaults. Invalid values fail plugin
 * load instead of silently changing cadence.
 * @param config - deployment-owned thresholds, all optional.
 * @returns the fully resolved thresholds.
 */
export function resolveContextNudgeConfig(config: ContextNudgeConfig): ResolvedContextNudgeConfig {
  const warnPct = config.warnPct ?? 25
  const actPct = config.actPct ?? 30
  if (!Number.isFinite(warnPct) || warnPct <= 0 || warnPct >= 100) {
    throw new Error('contextNudge.warnPct must be within (0, 100)')
  }
  if (!Number.isFinite(actPct) || actPct <= 0 || actPct > 100) {
    throw new Error('contextNudge.actPct must be within (0, 100]')
  }
  if (warnPct >= actPct) throw new Error('contextNudge.warnPct must be below contextNudge.actPct')
  const maxTurnsWithoutForward = config.maxTurnsWithoutForward ?? 40
  if (!Number.isSafeInteger(maxTurnsWithoutForward) || maxTurnsWithoutForward < 1) {
    throw new Error('contextNudge.maxTurnsWithoutForward must be a positive integer')
  }
  const idleGapMs = config.idleGapMs ?? DEFAULT_IDLE_GAP_MS
  if (!Number.isFinite(idleGapMs) || idleGapMs <= 0) {
    throw new Error('contextNudge.idleGapMs must be a positive duration in milliseconds')
  }
  const batonPath = config.batonPath ?? DEFAULT_BATON_PATH
  if (batonPath.trim().length === 0) throw new Error('contextNudge.batonPath must not be empty')
  return { warnPct, actPct, maxTurnsWithoutForward, idleGapMs, batonPath }
}

/** Per-turn facts folded from the durable session log. */
export interface TurnFacts {
  /** Highest turn number opened by a `turn/start` event. */
  currentTurn: number
  /** Open turns since the last `hand_forward` tool call, counting from turn 1 when never called. */
  turnsSinceForward: number
  /** Milliseconds between the current `turn/start` and the preceding event; absent on the first turn. */
  idleGapMs?: number
}

/**
 * Fold turn position, forwarding staleness, and the pre-turn idle gap from the
 * durable log. Reads committed events only: no clock, no model calls, no I/O.
 * @param events - the session's committed events in seq order.
 * @returns per-turn facts, or `undefined` before the first `turn/start`.
 */
export function readTurnFacts(events: readonly SessionEvent[]): TurnFacts | undefined {
  const start = [...events].reverse().find(
    (event): event is SessionEvent<'turn/start'> => event.type === 'turn/start',
  )
  if (start === undefined) return undefined
  const startIndex = events.lastIndexOf(start)
  let lastForwardTurn: number | undefined
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.name === 'hand_forward') {
      lastForwardTurn = event.data.turn
    }
  }
  const previous = startIndex <= 0 ? undefined : events[startIndex - 1]
  const idleGapMs = previous === undefined ? undefined : start.time - previous.time
  return {
    currentTurn: start.data.turn,
    turnsSinceForward: start.data.turn - (lastForwardTurn ?? 0),
    ...idleGapMs === undefined ? {} : { idleGapMs },
  }
}

/** Inputs to the one-line nudge decision. */
export interface NudgeReading {
  /** Floored projected-first pressure percent; absent until a provider reports usage and capacity. */
  pressurePct?: number | undefined
  /** Open turns since the last `hand_forward` call. */
  turnsSinceForward: number
  /** Milliseconds between the current `turn/start` and the preceding event; absent on the first turn. */
  idleGapMs?: number | undefined
}

/**
 * Decide the single nudge line for one model step. Precedence is fixed:
 * idle resume, action threshold, forwarding staleness, advisory threshold.
 * Anything below the advisory threshold with no other trigger contributes
 * nothing, so the assembly spends zero tokens on the nudge.
 * @param reading - pressure, staleness, and idle inputs for this step.
 * @param config - resolved deployment thresholds.
 * @returns one short line, or `''` when the step needs no nudge.
 */
// Precedence invariant: idle resume > act threshold > staleness > warn threshold.
export function decideContextNudge(reading: NudgeReading, config: ResolvedContextNudgeConfig): string {
  if (reading.idleGapMs !== undefined && reading.idleGapMs > config.idleGapMs) {
    return 'resuming after idle; re-read baton state first'
  }
  if (reading.pressurePct !== undefined && reading.pressurePct >= config.actPct) {
    return `context ${reading.pressurePct}% — call hand_forward at the end of this turn (baton: ${config.batonPath})`
  }
  if (reading.turnsSinceForward >= config.maxTurnsWithoutForward) {
    return reading.pressurePct === undefined
      ? `${reading.turnsSinceForward} turns since last hand_forward — hand_forward at a natural break`
      : `context ${reading.pressurePct}% — ${reading.turnsSinceForward} turns since last hand_forward; hand_forward at a natural break`
  }
  if (reading.pressurePct !== undefined && reading.pressurePct >= config.warnPct) {
    return `context ${reading.pressurePct}% — look for a natural break; hand_forward at ${config.actPct}%`
  }
  return ''
}

/**
 * Resolve one assembly's nudge line from the host's own projection and log.
 * @param scope - context carrying the projection registry.
 * @param agent - the assembling agent, or `undefined` on diagnostics.
 * @param config - resolved deployment thresholds.
 * @returns one short line, or `''` when the step needs no nudge.
 */
function renderNudgeFor(
  scope: Context,
  agent: Agent | undefined,
  config: ResolvedContextNudgeConfig,
): string {
  if (agent === undefined) return ''
  const facts = readTurnFacts(agent.session.events)
  if (facts === undefined) return ''
  const pressure = scope.sessionProjections.snapshot(agent.session).values.contextPressure
  // Projected first: pressureTokens is the last completed request's prompt size
  // and cannot see surface growth or compaction until the next usage sample.
  // The registry schema-validates every value, so a present contextWindow is positive.
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  const pressurePct = usedTokens !== undefined && pressure?.contextWindow !== undefined
    ? Math.floor(usedTokens / pressure.contextWindow * 100)
    : undefined
  return decideContextNudge({ ...facts, pressurePct }, config)
}

/**
 * Register the nudge as dynamic prompt context. The provider runs on every
 * pre-step assembly for the composed scope; empty text contributes nothing,
 * and the loop logs the snapshot only when it changes. Compositions without
 * the projection registry keep no provider at all.
 * @param ctx - agent/session context to register through.
 * @param config - deployment-owned thresholds, all optional.
 */
export function installContextNudge(ctx: Context, config: ContextNudgeConfig): void {
  const resolved = resolveContextNudgeConfig(config)
  ctx.inject(['systemPrompt', 'sessionProjections'], (scope: Context) => {
    scope.systemPrompt.context({
      name: CONTEXT_NUDGE_NAME,
      order: CONTEXT_NUDGE_ORDER,
      text: (context: AssembleContext) => renderNudgeFor(scope, context.agent, resolved),
    })
  })
}
