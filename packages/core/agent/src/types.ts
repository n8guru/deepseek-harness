/**
 * Durable agent session-event vocabulary shared with type-only consumers.
 *
 * @module @deepseek-ai/dsh-agent/types
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm/types'

/** Trusted same-process or authenticated producer identity; never accepted by session.prompt. */
export interface NotificationAdmission {
  origin: string
  sequence: string
  urgency?: { kind: 'security' | 'safety' | 'deadline'; reason: string }
}

/** One of the two ordered pending-message lists owned by an agent. */
export type InboxTarget = 'next-turn' | 'next-step'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One normalized mutation of an agent's durable pending-message lists.
     * Live dispatch precedes projection mutation, so synchronous observers may
     * read the pre-splice inbox to recover the removed messages.
     */
    'agent/inbox/spliced': {
      target: InboxTarget
      start: number
      removedCount?: number
      inserted: UserMessage[]
      outcome?: 'canceled'
      notification?: NotificationAdmission
    }
    /** Explicit Focus control; Check releases only the recorded fixed snapshot. */
    'agent/focus': {
      enabled: boolean
      check?: { id: string; messageIds: string[] }
    }
  }
}
