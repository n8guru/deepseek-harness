/**
 * Stage-dock controller: which Forage conversation each DSH session is bound
 * to, and whether that session's dock is showing.
 *
 * There is no derivable mapping between a DSH session id and a Forage
 * conversation id — the operator supplies it, exactly as the `stage open` CLI
 * does for an agent — so the binding is state this package owns. It is keyed by
 * session because two sessions legitimately watch two different stages, and it
 * is persisted so a reload does not silently detach a dock the operator left
 * open.
 *
 * One controller instance serves both slot entries (the overlay panel and the
 * session-header toggle) so the toggle and the panel read one fact. The store
 * is the whole state: the controller adds only the two verbs that move it.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * localStorage identity of the persisted bindings. Versioned because the row
 * shape is rehydrated verbatim; a future incompatible shape takes a new key
 * rather than trying to migrate an untyped blob.
 */
export const STAGE_DOCK_PERSIST_KEY = 'dsh.stage-dock.v1'

/** One session's dock state. */
export interface StageDockEntry {
  /** Whether this session's dock is showing. */
  readonly open: boolean
  /** The bound Forage conversation id, or null while the session has no binding. */
  readonly conversationId: number | null
}

/** Every session's dock state, keyed by DSH session id. */
export interface StageDockState {
  readonly bySession: Readonly<Record<string, StageDockEntry>>
}

/** A session with no persisted row, and the value a corrupted row reads as. */
const ABSENT: StageDockEntry = Object.freeze({ open: false, conversationId: null })

/**
 * The conversation id a stored or typed value denotes, or null when it denotes
 * none. Forage conversation ids are positive integers; anything else (blank
 * input, a word, a rehydrated row an older shape or a hand-edited
 * localStorage entry left behind) is no binding rather than a malformed
 * iframe URL.
 * @param value - candidate id from user input or persisted state.
 * @returns the positive integer id, or null.
 */
export function conversationIdOf(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value.trim()) : value
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed <= 0) return null
  return parsed
}

/**
 * One session's dock state, normalized. Read through this rather than off the
 * record directly: persisted state is rehydrated without validation, so a row
 * that no longer matches this shape must read as absent.
 * @param state - the whole dock snapshot.
 * @param sessionId - session to read, or undefined when no session is current.
 * @returns the session's entry, or the absent value.
 */
export function entryOf(state: StageDockState, sessionId: string | undefined): StageDockEntry {
  const stored = sessionId === undefined ? undefined : state.bySession[sessionId]
  if (stored === undefined) return ABSENT
  // `typeof` rather than a truthiness read: the declared type says boolean,
  // but a rehydrated row is whatever was on disk, and a truthy non-boolean
  // there must not read as a showing dock.
  return {
    open: typeof stored.open === 'boolean' && stored.open,
    conversationId: conversationIdOf(stored.conversationId),
  }
}

/** Per-session Stage bindings and dock visibility, persisted to localStorage. */
export class StageDockController {
  /** Dock snapshot the renderer binds as `useStageDock`. */
  readonly store: SnapshotStore<StageDockState> = createSnapshotStore<StageDockState>(
    { bySession: {} },
    { persist: { name: STAGE_DOCK_PERSIST_KEY } },
  )

  /**
   * Show or hide one session's dock.
   * @param sessionId - the session whose dock the operator clicked.
   */
  toggle(sessionId: string): void {
    const entry = entryOf(this.store.getSnapshot(), sessionId)
    this.write(sessionId, { ...entry, open: !entry.open })
  }

  /**
   * Bind one session to a Forage conversation, and show the dock. Re-attaching
   * with a different id is how the operator edits a binding; a value that
   * denotes no conversation is ignored, leaving the current binding in place.
   * @param sessionId - the session to bind.
   * @param value - conversation id as typed, or as a number.
   */
  attach(sessionId: string, value: unknown): void {
    const conversationId = conversationIdOf(value)
    if (conversationId === null) return
    this.write(sessionId, { open: true, conversationId })
  }

  private write(sessionId: string, entry: StageDockEntry): void {
    const state = this.store.getSnapshot()
    this.store.set({ bySession: { ...state.bySession, [sessionId]: entry } })
  }
}
