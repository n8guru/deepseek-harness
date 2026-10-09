/**
 * Durable agent session-event vocabulary shared with type-only consumers.
 *
 * @module @deepseek-ai/dsh-agent/types
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
// Type-only: the Workspace registry's archive-admission family map this registry merges `turn` into.
import type {} from '@deepseek-ai/dsh-workspace/types'
import type { OptionalSessionSeq, SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { TypertContext, TypertLookup } from '@deepseek-ai/dsh-typert-protocol'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Public live-agent handle; the runtime face augments its live capabilities. */
export interface Agent {
  /** Session-backed Agent identity. */
  readonly id: SessionId
}

declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    /** The session's own Agent is inside a turn, including one waiting for an approval or an answer. */
    turn: true
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    agent: TypertLookup<Agent, SessionId>
  }

  interface TypertContextMap {
    /** Agent Context identity shared by Host and Client adapters. */
    agent: TypertContext<SessionId>
  }
}

/** One of the two ordered pending-message lists owned by an agent. */
export type InboxTarget = 'next-turn' | 'next-step'

/** Opaque epoch receipt issued by a native host admission owner. */
export interface HostAdmissionTicket { readonly nativeAdmission?: never }
/** Opaque one-use child publication and immutable initial-input authority. */
export interface HostInitialAdmission { readonly sessionId: SessionId; readonly messageId: UserMessage['id'] }
/** Counted pre-close operation; release only after publication/cleanup or backend quiescence. */
export interface HostReservation {
  readonly ticket: HostAdmissionTicket
  /** Each child is individually admitted synchronously while OPEN. */
  child?(sessionId: SessionId, message: UserMessage, parent: Agent, signal: AbortSignal,
    compiler?: (child: Agent, original: UserMessage) => UserMessage): HostInitialAdmission
  release(): void
}
/** Central native lifecycle admission; absent when the optional durable receiver is not mounted. */
export interface HostAdmission {
  readonly open: boolean
  /** Process-local native admission revision, advanced before observers; absent means unsupported. */
  readonly controlRevision?: number
  /** Process-local identity of the authoritative admission owner. */
  readonly controlEpochId?: string
  begin(): HostAdmissionTicket
  /** Optional native drain accounting. Tickets preserve only work admitted before close. */
  reserve?(kind: 'publication' | 'job' | 'delegate' | 'workflow', sessionId?: SessionId): HostReservation
  /** Constructor-bound instrumentation receipt; absence/preexisting service cannot imply global coverage. */
  coverage?(kind: 'publication' | 'job' | 'delegate' | 'workflow', producer: object, joined?: () => boolean): object
  assert(ticket?: HostAdmissionTicket): void
  initial?(capability: HostInitialAdmission, sessionId: SessionId, parent: Agent | undefined, consume: boolean): {
    ticket: HostAdmissionTicket
    message: UserMessage
    signal: AbortSignal
    deferred: boolean
    release(): void
    join(): void
  }
  /** Invoke only the compiler bound before await; supplied message must match its fixed output. */
  compileInitial?(capability: HostInitialAdmission, child: Agent, message?: UserMessage): {
    ticket: HostAdmissionTicket
    message: UserMessage
    release(): void
  }
  /** Restrict child publication tickets to their sole immutable receipt. */
  assertReceipt?(ticket: HostAdmissionTicket, message: UserMessage): void
  assertMaintenancePermit?(ticket: HostAdmissionTicket): void
  /** Validate an opaque native permit and bind it to exactly one session. */
  forSession?(permit: HostAdmissionTicket, sessionId: SessionId): HostAdmission
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    hostAdmission?: HostAdmission
    /** Live authenticated activity owner; absence holds gated input. Never persisted. */
    notificationActivity?: {
      /**
       * Read eligibility and owner revisions; the driver owns idle selection and log-sequence fences.
       * @param agent - exact live Agent, including a selected background turn.
       * @returns current revision, or undefined when activity or native controls hold entry.
       */
      inspect(agent: Agent): string | undefined
    }
    /** Native receiver mounted explicitly; transport supplies an authenticated owner. */
    maintenanceReceiver?: { receive(authenticatedOwner: string, command: unknown): Promise<unknown> }
  }
  interface Events { 'host-admission/changed': () => void }
}

/** Trusted producer identity attached by a same-process owner or authenticated transport. */
export interface NotificationAdmission {
  origin: string
  sequence: string
  urgency?: { kind: 'safety' | 'security' | 'deadline'; reason: string } | undefined
  /** Requires the preceding required-on-read gated receipt batch; never an opt-out. */
  activityGated?: true | undefined
}

/** Recorded activity/control observation, not permission to deliver after a restart or await. */
export interface NotificationActivityGuard {
  version: 1
  hostEpoch: string
  bindingEpoch: string
  activityRevision: number
  controlRevision: number
}

/** One ordered receipt staged in the existing notification projection. */
export interface GatedNotificationItem {
  message: UserMessage
  admission: NotificationAdmission & { activityGated: true }
}

/** Required-on-read custody metadata; pending input still uses ordinary inbox splices. */
export interface GatedNotificationBatch {
  version: 1
  sessionId: SessionId
  target: InboxTarget
  guard: NotificationActivityGuard
  items: GatedNotificationItem[]
}

/** Driver-owned durable notification controls; unsupported drivers fail closed at ingress. */
export interface NotificationInbox {
  readonly focus: { enabled: boolean; queued: number }
  /** Native control values without queue evaluation; absent on unsupported drivers. */
  readonly controls?: { readonly stop: 'clear' | 'stopped' | 'unknown'; readonly focus: boolean; readonly revision: number }
  /** Trusted explicit operator resume only; never call from activity or generic prompts. Does not wake input or resume goals. */
  resumeOperator?(): void
  readonly hasForeground: boolean
  admit(target: InboxTarget, message: UserMessage, admission: NotificationAdmission): boolean
  /**
   * Stage held receipts only; this operation never authorizes release or wakes work.
   * @param target - existing inbox list receiving the ordered selection.
   * @param items - one to ten identified messages and authenticated producer admissions.
   * @param guard - original activity/control observation retained as historical metadata.
   * @returns in-memory identities in request order, not a custody or delivery ACK.
   * Caller must obtain a successful participating Session flush before acknowledging custody.
   */
  stageActivityGated?(target: InboxTarget, items: GatedNotificationItem[], guard: NotificationActivityGuard): readonly { sequence: string; messageId: UserMessage['id']; duplicate: boolean }[]
  /** Native inbox lifecycle admission, false synchronously when disposed. */
  readonly accepting?: boolean
  /** Native-only opaque session-bound maintenance receipt capability; never a transport field. */
  admitMaintenance?(permit: HostAdmissionTicket, target: InboxTarget, message: UserMessage, admission: NotificationAdmission): boolean
  /**
   * Identify custody that an ungated caller must not acknowledge or re-admit.
   * @param origin - authenticated producer namespace.
   * @param sequence - producer receipt identity.
   * @returns whether the retained receipt requires activity-gated handling.
   */
  isActivityGatedReceipt?(origin: string, sequence: string): boolean
  receipt(origin: string, sequence: string): UserMessage | undefined
  isPendingReceipt(origin: string, sequence: string): boolean
  isHeld(message: UserMessage): boolean
  setFocus(enabled: boolean): void
  check(id: string): readonly string[]
}

/** Durable notification state projected independently of pending-message splices. */
export interface NotificationState {
  inheritedEventCount: number
  enabled: boolean
  receipts: readonly {
    target: InboxTarget
    message: UserMessage
    admission: NotificationAdmission
    activityGate?: { sessionId: SessionId; guard: NotificationActivityGuard } | undefined
  }[]
  entered: readonly string[]
  terminal: readonly { messageId: string; reason: 'rejected' | 'discarded' | 'disposed' }[]
  released: readonly string[]
  checks: readonly { id: string; messageIds: readonly string[] }[]
}

/** Complete pending Inbox value reconstructed from durable splices. */
export interface InboxState {
  readonly 'next-turn': readonly UserMessage[]
  readonly 'next-step': readonly UserMessage[]
}

/**
 * Wire-JSON pending Inbox value. Each message round-trips the session log
 * losslessly, but the fold state's full `UserMessage` type cannot cross a
 * typert Remote boundary (its source union carries an `unknown` replay
 * field), so the typed projection table keeps this JSON-safe form.
 */
export interface InboxWireState {
  readonly 'next-turn': readonly JsonValue[]
  readonly 'next-step': readonly JsonValue[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Pending agent input reconstructed from durable inbox splices. */
    inbox: InboxState
    notifications: NotificationState
  }
  interface SessionProjectionMap {
    /** Pending agent input reconstructed from durable inbox splices. */
    inbox: InboxWireState
  }
}

/**
 * Turn and step boundaries folded from one agent session log.
 *
 * Reader contract: the key is registered by `dsh-agent-loop` and absent
 * otherwise. Without agent-loop no turn events exist, so readers treat an
 * absent key as "no open turn / no boundaries" — capability absence, not a
 * corrupt state. A reader whose behavior has no safe fallback for that
 * absence (the step-open decision, for example) may fail loud instead.
 */
export interface TurnBoundaryProjection {
  /** Seq of the open turn's `turn/start`, or null between turns. */
  readonly openTurnStartSeq: OptionalSessionSeq
  /** Seq of the latest `step/start` event, or null before the first step. */
  readonly lastStepStartSeq: OptionalSessionSeq
  /** The latest step boundary (`step/start` or `step/end`) and its seq, or null before the first step boundary. */
  readonly lastStepBoundary: { readonly kind: 'start' | 'end'; readonly seq: SessionSeq } | null
  /** Turn number of the latest `turn/start`; 0 before the first turn. */
  readonly lastTurn: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Operator Focus setting and idempotent bounded Check snapshot. */
    'agent/focus': { enabled: boolean; check?: { id: string; messageIds: string[] } }
    /** Ordered held receipts and their original activity/control binding; never ignorable. */
    'agent/notification/activity-gated': GatedNotificationBatch
    /** Explicit terminal disposition retains producer evidence but forbids execution replay. */
    'agent/notification/terminal': { messageIds: string[]; reason: 'rejected' | 'discarded' | 'disposed' }
    /**
     * One normalized mutation of an agent's durable pending-message lists.
     * The session-projection registry applies the committed event before
     * `Session.append()` returns; Inbox live notifications follow that commit.
     */
    'agent/inbox/spliced': {
      target: InboxTarget
      start: number
      removedCount?: number
      inserted: UserMessage[]
      notification?: NotificationAdmission
      outcome?: 'canceled'
    }
  }
}
