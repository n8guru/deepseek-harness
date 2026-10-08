/** Optional synchronous backend evidence. No I/O, idle inference, or cancellation ACKs. */
export interface LlmBackendTurn {
  threadId: string
  turnId: string
  state: 'JOINED' | 'UNKNOWN'
  pendingRequests: readonly (string | number)[]
  /** Actual provider terminal, bound to the same immutable backend identities. */
  terminal?: { threadId: string; turnId: string; status: 'completed' | 'failed' | 'interrupted' }
}
export interface LlmBackendStatus {
  state: 'JOINED' | 'UNKNOWN'
  turns: readonly LlmBackendTurn[]
  startingTurns: number
  uncertainStarts: number
  unattributedEvents: number
}
export interface LlmBackendCoverage {
  state: 'JOINED' | 'UNKNOWN'
  participants: readonly {
    providers: readonly string[]
    /** Actual committed route generations on this instance, including retained withdrawn routes. */
    registrations: readonly { provider: string; generation: number }[]
    callers: readonly { phase: 'prepare' | 'stream'; sessionId?: string }[]
    status?: LlmBackendStatus
    reason?: string
  }[]
}

/** Refuse malformed or mismatched evidence even from an untyped plugin. */
export function backendStatusJoined(status: LlmBackendStatus): boolean {
  return status.state === 'JOINED' && status.startingTurns === 0
    && status.uncertainStarts === 0 && status.unattributedEvents === 0
    && Array.isArray(status.turns)
    && new Set(status.turns.map(turn => JSON.stringify([turn.threadId, turn.turnId]))).size === status.turns.length
    && status.turns.every(turn => typeof turn.threadId === 'string' && turn.threadId.length > 0
      && typeof turn.turnId === 'string' && turn.turnId.length > 0 && turn.state === 'JOINED'
      && Array.isArray(turn.pendingRequests) && turn.pendingRequests.length === 0
      && turn.terminal?.threadId === turn.threadId && turn.terminal.turnId === turn.turnId
      && ['completed', 'failed', 'interrupted'].includes(turn.terminal.status))
}
