/**
 * Complexity-tier model resolution for delegated children (mesh-dsh-merge
 * step 55). A caller of `subagent`/`subagent_fork` may name a complexity
 * TIER — `basic`, `mid`, or `capable` — instead of an explicit model. The
 * tier name is the only vocabulary this module hardcodes; which concrete
 * `provider`/`model` chain currently serves each tier is registry DATA,
 * resolved dynamically at call time from the Forage LLM role/class registry
 * (project 1891788 steps 7/16: `DecisionRule domain=llm_model_class`,
 * exposed through `app/llm_proxy.py`'s authenticated HTTP seam) — never a
 * hardcoded model literal in this package.
 *
 * Caching follows the estate's own `DISPATCH_STATE_TTL_SECONDS` pattern
 * (insight #61507): a bounded TTL, with safe fallback to the last good
 * resolution on a transient read failure. A registry that has NEVER
 * resolved (no cached value at all) and cannot be read fails closed —
 * silent substitution onto some ambient default is exactly the failure
 * mode this project exists to end.
 *
 * @module @deepseek-ai/dsh-subagent/model-tier
 */

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { SubagentError } from './error.ts'

/** The three complexity tiers a caller may name instead of an explicit model. */
export const MODEL_TIERS = ['basic', 'mid', 'capable'] as const

/** A named complexity tier (see {@link MODEL_TIERS}). */
export type ModelTier = (typeof MODEL_TIERS)[number]

/** True for any string naming a supported {@link ModelTier}. */
export function isModelTier(value: unknown): value is ModelTier {
  return typeof value === 'string' && (MODEL_TIERS as readonly string[]).includes(value)
}

/** One resolved route: a concrete provider/model pair the tier currently serves. */
export interface ResolvedTierRoute {
  readonly provider: string
  readonly model: string
}

/**
 * Read-only access to the live Forage LLM class registry. Implementations
 * call the authenticated `class:<name>` resolution seam (`app/llm_proxy.py`
 * / `app/llm_model_classes.py`, project 1891788 step 7) over HTTP; tests
 * inject a fake. The registry's own read path is fail-soft (a transient
 * error resolves `undefined`, matching `resolve_class`'s Python contract);
 * this module owns the TTL cache and the fail-CLOSED policy gate on top of
 * that read.
 */
export interface ModelTierRegistryClient {
  /**
   * Resolve one class name (e.g. `subagent-basic`) to its live primary route.
   * @param className - the registry class name for this tier.
   * @param signal - caller cancellation.
   * @returns the resolved route, or `undefined` when the class is absent,
   *   paused, over budget, or the registry read failed.
   * @throws {SubagentError} `TIER_ACCESS_DENIED` when the registry positively
   *   refuses this caller (fenced class, caller not on the allowlist). This is
   *   the one case the client must not swallow into `undefined`: an access
   *   fence is a policy decision, not a transient miss.
   */
  resolveClass(className: string, signal: AbortSignal): Promise<ResolvedTierRoute | undefined>
}

/** Which registry class name backs each tier. Data naming, not a model literal. */
export interface ModelTierClassNames {
  readonly basic: string
  readonly mid: string
  readonly capable: string
}

/** Default class names, matching the seeded rows this step ships (see seed_rows in app/llm_model_classes.py). */
export const DEFAULT_MODEL_TIER_CLASS_NAMES: ModelTierClassNames = {
  basic: 'subagent-basic',
  mid: 'subagent-mid',
  capable: 'subagent-capable',
}

/** Config for {@link ModelTierResolver}. */
export interface ModelTierResolverConfig {
  readonly client: ModelTierRegistryClient
  /** Registry class name per tier. Defaults to {@link DEFAULT_MODEL_TIER_CLASS_NAMES}. */
  readonly classNames?: ModelTierClassNames
  /** Bounded cache TTL in milliseconds. Defaults to 5000 (mirrors `DISPATCH_STATE_TTL_SECONDS`'s 5s default). */
  readonly ttlMs?: number
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number
}

interface CacheEntry {
  readonly route: ResolvedTierRoute
  readonly at: number
}

/**
 * Resolves a {@link ModelTier} to a live `{provider, model}` route, backed by
 * the Forage class registry with a bounded-TTL cache and safe fallback to the
 * last good resolution on a transient miss. Never invents a route the
 * registry never served.
 */
export class ModelTierResolver {
  private readonly client: ModelTierRegistryClient
  private readonly classNames: ModelTierClassNames
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly cache = new Map<ModelTier, CacheEntry>()

  constructor(config: ModelTierResolverConfig) {
    this.client = config.client
    this.classNames = config.classNames ?? DEFAULT_MODEL_TIER_CLASS_NAMES
    this.ttlMs = config.ttlMs ?? 5000
    this.now = config.now ?? (() => Date.now())
  }

  /**
   * Resolve one tier to its currently live route.
   * @param tier - the requested complexity tier.
   * @param signal - caller cancellation, forwarded to the registry read.
   * @returns the resolved provider/model route.
   * @throws {SubagentError} `TIER_ACCESS_DENIED` when the registry positively
   *   refuses this caller for the tier's backing class.
   * @throws {SubagentError} `TIER_UNAVAILABLE` when the class has never
   *   resolved (no cache) and the live read failed, is paused, or has no
   *   usable model (over budget, unavailable route, unknown class). Fails
   *   closed rather than substitute a model the class did not declare.
   */
  async resolve(tier: ModelTier, signal: AbortSignal): Promise<ResolvedTierRoute> {
    const className = this.classNames[tier]
    const cached = this.cache.get(tier)
    const fresh = cached !== undefined && this.now() - cached.at < this.ttlMs
    if (fresh) return cached.route

    let route: ResolvedTierRoute | undefined
    try {
      route = await this.client.resolveClass(className, signal)
    } catch (error: unknown) {
      if (error instanceof SubagentError) throw error
      // Read failure: fall back to the safe path below (stale cache, else fail closed).
      route = undefined
    }

    if (route !== undefined) {
      this.cache.set(tier, { route, at: this.now() })
      return route
    }
    // Safe fallback to the authoritative source on miss: reuse a STALE cached
    // value over failing a call outright, matching the DISPATCH_STATE_TTL_SECONDS
    // pattern (insight #61507) — but only ever a value the registry once
    // actually served for this exact tier, never an invented default.
    if (cached !== undefined) return cached.route
    throw new SubagentError(
      `model tier "${tier}" (class "${className}") has no usable route: the registry is unreachable, `
      + 'the class is unseeded, paused, or over budget, and no prior resolution is cached',
      'TIER_UNAVAILABLE',
    )
  }
}

/** What a caller may supply to select a child's model for one delegation. */
export interface ModelSelectionRequest {
  /** A named complexity tier; mutually exclusive with `provider`/`model`. */
  readonly tier?: string
  /** An explicit provider pin; mutually exclusive with `tier`. Requires `model`. */
  readonly provider?: string
  /** An explicit model pin; mutually exclusive with `tier`. Requires `provider`. */
  readonly model?: string
}

/**
 * Validate one call's model selection before any registry read: reject an
 * unknown tier name and reject naming both a tier and an explicit
 * provider/model (ambiguous — the caller must pick one lane), and reject a
 * lone `provider` or lone `model` (an explicit pin names a route, not half of
 * one). A request with neither field is valid and resolves no override (the
 * child falls back to its configured/inherited route unchanged).
 * @param request - the model-facing tool arguments' selection fields.
 * @throws {SubagentError} `INVALID_MODEL_SELECTION` on an unknown tier, a
 *   conflicting combination, or a lone `provider`/`model`.
 */
export function assertValidModelSelection(request: ModelSelectionRequest): void {
  const hasTier = request.tier !== undefined
  const hasProvider = request.provider !== undefined
  const hasModel = request.model !== undefined
  if (hasTier && !isModelTier(request.tier)) {
    throw new SubagentError(
      `unknown model tier "${String(request.tier)}": expected one of ${MODEL_TIERS.join(', ')}`,
      'INVALID_MODEL_SELECTION',
    )
  }
  if (hasTier && (hasProvider || hasModel)) {
    throw new SubagentError(
      'model selection is ambiguous: pass either `tier` or both `provider` and `model`, not both forms',
      'INVALID_MODEL_SELECTION',
    )
  }
  if (hasProvider !== hasModel) {
    throw new SubagentError(
      'an explicit model selection requires both `provider` and `model`',
      'INVALID_MODEL_SELECTION',
    )
  }
}

/**
 * Resolve one validated model selection into an `AgentOptions` override, or
 * `undefined` when the caller named neither a tier nor an explicit model
 * (leave the child's route exactly as it would otherwise be). Call
 * {@link assertValidModelSelection} first — this trusts its invariants.
 * @param request - the validated selection.
 * @param resolver - the tier resolver to consult for a named tier.
 * @param signal - caller cancellation, forwarded to a tier read.
 * @returns the `{provider, model}` override to merge into child `agentOptions`, or `undefined`.
 */
export async function resolveModelSelection(
  request: ModelSelectionRequest,
  resolver: ModelTierResolver,
  signal: AbortSignal,
): Promise<Pick<AgentOptions, 'provider' | 'model'> | undefined> {
  if (request.provider !== undefined && request.model !== undefined) {
    return { provider: request.provider, model: request.model }
  }
  if (isModelTier(request.tier)) {
    const route = await resolver.resolve(request.tier, signal)
    return { provider: route.provider, model: route.model }
  }
  return undefined
}
