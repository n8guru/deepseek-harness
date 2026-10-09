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
/** Machine-readable refusal reasons, independent of provider names or a deployment allowlist. */
export const backendRefusalReasons = {
  unsupported: 'backend settlement unsupported',
  unavailable: 'backend settlement unavailable or malformed',
  'identity-lost': 'backend identity evidence disappeared',
  unjoined: 'backend has unjoined or ambiguous work',
  'caller-active': 'initiating native caller has not settled',
} as const

/** A refusal applies to the participant's exact provider routes and retained registration generations. */
export type LlmBackendRefusal = keyof typeof backendRefusalReasons

export interface LlmBackendCoverage {
  state: 'JOINED' | 'UNKNOWN'
  participants: readonly {
    providers: readonly string[]
    /** Actual committed route generations on this instance, including retained withdrawn routes. */
    registrations: readonly { provider: string; generation: number }[]
    callers: readonly { phase: 'prepare' | 'stream'; sessionId?: string }[]
    status?: LlmBackendStatus
    /** Stable refusal code; absent only when this instance and all its native callers are joined. */
    refusal?: LlmBackendRefusal
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

interface LedgerTurn {
  readonly threadId: string
  readonly turnId: string
  state: 'JOINED' | 'UNKNOWN'
  pendingRequests: string[]
  terminal?: { threadId: string; turnId: string; status: 'completed' | 'failed' | 'interrupted' }
}

/**
 * Adapter-owned record of the provider work its own calls started. A turn is
 * JOINED only on a provider-sent terminal (a stream terminal event or a fully
 * read HTTP error response). Caller abort, transport failure, idle timeout or a
 * consumer that stops early leaves the dispatched request pending, so the turn
 * stays UNKNOWN: a client-side cancellation is not proof the backend (incl. its
 * server-side tools) stopped. Identities are retained for the instance lifetime
 * because the runtime refuses evidence that disappears.
 */
export class LlmBackendLedger {
  private starting = 0
  private sequence = 0
  private readonly turns: LedgerTurn[] = []

  /** Synchronous detached evidence for {@link LlmAdapter.backendStatus}. */
  status(): LlmBackendStatus {
    const turns = this.turns.map(turn => ({
      threadId: turn.threadId, turnId: turn.turnId, state: turn.state, pendingRequests: [...turn.pendingRequests],
      ...turn.terminal === undefined ? {} : { terminal: { ...turn.terminal } },
    }))
    const joined = this.starting === 0 && turns.every(turn => turn.state === 'JOINED')
    return { state: joined ? 'JOINED' : 'UNKNOWN', turns, startingTurns: this.starting, uncertainStarts: 0, unattributedEvents: 0 }
  }

  /**
   * Open one adapter call. It counts as a starting turn until its first provider request leaves.
   * @param threadId - session id when known; calls without one share an explicit thread.
   */
  begin(threadId?: string): LlmBackendCall {
    this.starting += 1
    let turn: LedgerTurn | undefined
    let requests = 0
    let closed = false
    let lastAnswer: 'failed' | undefined
    const settle = (status: 'completed' | 'failed') => {
      if (turn === undefined || turn.terminal !== undefined) return
      turn.pendingRequests = []
      turn.state = 'JOINED'
      turn.terminal = { threadId: turn.threadId, turnId: turn.turnId, status }
    }
    return {
      dispatch: () => {
        if (closed || turn?.terminal !== undefined) throw new Error('backend call already settled')
        requests += 1
        if (turn === undefined) {
          this.starting -= 1
          this.sequence += 1
          turn = { threadId: threadId === undefined || threadId.length === 0 ? 'unattributed-calls' : threadId,
            turnId: `call-${this.sequence}`, state: 'UNKNOWN', pendingRequests: [] }
          this.turns.push(turn)
        }
        turn.state = 'UNKNOWN'
        turn.pendingRequests.push(`request-${requests}`)
        lastAnswer = undefined
      },
      answered: () => {
        // The provider returned a complete terminal response for the current request.
        if (turn === undefined || turn.terminal !== undefined) return
        turn.pendingRequests.pop()
        lastAnswer = 'failed'
      },
      terminal: (status) => { if (!closed) settle(status) }, // late evidence after teardown is not trusted
      close: () => {
        if (closed) return
        closed = true
        if (turn === undefined) { this.starting -= 1; return } // nothing reached the provider
        if (turn.terminal === undefined && turn.pendingRequests.length === 0 && lastAnswer !== undefined) settle(lastAnswer)
        // Otherwise a dispatched request has no provider terminal: it stays UNKNOWN, never idle.
      },
    }
  }
}

/** One adapter call's settlement hooks. `close()` must run after the transport is torn down. */
export interface LlmBackendCall {
  /** A provider request is about to leave this process. */
  dispatch(): void
  /** The current request received a complete provider error response (it may be retried). */
  answered(): void
  /** The provider sent its terminal for this call. */
  terminal(status: 'completed' | 'failed'): void
  /** The call's transport is torn down; unanswered requests remain UNKNOWN. */
  close(): void
}
