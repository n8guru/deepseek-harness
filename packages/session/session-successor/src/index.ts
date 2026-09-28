/**
 * Durable old→successor session lineage for cadence hand-forward. The OLD
 * session's log carries at most one `session/successor` fact, appended only
 * after the successor is ready: its first turn committed a completed
 * `turn/end`, and the current-pointer resolve names exactly that successor.
 * The fact is served through the `successor` projection key, so
 * `session.list`, the history tail page and mux `session/projection` frames
 * carry it without a bespoke wire path, including after the old session is
 * archived.
 *
 * @module @deepseek-ai/dsh-session-successor
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: resolves ctx.sessionProjections for the optional unit child.
import type {} from '@deepseek-ai/dsh-session-projection'
import type { SessionSuccessorFact } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionSuccessor: SessionSuccessorService
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The one durable successor of this session. Log-only: it never enters
     * the model surface or derived history.
     */
    'session/successor': SessionSuccessorFact
  }
}

/** Why a successor link was refused; every refusal leaves the old log unchanged. */
export type SessionSuccessorErrorCode =
  /** Malformed ids, generation or handoff id. */
  | 'invalid'
  /** The old session is not live in this store. */
  | 'old-not-live'
  /** The successor names the old session itself. */
  | 'self-link'
  /** The old session already has a different successor or hand-off. */
  | 'conflict'
  /** Following the successor's own lineage leads back to the old session. */
  | 'cycle'
  /** The successor belongs to a different workspace than the old session. */
  | 'wrong-workspace'
  /** The successor is not live in this store (cannot prove readiness). */
  | 'successor-not-live'
  /** The successor has not committed a completed first turn. */
  | 'successor-not-ready'
  /** The current-pointer resolve does not name the successor. */
  | 'pointer-mismatch'

/** Typed refusal from {@link SessionSuccessorService.record}. */
export class SessionSuccessorError extends Error {
  override readonly name = 'SessionSuccessorError'

  /**
   * @param code - machine-readable refusal class.
   * @param message - human-readable detail.
   */
  constructor(readonly code: SessionSuccessorErrorCode, message: string) {
    super(message)
  }
}

/** One successor claim from the hand-forward driver. */
export interface RecordSuccessorRequest extends SessionSuccessorFact {
  /**
   * The session id the caller's current-pointer resolve returned (Forage
   * `/studio/session/conductor/resolve`), or `null` when it resolved none.
   * Ignored when {@link RecordSuccessorOptions.resolvePointer} is supplied.
   */
  readonly pointerSessionId: string | null
}

/** Deployment hooks for one {@link SessionSuccessorService.record} call. */
export interface RecordSuccessorOptions {
  /**
   * Host-side workspace membership check (e.g. the workspace registry
   * account). Header cwd equality is always required in addition.
   */
  readonly sameWorkspace?: (oldId: SessionId, successorId: SessionId) => boolean
  /** Authoritative live pointer resolve; when present it replaces the caller-supplied pointer. */
  readonly resolvePointer?: (signal?: AbortSignal) => Promise<string | null>
  /** Caller cancellation. */
  readonly signal?: AbortSignal
}

/** Outcome of an accepted claim. */
export interface RecordSuccessorResult {
  /** `recorded` appended the fact now; `existing` is an idempotent replay of the same hand-off. */
  readonly status: 'recorded' | 'existing'
  /** The durable fact now on the old session's log. */
  readonly fact: SessionSuccessorFact
  /** Seq of the `session/successor` event on the old log. */
  readonly seq: number
}

const MAX_ID_LENGTH = 256
const MAX_LINEAGE_WALK = 1024

const factSchema = zod.object({
  successorSessionId: zod.string().min(1),
  successorGeneration: zod.number().int().positive(),
  handoffId: zod.string().min(1),
}).strict()

/**
 * Fold the durable successor from a session log: the FIRST `session/successor`
 * event wins (the invariant companion rejects any second one).
 * @param events - the session's committed event log.
 * @returns the successor fact with its event seq, or `null` when none.
 */
export function foldSuccessor(events: readonly SessionEvent[]): (SessionSuccessorFact & { readonly seq: number }) | null {
  for (const event of events) {
    if (event.type === 'session/successor') return { ...event.data, seq: event.seq }
  }
  return null
}

/**
 * Readiness half one: the log holds a committed `turn/end` whose reason is
 * `completed`. Creation, a queued prompt, an open turn, or a failed/aborted
 * turn are all insufficient.
 * @param events - the successor's committed event log.
 * @returns whether a completed turn has ended.
 */
export function hasCompletedTurn(events: readonly SessionEvent[]): boolean {
  return events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= MAX_ID_LENGTH
}

/** Log-backed successor service plus the `successor` projection unit. */
export class SessionSuccessorService extends Service {
  static inject = ['sessions']

  /** Serializes claims per old session so a concurrent replay observes the first append. */
  private readonly chains = new WeakMap<Session, Promise<unknown>>()

  constructor(ctx: Context) {
    super(ctx, 'sessionSuccessor')
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register<'successor', SessionSuccessorFact | null>({
        key: 'successor',
        schema: zod.union([factSchema, zod.null()]),
        init: () => null,
        // First-wins: once a successor is folded the state never changes again.
        apply: (state, event) => {
          if (state !== null || event.type !== 'session/successor') return state
          const { successorSessionId, successorGeneration, handoffId } = event.data
          return { successorSessionId, successorGeneration, handoffId }
        },
        view: state => state,
        stateVersion: 1,
      })
    })
  }

  /**
   * Read the durable successor of one live or replayed session.
   * @param session - the session whose log is the source of truth.
   * @returns the fact with its seq, or `null` when the session has no successor.
   */
  get(session: Session): (SessionSuccessorFact & { readonly seq: number }) | null {
    return foldSuccessor(session.events)
  }

  /**
   * Append the old session's one durable successor fact after proving
   * readiness, then flush the old log so the fact is durable before any
   * archive. Idempotent by `handoffId`; refusals leave the log unchanged so
   * the old session stays selected and unarchived.
   * @param old - the live old session.
   * @param request - the successor claim plus the caller's pointer resolve.
   * @param options - workspace/pointer hooks and cancellation.
   * @returns the recorded or already-existing fact.
   * @throws {SessionSuccessorError} on every refusal.
   */
  record(old: Session, request: RecordSuccessorRequest, options: RecordSuccessorOptions = {}): Promise<RecordSuccessorResult> {
    const previous = this.chains.get(old) ?? Promise.resolve()
    const run = previous.then(() => this.recordNow(old, request, options), () => this.recordNow(old, request, options))
    this.chains.set(old, run.catch(() => undefined))
    return run
  }

  private async recordNow(old: Session, request: RecordSuccessorRequest, options: RecordSuccessorOptions): Promise<RecordSuccessorResult> {
    options.signal?.throwIfAborted()
    const { successorSessionId, successorGeneration, handoffId } = request
    if (!validId(successorSessionId) || !validId(handoffId)
      || !Number.isSafeInteger(successorGeneration) || successorGeneration <= 0) {
      throw new SessionSuccessorError('invalid', 'successor claim needs non-empty ids and a positive integer generation')
    }
    const fact: SessionSuccessorFact = { successorSessionId, successorGeneration, handoffId }
    this.assertOldLive(old)
    if (successorSessionId === old.id) {
      throw new SessionSuccessorError('self-link', `session "${old.id}" cannot be its own successor`)
    }
    const replay = this.existing(old, fact)
    if (replay !== undefined) return replay

    const successor = this.ctx.sessions.get(successorSessionId as SessionId)
    if (successor === undefined) {
      throw new SessionSuccessorError('successor-not-live', `successor "${successorSessionId}" is not live in this host`)
    }
    if (old.header.cwd !== successor.header.cwd
      || (options.sameWorkspace !== undefined && !options.sameWorkspace(old.id, successor.id))) {
      throw new SessionSuccessorError('wrong-workspace', `successor "${successorSessionId}" is not in the old session's workspace`)
    }
    this.assertNoCycle(old, successor)

    // Readiness half one: a completed first turn that is durable, not merely buffered.
    await this.ctx.sessions.flush(successor)
    options.signal?.throwIfAborted()
    if (!hasCompletedTurn(successor.events)) {
      throw new SessionSuccessorError('successor-not-ready', `successor "${successorSessionId}" has not committed a completed turn`)
    }
    // Readiness half two: the current pointer names exactly this successor.
    const pointer = options.resolvePointer === undefined
      ? request.pointerSessionId
      : await options.resolvePointer(options.signal)
    options.signal?.throwIfAborted()
    if (pointer !== successorSessionId) {
      throw new SessionSuccessorError('pointer-mismatch', `current pointer resolves to ${JSON.stringify(pointer)}, not "${successorSessionId}"`)
    }

    // Awaits above may have raced another writer or disposal: re-check.
    this.assertOldLive(old)
    const raced = this.existing(old, fact)
    if (raced !== undefined) return raced
    this.assertNoCycle(old, successor)

    const event = old.append('session/successor', fact)
    await this.ctx.sessions.flush(old)
    return { status: 'recorded', fact, seq: event.seq }
  }

  private assertOldLive(old: Session): void {
    if (this.ctx.sessions.get(old.id) !== old) {
      throw new SessionSuccessorError('old-not-live', `session "${old.id}" is not live in this store`)
    }
  }

  /** Idempotent replay of the same hand-off, or a conflict with a different one. */
  private existing(old: Session, fact: SessionSuccessorFact): RecordSuccessorResult | undefined {
    const current = foldSuccessor(old.events)
    if (current === null) return undefined
    if (current.handoffId === fact.handoffId
      && current.successorSessionId === fact.successorSessionId
      && current.successorGeneration === fact.successorGeneration) {
      const { seq, ...stored } = current
      return { status: 'existing', fact: stored, seq }
    }
    throw new SessionSuccessorError('conflict', `session "${old.id}" already moved to "${current.successorSessionId}" (handoff ${current.handoffId})`)
  }

  /** Walk the successor's own lineage over live sessions; reaching the old session is a cycle. */
  private assertNoCycle(old: Session, successor: Session): void {
    const seen = new Set<string>([successor.id])
    let cursor: Session | undefined = successor
    for (let hops = 0; cursor !== undefined && hops < MAX_LINEAGE_WALK; hops++) {
      const next = foldSuccessor(cursor.events)
      if (next === null) return
      if (next.successorSessionId === old.id || seen.has(next.successorSessionId)) {
        throw new SessionSuccessorError('cycle', `linking "${old.id}" → "${successor.id}" would create a lineage cycle`)
      }
      seen.add(next.successorSessionId)
      cursor = this.ctx.sessions.get(next.successorSessionId as SessionId)
    }
  }
}

export default SessionSuccessorService
