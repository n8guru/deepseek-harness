/**
 * Pure types of the session-successor domain: the ONE home of the
 * `successor` projection-key declaration and the `session/successor` event
 * payload, free of host-side value imports so the client namespace can
 * re-export it with zero duplication.
 *
 * @module @deepseek-ai/dsh-session-successor/types
 */

// Marks this file a module so the declarations below AUGMENT their tables.
export {}

/**
 * Durable old→successor lineage fact. Appended once to the OLD session's
 * log, only after the successor is ready (committed first `turn/end` plus a
 * current-pointer resolve naming exactly this successor).
 */
export interface SessionSuccessorFact {
  /** The session that now carries the cadence. Never the old session itself. */
  readonly successorSessionId: string
  /** Positive generation number of the successor (the "N+1" of the notice). */
  readonly successorGeneration: number
  /** Idempotency key of the hand-off; a replay with the same key is a no-op. */
  readonly handoffId: string
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The session's durable successor (first and only `session/successor`
     * event), or `null` while the session is still the current cadence.
     */
    successor: SessionSuccessorFact | null
  }
}
