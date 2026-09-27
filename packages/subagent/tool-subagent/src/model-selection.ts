/** Child LLM route selection for the subagent tool. */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { isModelTier, MODEL_TIERS } from '@deepseek-ai/dsh-subagent'
import type { ModelTier, ModelTierResolver } from '@deepseek-ai/dsh-subagent'

/** One exact child LLM route authorized by a user setting. */
export interface AllowedModelRoute {
  /** Registered LLM provider id. */
  readonly provider: string
  /** Provider-owned exact model id. */
  readonly model: string
}

/** Schema shared by the Host setting and its deployment base. */
export const AllowedModelRouteSchema: z<AllowedModelRoute> = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
})

/** Route-selection authority captured by one delegation definition. */
export interface ModelSelectionPolicy {
  /** Exact provider/model routes authorized for explicit selection. */
  readonly routes: readonly AllowedModelRoute[]
}

/**
 * Stable identity for one provider/model pair.
 * @param route - Exact provider/model route.
 * @returns Opaque key for equality checks.
 */
export function modelRouteKey(route: AllowedModelRoute): string {
  return `${route.provider}\0${route.model}`
}

/**
 * Reject malformed or duplicate route policy entries at a durable or configuration boundary.
 * @param routes - Candidate exact routes to validate.
 * @returns an assertion that the candidate is a validated exact-route array.
 */
export function assertAllowedModelRoutes(routes: unknown): asserts routes is readonly AllowedModelRoute[] {
  if (!Array.isArray(routes)) {
    throw new Error('subagent model selection requires an array of routes')
  }
  const seen = new Set<string>()
  const candidates: readonly unknown[] = routes
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)
      || !('provider' in candidate) || typeof candidate.provider !== 'string'
      || !('model' in candidate) || typeof candidate.model !== 'string'
      || candidate.provider.length === 0 || candidate.model.length === 0) {
      throw new Error('subagent model selection requires non-empty provider and model ids')
    }
    const route = { provider: candidate.provider, model: candidate.model }
    const key = modelRouteKey(route)
    if (seen.has(key)) {
      throw new Error(`subagent model selection repeats route "${route.provider}/${route.model}"`)
    }
    seen.add(key)
  }
}

/** Model-facing child LLM route fields. */
export interface DelegationModelRequest {
  readonly provider?: string
  readonly model?: string
  readonly reasoning_effort?: string
  /**
   * A named complexity tier (`basic`, `mid`, or `capable`) resolved dynamically
   * from the Forage LLM class registry at call time (mesh-dsh-merge step 55).
   * Mutually exclusive with `provider`/`model`: a tier names a policy-owned
   * route, an explicit pin names a fixed one, and mixing the two forms is
   * ambiguous about which one wins.
   */
  readonly tier?: string
}

/**
 * Whether a call explicitly selects any child LLM value, including a named tier.
 * @param request - Model-facing route fields from the tool call.
 * @returns Whether at least one route, tier, or effort field is present.
 */
export function hasDelegationModelRequest(request: DelegationModelRequest): boolean {
  return request.provider !== undefined
    || request.model !== undefined
    || request.reasoning_effort !== undefined
    || request.tier !== undefined
}

/** Reject an empty model-facing route value at the tool JSON boundary. */
function assertNonEmpty(value: string | undefined, field: keyof DelegationModelRequest): void {
  if (value !== undefined && value.length === 0) {
    throw new Error(`child LLM \`${field}\` must be non-empty`)
  }
}

/**
 * Reject a call that names both a complexity tier and an explicit
 * provider/model pin, and reject an unknown tier name, before any registry
 * read or route merge. A caller may always name exactly one selection form,
 * or neither.
 * @param request - Model-facing route fields from the tool call.
 * @throws when `tier` is unknown, or both `tier` and an explicit `provider`/`model` are present.
 */
export function assertValidTierSelection(request: DelegationModelRequest): asserts request is
  DelegationModelRequest & { readonly tier?: ModelTier } {
  if (request.tier === undefined) return
  if (!isModelTier(request.tier)) {
    throw new Error(`unknown model tier "${request.tier}": expected one of ${MODEL_TIERS.join(', ')}`)
  }
  if (request.provider !== undefined || request.model !== undefined) {
    throw new Error(
      'model selection is ambiguous: pass either `tier` or explicit `provider`/`model`, not both',
    )
  }
}

/**
 * Merge model-supplied selection fields over configured child defaults.
 * Provider and model form one route and must be supplied together. Changing
 * that route without an effort clears the configured route-owned effort.
 * @param parentOptions - Current parent values that supply missing child values.
 * @param configured - Tool-instance child defaults.
 * @param request - Model-facing route override.
 * @param enabled - Whether this tool instance permits model-facing selection.
 * @returns Child Agent options, preserving omission when no layer contributes one.
 */
export function requestedAgentOptions(
  parentOptions: AgentOptions,
  configured: AgentOptions | undefined,
  request: DelegationModelRequest,
  enabled: boolean,
): AgentOptions | undefined {
  if (!hasDelegationModelRequest(request)) return configured
  if (!enabled) {
    throw new Error('child model selection is disabled for this tool instance')
  }
  assertNonEmpty(request.provider, 'provider')
  assertNonEmpty(request.model, 'model')
  assertNonEmpty(request.reasoning_effort, 'reasoning_effort')
  if ((request.provider === undefined) !== (request.model === undefined)) {
    throw new Error('child LLM `provider` and `model` must be supplied together')
  }

  const baselineProvider = configured?.provider ?? parentOptions.provider
  const baselineModel = configured?.model ?? parentOptions.model
  const routeChanged = request.provider !== undefined
    && (request.provider !== baselineProvider || request.model !== baselineModel)
  const { reasoningEffort: _configuredReasoningEffort, ...configuredWithoutReasoning } = configured ?? {}
  return {
    ...routeChanged && request.reasoning_effort === undefined ? configuredWithoutReasoning : configured,
    ...request.provider === undefined ? {} : { provider: request.provider, model: request.model },
    ...request.reasoning_effort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(request.reasoning_effort) },
  }
}

/**
 * Enforce a settings-owned route list at the operation that creates the child.
 * Pure inheritance remains outside this policy because no model-facing choice
 * occurred; any explicit route or effort field must resolve to an allowed route.
 * @param policy - Selection authority captured for this Session.
 * @param parentOptions - Current parent values that supply missing child values.
 * @param requested - Effective child options after request/config merging.
 * @param request - Model-facing selection fields from the tool call.
 */
export function assertAllowedModelSelection(
  policy: ModelSelectionPolicy | undefined,
  parentOptions: AgentOptions,
  requested: AgentOptions | undefined,
  request: DelegationModelRequest,
): void {
  if (policy === undefined || !hasDelegationModelRequest(request)) return
  const provider = requested?.provider ?? parentOptions.provider
  const model = requested?.model ?? parentOptions.model
  if (provider === undefined || model === undefined) {
    throw new Error('cannot select child LLM values without an effective provider and model')
  }
  if (policy.routes.some(route => route.provider === provider && route.model === model)) return
  throw new Error(`child LLM route "${provider}/${model}" is not allowed for this Session`)
}

/**
 * Whether configured Agent options require route validation before delegation.
 * @param options - Tool-instance child defaults.
 * @returns Whether configured provider, model, or effort values must be resolved.
 */
export function hasConfiguredLlmSelection(options: AgentOptions | undefined): boolean {
  return options?.provider !== undefined
    || options?.model !== undefined
    || options?.reasoningEffort !== undefined
}

/**
 * Resolve an effective child route through its live adapter before the child is
 * created. The LLM runtime owns provider lookup, exact-model metadata, effort
 * validation, and adapter defaults.
 * @param llm - Live LLM runtime.
 * @param parentOptions - Current parent values whose compatible fields the child inherits.
 * @param requested - Per-child options after request/config merging.
 * @param signal - Tool-call cancellation signal.
 * @param inheritParentReasoningEffort - Whether an omitted effort may inherit from the parent route.
 */
export async function preflightChildLlmRoute(
  llm: LlmRuntime,
  parentOptions: AgentOptions,
  requested: AgentOptions | undefined,
  signal: AbortSignal,
  inheritParentReasoningEffort = true,
): Promise<void> {
  const provider = requested?.provider ?? parentOptions.provider
  const model = requested?.model ?? parentOptions.model
  if (provider === undefined || model === undefined) {
    throw new Error('cannot select child LLM values without an effective provider and model')
  }
  const routeChanged = provider !== parentOptions.provider || model !== parentOptions.model
  const reasoningEffort = requested?.reasoningEffort
    ?? (inheritParentReasoningEffort && !routeChanged ? parentOptions.reasoningEffort : undefined)
  await llm.resolveCallConfig({
    provider,
    model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }, signal)
}

/**
 * Resolve a validated `tier` field into concrete `provider`/`model` fields,
 * so every downstream step (`requestedAgentOptions`, `assertAllowedModelSelection`,
 * `preflightChildLlmRoute`) keeps treating the call as an ordinary explicit
 * route selection. Call {@link assertValidTierSelection} first. A request
 * without `tier` passes through unchanged with no registry read.
 * @param request - the model-facing request, already tier-validated.
 * @param resolver - the tier resolver to consult, or `undefined` when this
 *   tool instance has no registry-backed tier resolution configured.
 * @param signal - caller cancellation, forwarded to the registry read.
 * @returns an equivalent request with `tier` resolved into `provider`/`model`.
 * @throws when `request.tier` is present but no resolver is configured, or
 *   when the resolver itself fails closed (see {@link ModelTierResolver.resolve}).
 */
export async function resolveTierIntoRoute(
  request: DelegationModelRequest,
  resolver: ModelTierResolver | undefined,
  signal: AbortSignal,
): Promise<DelegationModelRequest> {
  if (request.tier === undefined) return request
  if (!isModelTier(request.tier)) {
    // assertValidTierSelection already rejected this synchronously; this is
    // an internal-consistency guard, not a new user-facing validation path.
    throw new Error(`unknown model tier "${request.tier}": expected one of ${MODEL_TIERS.join(', ')}`)
  }
  if (resolver === undefined) {
    throw new Error('model tier selection is not configured for this tool instance (no registry-backed resolver)')
  }
  const tier: ModelTier = request.tier
  const route = await resolver.resolve(tier, signal)
  const { tier: _tier, ...rest } = request
  return { ...rest, provider: route.provider, model: route.model }
}
