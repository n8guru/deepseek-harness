/**
 * Runaway guard for delegated children: a step cap, a token budget and a
 * repeated-call loop guard, installed on every in-process child by
 * {@link applyChildComposition}. A child that trips any limit has its next
 * step rejected at the `agent/pre-step` boundary (the turn ends `blocked`)
 * after a durable `subagent/guard-stop` event records which limit tripped, so
 * both the one-shot driver and the continuation manager can surface a clear
 * error instead of a bare refusal.
 *
 * Limits are measured over the child's OWN log (the inherited fork seed is
 * excluded), so they hold across follow-ups and cold resume of a continuable
 * child, and cannot be reset by the child.
 *
 * Environment overrides (read when a child is composed; `0` or `off` disables
 * a limit, an unparseable value keeps the default):
 * - `DSH_SUBAGENT_MAX_STEPS` — model steps across the child's life (default 200).
 * - `DSH_SUBAGENT_MAX_TOKENS` — UNCACHED work: summed input+output+cacheWrite tokens (default
 *   20,000,000). Cache reads are tracked and reported separately but never count against the
 *   budget: a ~100k-context session re-reads its prefix every step, so a budget over cache reads
 *   stops normal ~100-step sessions (g143: four legit mesh sessions cut at 10M).
 * - `DSH_SUBAGENT_MAX_REPEAT_CALLS` — identical tool calls (same name and
 *   canonical-JSON arguments) across the child's life (default 20).
 *
 * @module @deepseek-ai/dsh-subagent/runaway-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A delegated child tripped its runaway guard and its next step was
     * rejected. Log-only: it carries no `surfaceOp` and never enters model
     * history.
     */
    'subagent/guard-stop': SubagentGuardStopData
    /** A preset-scoped non-child agent tripped its runaway policy. */
    'agent/runaway-stop': SubagentGuardStopData
  }
}

/** Which runaway limit tripped. */
export type RunawayLimitKind = 'steps' | 'tokens' | 'repeat-call' | 'token-rate' | 'fan-out'

/** Payload of the `subagent/guard-stop` session event. */
export interface SubagentGuardStopData {
  /** The limit that tripped. */
  readonly limit: RunawayLimitKind
  /** Human-readable account, e.g. `step cap 200 reached (200 steps)`. */
  readonly detail: string
  /** The configured limit value. */
  readonly limitValue: number
  /** The observed value that tripped it. */
  readonly observed: number
  /** Cache-read tokens over the same span, reported separately (never counted against a limit). */
  readonly cacheReadTokens?: number
}

/** Resolved runaway limits; `undefined` disables the limit. */
export interface RunawayLimits {
  readonly maxSteps: number | undefined
  readonly maxTokens: number | undefined
  readonly maxRepeatCalls: number | undefined
  /** Burst check: uncached tokens within any rolling hour. */
  readonly maxTokensPerHour?: number | undefined
  /** Burst check: delegation tool calls (subagent fan-out) within any rolling hour. */
  readonly maxDelegationsPerHour?: number | undefined
}

/** Tool names that delegate work to child agents; counted by the fan-out burst check. */
export const DELEGATION_TOOLS: ReadonlySet<string> = new Set([
  'subagent', 'subagent_fork', 'subagent_claude_code', 'subagent_codex', 'workflow', 'ralph',
])

const HOUR_MS = 3_600_000

/** Optional policy applied when a guard limit trips. */
export interface RunawayGuardOptions {
  /** Durable event naming this guard's ownership domain. */
  readonly eventType?: 'subagent/guard-stop' | 'agent/runaway-stop'
  /** Quiescence hook run after the stop is logged and before the next step is rejected. */
  readonly onStop?: (agent: Agent, stop: SubagentGuardStopData) => Promise<void>
  /** Optional scope predicate for listeners inherited by descendant agents. */
  readonly shouldGuard?: (agent: Agent) => boolean
}

/** Default step cap. */
export const DEFAULT_MAX_STEPS = 200
/** Default token budget. */
export const DEFAULT_MAX_TOKENS = 20_000_000
/** Default identical-call cap. */
export const DEFAULT_MAX_REPEAT_CALLS = 20

/** Parse one env value: unset or garbage keeps the default, `0`/`off` disables. */
function limitFromEnv(raw: string | undefined, fallback: number): number | undefined {
  if (raw === undefined) return fallback
  const text = raw.trim().toLowerCase()
  if (text === '') return fallback
  if (text === 'off') return undefined
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0) return fallback
  return value === 0 ? undefined : Math.floor(value)
}

/**
 * Resolve the runaway limits from the environment.
 * @param env - the environment to read, `process.env` by default.
 * @returns the resolved limits.
 */
export function resolveRunawayLimits(env: Readonly<Record<string, string | undefined>> = process.env): RunawayLimits {
  return {
    maxSteps: limitFromEnv(env.DSH_SUBAGENT_MAX_STEPS, DEFAULT_MAX_STEPS),
    maxTokens: limitFromEnv(env.DSH_SUBAGENT_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    maxRepeatCalls: limitFromEnv(env.DSH_SUBAGENT_MAX_REPEAT_CALLS, DEFAULT_MAX_REPEAT_CALLS),
  }
}

/** Deterministic JSON: object keys sorted recursively. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Canonical identity of one tool call: name plus canonical-JSON arguments. */
function callKey(name: string, rawArguments: string): string {
  let args: string
  try {
    args = canonicalJson(JSON.parse(rawArguments))
  } catch {
    args = rawArguments
  }
  return `${name}\u0000${args}`
}

/** Incrementally folded accounting over one child's own log. */
class GuardAccount {
  private cursor: number
  steps = 0
  /** Uncached tokens: input + output + cache writes. */
  tokens = 0
  /** Cache-read tokens, reported separately. */
  cacheReadTokens = 0
  /** (time, uncached tokens) per model response, for the rolling-hour rate. */
  private readonly usage: { time: number; tokens: number }[] = []
  /** Times of delegation tool calls, for the rolling-hour fan-out count. */
  private readonly delegations: number[] = []
  private readonly calls = new Map<string, { name: string; count: number }>()
  /** The most-repeated call so far. */
  topCall: { name: string; count: number } = { name: '', count: 0 }

  constructor(private readonly start: number) {
    this.cursor = start
  }

  /** Fold every event appended since the last call. */
  fold(events: readonly SessionEvent[]): void {
    // The log is append-only; a shorter one means a rewritten session, so refold.
    if (events.length < this.cursor) this.reset()
    for (; this.cursor < events.length; this.cursor++) {
      const event = events[this.cursor]
      if (event === undefined) continue
      if (event.type === 'step/start') {
        this.steps++
      } else if (event.type === 'assistant/message') {
        const usage = event.data.usage
        if (usage !== undefined) {
          // TokenUsage counts are disjoint: inputTokens already excludes cached input.
          const uncached = (usage.inputTokens || 0) + (usage.outputTokens || 0) + (usage.cacheWriteTokens ?? 0)
          this.tokens += uncached
          this.cacheReadTokens += usage.cacheReadTokens ?? 0
          this.usage.push({ time: event.time, tokens: uncached })
        }
        for (const block of event.data.message.content) {
          if (block.type !== 'tool-call') continue
          this.record(block.name, block.arguments)
          if (DELEGATION_TOOLS.has(block.name)) this.delegations.push(event.time)
        }
      }
    }
  }

  private record(name: string, rawArguments: string): void {
    const key = callKey(name, rawArguments)
    const entry = this.calls.get(key) ?? { name, count: 0 }
    entry.count++
    this.calls.set(key, entry)
    if (entry.count > this.topCall.count) this.topCall = entry
  }

  /** Uncached tokens spent in the rolling hour ending at `now`. */
  tokensInHour(now: number): number {
    return this.usage.reduce((sum, entry) => (entry.time > now - HOUR_MS ? sum + entry.tokens : sum), 0)
  }

  /** Delegation calls made in the rolling hour ending at `now`. */
  delegationsInHour(now: number): number {
    return this.delegations.filter(time => time > now - HOUR_MS).length
  }

  private reset(): void {
    this.cursor = this.start
    this.steps = 0
    this.tokens = 0
    this.cacheReadTokens = 0
    this.usage.length = 0
    this.delegations.length = 0
    this.calls.clear()
    this.topCall = { name: '', count: 0 }
  }
}

/**
 * Decide whether the child's account trips a limit.
 * @param account - the folded account.
 * @param limits - the limits in force.
 * @returns the stop to record, or `undefined` when the child may continue.
 */
function evaluate(account: GuardAccount, limits: RunawayLimits, now: number): SubagentGuardStopData | undefined {
  const stop = evaluateLimits(account, limits, now)
  return stop === undefined ? undefined : { ...stop, cacheReadTokens: account.cacheReadTokens }
}

function evaluateLimits(account: GuardAccount, limits: RunawayLimits, now: number): SubagentGuardStopData | undefined {
  const { maxSteps, maxTokens, maxRepeatCalls, maxTokensPerHour, maxDelegationsPerHour } = limits
  if (maxSteps !== undefined && account.steps >= maxSteps) {
    return {
      limit: 'steps',
      limitValue: maxSteps,
      observed: account.steps,
      detail: `step cap ${String(maxSteps)} reached (${String(account.steps)} steps taken)`,
    }
  }
  if (maxTokens !== undefined && account.tokens >= maxTokens) {
    return {
      limit: 'tokens',
      limitValue: maxTokens,
      observed: account.tokens,
      detail: `token budget ${String(maxTokens)} reached (${String(account.tokens)} uncached tokens used; `
        + `${String(account.cacheReadTokens)} cache-read tokens not counted)`,
    }
  }
  const hourly = maxTokensPerHour === undefined ? 0 : account.tokensInHour(now)
  if (maxTokensPerHour !== undefined && hourly >= maxTokensPerHour) {
    return {
      limit: 'token-rate',
      limitValue: maxTokensPerHour,
      observed: hourly,
      detail: `token burst ${String(maxTokensPerHour)}/hour reached (${String(hourly)} uncached tokens in the last hour)`,
    }
  }
  const fanOut = maxDelegationsPerHour === undefined ? 0 : account.delegationsInHour(now)
  if (maxDelegationsPerHour !== undefined && fanOut >= maxDelegationsPerHour) {
    return {
      limit: 'fan-out',
      limitValue: maxDelegationsPerHour,
      observed: fanOut,
      detail: `subagent fan-out ${String(maxDelegationsPerHour)}/hour reached (${String(fanOut)} delegations in the last hour)`,
    }
  }
  if (maxRepeatCalls !== undefined && account.topCall.count >= maxRepeatCalls) {
    return {
      limit: 'repeat-call',
      limitValue: maxRepeatCalls,
      observed: account.topCall.count,
      detail: `repeated-call guard: tool "${account.topCall.name}" was called with identical arguments `
        + `${String(account.topCall.count)} times (limit ${String(maxRepeatCalls)})`,
    }
  }
  return undefined
}

/**
 * Install the runaway guard on one child inside its creation window.
 * @param childCtx - the child agent's scoped creation context.
 * @param limits - the limits to enforce, resolved from the environment by default.
 * @param options - event ownership and optional quiescence hook.
 */
export function installRunawayGuard(
  childCtx: Context,
  limits: RunawayLimits = resolveRunawayLimits(),
  options: RunawayGuardOptions = {},
): void {
  if (Object.values(limits).every(value => value === undefined)) return
  const accounts = new WeakMap<Agent, GuardAccount>()
  childCtx.on('agent/pre-step', async ({ agent }, next): Promise<PreStepDecision> => {
    if (options.shouldGuard !== undefined && !options.shouldGuard(agent)) return next()
    const session = agent.session
    let account = accounts.get(agent)
    if (account === undefined) {
      account = new GuardAccount(session.header.seedLength ?? 0)
      accounts.set(agent, account)
    }
    account.fold(session.events)
    const stop = evaluate(account, limits, Date.now())
    if (stop === undefined) return next()
    if (options.eventType === 'agent/runaway-stop') session.append('agent/runaway-stop', stop)
    else session.append('subagent/guard-stop', stop)
    await options.onStop?.(agent, stop)
    return { kind: 'reject' }
  })
}

/**
 * The latest runaway-guard stop in a child's own event suffix.
 * @param events - the child's own events (seed excluded).
 * @returns the stop payload, or `undefined` when the guard never tripped.
 */
export function guardStopOf(events: readonly SessionEvent[]): SubagentGuardStopData | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type === 'subagent/guard-stop') return event.data
  }
  return undefined
}

/**
 * Model-facing sentence naming a guard stop.
 * @param stop - the recorded stop.
 * @returns the one-line message a parent reads.
 */
export function guardStopMessage(stop: SubagentGuardStopData): string {
  return `Subagent stopped by runaway guard: ${stop.detail}`
}

/**
 * Prefix a child's output with its guard-stop message, so the delegating agent
 * sees why the child ended before whatever partial answer it left.
 * @param stop - the recorded stop.
 * @param output - the child's own final output, if any.
 * @returns the output with the guard message first.
 */
export function withGuardStopOutput(stop: SubagentGuardStopData, output: readonly ContentBlock[]): ContentBlock[] {
  return [{ type: 'text', text: guardStopMessage(stop) }, ...output]
}
