/**
 * HTTP {@link ModelTierRegistryClient}: calls the Forage LLM class registry's
 * authenticated `class:<name>` resolution seam (`app/llm_proxy.py` /
 * `app/llm_model_classes.py`, project 1891788 step 7) over the scoped vault
 * bearer key, matching the estate's documented calling convention for that
 * seam. This is the ONE place a registry endpoint shape is known; the
 * `ModelTierResolver` this feeds stays transport-agnostic and unit-testable
 * against a fake.
 * @module @deepseek-ai/dsh-tool-subagent/model-tier-http-client
 */

import type { ModelTierRegistryClient, ResolvedTierRoute } from '@deepseek-ai/dsh-subagent'
import { SubagentError } from '@deepseek-ai/dsh-subagent'

/** Config for {@link createModelTierHttpClient}. */
export interface ModelTierHttpClientConfig {
  /** Base URL of the Forage LLM gateway, e.g. `https://forage.ink`. No trailing slash. */
  readonly baseURL: string
  /** Resolve the current scoped vault bearer key at call time (never cached across calls). */
  readonly resolveBearer: () => Promise<string | undefined>
  /** Injectable fetch for tests; defaults to the global. */
  readonly fetchImpl?: typeof fetch
  /** Per-request timeout in milliseconds. Defaults to 5000. */
  readonly timeoutMs?: number
}

interface ClassResolutionResponse {
  readonly models?: readonly string[]
}

/** Split one `provider/model` catalog id into its two parts, or `undefined` when malformed. */
function splitModelId(id: string): ResolvedTierRoute | undefined {
  const slash = id.indexOf('/')
  if (slash <= 0 || slash === id.length - 1) return undefined
  return { provider: id.slice(0, slash), model: id.slice(slash + 1) }
}

/**
 * Build an HTTP-backed {@link ModelTierRegistryClient} against the Forage LLM
 * gateway's class resolution seam.
 * @param config - endpoint, bearer resolution, and transport overrides.
 * @returns a client `ModelTierResolver` can consult.
 */
export function createModelTierHttpClient(config: ModelTierHttpClientConfig): ModelTierRegistryClient {
  const fetchImpl = config.fetchImpl ?? fetch
  const timeoutMs = config.timeoutMs ?? 5000
  return {
    async resolveClass(className: string, signal: AbortSignal): Promise<ResolvedTierRoute | undefined> {
      const bearer = await config.resolveBearer()
      if (bearer === undefined || bearer.length === 0) {
        // No bearer configured: a read-availability miss, not a policy refusal.
        // The resolver's own TTL-cache-with-fallback owns what happens next.
        return undefined
      }
      const controller = new AbortController()
      // The caller signal may already be aborted by the time the async
      // `resolveBearer()` above resolves — `addEventListener('abort', ...)`
      // never fires for an event that already happened, so that case must be
      // checked explicitly rather than relying on the listener alone.
      if (signal.aborted) controller.abort(signal.reason)
      const onAbort = (): void => controller.abort(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      const timeout = setTimeout(() => controller.abort(new Error('model tier registry read timed out')), timeoutMs)
      try {
        const response = await fetchImpl(
          `${config.baseURL}/api/llm/decisions`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${bearer}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ domain: 'llm_model_class', resolve: `class:${className}` }),
            signal: controller.signal,
          },
        )
        if (response.status === 403) {
          throw new SubagentError(
            `model tier registry refused this caller for class "${className}"`,
            'TIER_ACCESS_DENIED',
          )
        }
        if (!response.ok) return undefined
        const body = await response.json() as ClassResolutionResponse
        const first = body.models?.[0]
        return first === undefined ? undefined : splitModelId(first)
      } catch (error: unknown) {
        if (error instanceof SubagentError) throw error
        // Network/transport/parse failure: a read miss the resolver's
        // fallback-to-cache-or-fail-closed policy owns, never a thrown surprise.
        return undefined
      } finally {
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
      }
    },
  }
}
