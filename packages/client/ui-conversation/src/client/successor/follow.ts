/**
 * Cadence successor follower — one per browser tab, framework-free. The host
 * projection `successor` on the OLD session is the only authority: when this
 * tab is showing a session whose durable successor appears, the tab moves its
 * unsent draft (text + images) to the successor and selects it, without a
 * click and without ever submitting. Rules:
 *
 * - Acts only while THIS tab's own selection is the old id; a projection that
 *   lands after a manual switch elsewhere is ignored (manual selection wins).
 * - Auto-follow happens only when the fact is first observed while the tab
 *   is already on the old id (live frame, reconnect, or reload restore). A
 *   deliberate visit to an old session whose successor is already known — a
 *   sidebar click or the notice back-link — never redirects; it offers
 *   "Go to current Cadence" instead (no redirect loop).
 * - A tab-local one-shot keyed by handoff id absorbs duplicate mux/replay.
 * - A nonempty successor composer is never overwritten: when both drafts are
 *   nonempty and differ, the tab stays put and offers an explicit open, both
 *   drafts remaining where they are.
 * - The source draft is cleared only after the destination accepted it; a
 *   refused transfer neither clears nor navigates, and retries on the next
 *   change (projection, list, or reconnect) — never by polling.
 *
 * @module
 */

// Type-only: the `successor` SessionProjectionMap key merge (single source, the domain's pure outlet).
import type {} from '@deepseek-ai/dsh-session-successor/client'

/** The durable old→successor fact as projected by the host (`successor` key). */
export interface SuccessorFact {
  readonly successorSessionId: string
  readonly successorGeneration: number
  readonly handoffId: string
}

/** Unsent composer content of one session. */
export interface DraftContent {
  readonly draft: string
  readonly imageIds: readonly string[]
}

/** One-line notice state for this tab. */
export interface SuccessorNotice {
  /**
   * `moved`: now on the successor after an automatic move.
   * `superseded`: deliberately viewing an old session that has a successor.
   * `conflict`: both composers hold different drafts; explicit open required.
   * `failed`: the draft could not be moved; staying on the old session.
   */
  readonly kind: 'moved' | 'superseded' | 'conflict' | 'failed'
  readonly handoffId: string
  readonly fromId: string
  readonly toId: string
  readonly generation: number
}

/** Tab-local string set (sessionStorage-backed in the browser). */
export interface TabLocalSet {
  has(value: string): boolean
  add(value: string): void
}

/** Everything the follower reads or drives; every member is synchronous. */
export interface SuccessorFollowerDeps {
  /** This tab's current selection. */
  current(): string | undefined
  /** Durable successor of a session from its projection store; `null`/`undefined` when none known. */
  successorOf(id: string): SuccessorFact | null | undefined
  /** Unsent content of a session, or `undefined` when its composer cannot be resolved yet. */
  readDraft(id: string): DraftContent | undefined
  /** Install content on the destination composer; `false` when it refused (nothing changed). */
  installDraft(id: string, content: DraftContent): boolean
  /** Clear exactly the transferred content from the source composer. */
  clearDraft(id: string, content: DraftContent): void
  /** Select a session in this tab (runtime `open(id)`). */
  open(id: string): void
  /** Handoff ids this tab already followed or was deliberately taken back from. */
  handled: TabLocalSet
  /** Handoff ids whose notice this tab dismissed. */
  dismissed: TabLocalSet
}

function isEmpty(content: DraftContent): boolean {
  return content.draft.trim() === '' && content.imageIds.length === 0
}

function sameContent(a: DraftContent, b: DraftContent): boolean {
  return a.draft === b.draft && a.imageIds.length === b.imageIds.length && a.imageIds.every((id, i) => id === b.imageIds[i])
}

/** The per-tab follower. Call {@link evaluate} on any selection, list, projection or connection change. */
export class SuccessorFollower {
  private noticeValue: SuccessorNotice | null = null
  private readonly listeners = new Set<() => void>()
  /** Selection this follower last saw, and whether it was entered deliberately with the fact already known. */
  private seenSelection: string | undefined
  private deliberate = false
  private started = false
  private evaluating = false

  constructor(private readonly deps: SuccessorFollowerDeps) {}

  /** Current notice (`null` when none). */
  getSnapshot = (): SuccessorNotice | null => this.noticeValue

  /**
   * Subscribe to notice changes.
   * @param listener - change callback.
   * @returns unsubscribe.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Re-derive this tab's action from current state. Idempotent and reentrancy-safe. */
  evaluate(): void {
    if (this.evaluating) return
    this.evaluating = true
    try {
      this.step()
    } finally {
      this.evaluating = false
    }
  }

  /** Notice back-link: open the old transcript without being redirected back. */
  openPrevious(): void {
    const notice = this.noticeValue
    if (notice === null) return
    this.deps.handled.add(notice.handoffId)
    this.deliberate = true
    this.seenSelection = notice.fromId
    this.deps.open(notice.fromId)
    this.evaluate()
  }

  /** Explicit "Go to current Cadence" / "Open generation N+1": no draft is moved or overwritten. */
  openSuccessor(): void {
    const notice = this.noticeValue
    if (notice === null) return
    this.deps.handled.add(notice.handoffId)
    this.seenSelection = notice.toId
    this.deliberate = false
    this.deps.open(notice.toId)
    this.setNotice({ ...notice, kind: 'moved' })
  }

  /** Dismiss the notice for this handoff in this tab. */
  dismiss(): void {
    const notice = this.noticeValue
    if (notice === null) return
    this.deps.dismissed.add(notice.handoffId)
    this.setNotice(null)
  }

  private step(): void {
    const id = this.deps.current()
    if (id !== this.seenSelection) {
      // The first selection a tab sees is a restore (reload/reconnect), never a deliberate visit.
      const known = id === undefined ? false : this.deps.successorOf(id) != null
      this.deliberate = this.started && known
      this.seenSelection = id
    }
    this.started = true
    if (id === undefined) { this.setNotice(null); return }
    const fact = this.deps.successorOf(id)
    if (fact == null) {
      // Keep a `moved` notice while on its successor; drop anything else.
      const notice = this.noticeValue
      if (notice !== null && !(notice.toId === id && notice.kind === 'moved')) this.setNotice(null)
      return
    }
    const base = { handoffId: fact.handoffId, fromId: id, toId: fact.successorSessionId, generation: fact.successorGeneration }
    if (fact.successorSessionId === id) return
    if (this.deliberate || this.deps.handled.has(fact.handoffId)) {
      this.setNotice({ ...base, kind: 'superseded' })
      return
    }
    const source = this.deps.readDraft(id)
    const target = this.deps.readDraft(fact.successorSessionId)
    // The successor is not resolvable in this tab yet (list not caught up): wait for the next change.
    if (source === undefined || target === undefined) return
    if (!isEmpty(source) && !isEmpty(target) && !sameContent(source, target)) {
      this.setNotice({ ...base, kind: 'conflict' })
      return
    }
    if (!isEmpty(source) && !sameContent(source, target)) {
      if (!this.deps.installDraft(fact.successorSessionId, source)) {
        this.setNotice({ ...base, kind: 'failed' })
        return
      }
      this.deps.clearDraft(id, source)
    }
    // Manual selection wins: never navigate a tab whose selection moved meanwhile.
    if (this.deps.current() !== id) return
    this.deps.handled.add(fact.handoffId)
    this.seenSelection = fact.successorSessionId
    this.deliberate = false
    this.deps.open(fact.successorSessionId)
    this.setNotice({ ...base, kind: 'moved' })
  }

  private setNotice(next: SuccessorNotice | null): void {
    const shown = next !== null && this.deps.dismissed.has(next.handoffId) ? null : next
    const prev = this.noticeValue
    if (prev === shown || (prev !== null && shown !== null
      && prev.kind === shown.kind && prev.handoffId === shown.handoffId && prev.fromId === shown.fromId)) return
    this.noticeValue = shown
    for (const listener of this.listeners) listener()
  }
}

/**
 * Tab-local string set persisted in `sessionStorage` (per tab, survives
 * reload); degrades to memory when storage is unavailable.
 * @param key - storage key.
 * @param storage - the storage (defaults to `globalThis.sessionStorage`).
 * @returns the set.
 */
export function tabLocalSet(key: string, storage: Storage | undefined = typeof sessionStorage === 'undefined' ? undefined : sessionStorage): TabLocalSet {
  const memory = new Set<string>()
  try {
    const raw = storage?.getItem(key)
    if (raw) for (const value of JSON.parse(raw) as unknown[]) if (typeof value === 'string') memory.add(value)
  } catch { /* corrupt or unavailable: start empty */ }
  return {
    has: value => memory.has(value),
    add: (value) => {
      memory.add(value)
      try { storage?.setItem(key, JSON.stringify([...memory].slice(-200))) } catch { /* quota/unavailable: memory only */ }
    },
  }
}
