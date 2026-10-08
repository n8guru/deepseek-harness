/**
 * Driver-owned durable agent inbox projection and command facade.
 *
 * @module @deepseek-ai/dsh-agent-loop/inbox
 */

import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Session, SessionEventMap, UserMessage } from '@deepseek-ai/dsh-session'
import type {
  AgentEventDispatch,
  HostAdmission,
  HostAdmissionTicket,
  Inbox as InboxContract,
  InboxState,
  InboxTarget,
  InboxWireState,
  NotificationAdmission,
  NotificationState,
} from '@deepseek-ai/dsh-agent'
import { z } from 'zod'

/** Wire validation for pending agent input reconstructed from durable inbox splices. */
export const inboxProjectionSchema = z.object({
  'next-turn': z.array(z.custom<UserMessage>()).readonly(),
  'next-step': z.array(z.custom<UserMessage>()).readonly(),
}).readonly()

/** Standard fold that reconstructs pending input and rejects invalid durable splice history. */
export const inboxProjectionDefinition = {
  key: 'inbox',
  stateSchema: inboxProjectionSchema,
  init: (): InboxState => ({ 'next-turn': [], 'next-step': [] }),
  apply(state: InboxState, event) {
    if (event.type !== 'agent/inbox/spliced') return state
    const splice = event.data
    try {
      const inbox = state[splice.target]
      const removedCount = splice.removedCount ?? 0
      if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > inbox.length
        || !Number.isSafeInteger(removedCount) || removedCount < 0
        || splice.start + removedCount > inbox.length) {
        throw new Error('invalid inbox splice')
      }
      const next = inbox.toSpliced(splice.start, removedCount, ...splice.inserted)
      const ids = new Set<string>()
      for (const message of splice.target === 'next-turn'
        ? [...next, ...state['next-step']]
        : [...state['next-turn'], ...next]) {
        if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
        ids.add(message.id)
      }
      return splice.target === 'next-turn'
        ? { 'next-turn': next, 'next-step': state['next-step'] }
        : { 'next-turn': state['next-turn'], 'next-step': next }
    } catch (error: unknown) {
      throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`, { cause: error })
    }
  },
  wire: {
    // The wire value is the fold state itself: every pending message already
    // round-trips the session log as lossless JSON. Only the static type
    // narrows to the JSON-safe projection table entry.
    viewSchema: inboxProjectionSchema as unknown as z.ZodType<InboxWireState>,
    view: (state: InboxState) => state as unknown as InboxWireState,
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'inbox', InboxState>

/**
 * Driver-owned durable Inbox implementation used by ReactLoopAgent and focused
 * provider tests.
 * @param projections - registry with the standard Inbox projection registered by AgentLoop.
 * @param session - session whose durable events store pending input.
 * @param dispatch - agent-scoped notifications for Inbox lifecycle events.
 */
export class ReactLoopInbox implements InboxContract {
  constructor(
    private readonly projections: SessionProjectionRegistry,
    private readonly session: Session,
    private readonly dispatch: AgentEventDispatch,
    private readonly admission: () => HostAdmission | undefined = () => undefined,
  ) {}

  private acceptingAdmissions = true
  get accepting(): boolean { return this.acceptingAdmissions }
  /** Disposal closes admission synchronously; human Stop does not dispose. */
  stopAccepting(): void { this.acceptingAdmissions = false }

  /** Native driver capability; alternate drivers need not pretend to implement it. */
  readonly notifications = this

  private notificationState(): NotificationState {
    const state = this.projections.stateOf(this.session, 'notifications')
    if (state === undefined) throw new Error('notification projection unavailable')
    return state
  }

  get focus(): { enabled: boolean; queued: number } {
    return { enabled: this.notificationState().enabled, queued: [...this.nextStep, ...this.nextTurn].filter(m => this.isHeld(m)).length }
  }

  get hasForeground(): boolean {
    return [...this.nextStep, ...this.nextTurn].some(m => this.admissionFor(m.id) === undefined)
  }

  get hasNextStep(): boolean { return this.nextStep.some(m => !this.isHeld(m)) }

  private admissionFor(id: string) {
    return this.notificationState().receipts.find(r => r.message.id === id)
  }

  isHeld(message: UserMessage): boolean {
    const state = this.notificationState()
    return state.enabled && this.admissionFor(message.id) !== undefined
      && !state.released.includes(message.id)
  }

  receipt(origin: string, sequence: string): UserMessage | undefined {
    return this.notificationState().receipts.find(r => r.admission.origin === origin && r.admission.sequence === sequence)?.message
  }

  isPendingReceipt(origin: string, sequence: string): boolean {
    const message = this.receipt(origin, sequence)
    return message !== undefined && this.locate(message.id) !== undefined && !this.isHeld(message)
  }

  admit(target: InboxTarget, message: UserMessage, admission: NotificationAdmission): boolean {
    if (!this.accepting) throw new Error('native inbox admission disposed')
    if (this.receipt(admission.origin, admission.sequence) !== undefined) return false
    this.admission()?.assert()
    this.mutate(target, Infinity, 0, [message], true, admission)
    return true
  }

  admitMaintenance(permit: HostAdmissionTicket, target: InboxTarget, message: UserMessage, admission: NotificationAdmission): boolean {
    if (!this.accepting) throw new Error('native inbox admission disposed')
    const owner = this.admission()
    if (owner?.forSession === undefined) throw new Error('native maintenance receipt capability unsupported')
    owner.forSession(permit, this.session.id).assert()
    owner.assertReceipt?.(permit, message)
    if (this.receipt(admission.origin, admission.sequence) !== undefined) return false
    this.mutate(target, Infinity, 0, [message], true, admission)
    return true
  }

  /** Restore admissions canceled before model-visible entry; committed messages never replay. */
  recoverUnentered(): void {
    const state = this.notificationState()
    for (const { target, message } of state.receipts) {
      if (!state.entered.includes(message.id) && !state.terminal.some(item => item.messageId === message.id) && this.locate(message.id) === undefined) this.mutate(target, Infinity, 0, [message], false)
    }
  }

  setFocus(enabled: boolean): void { this.session.append('agent/focus', { enabled }) }

  check(id: string): readonly string[] {
    const previous = this.notificationState().checks.find(c => c.id === id)
    if (previous !== undefined && !previous.messageIds.some(id => [...this.nextStep, ...this.nextTurn].some(m => m.id === id && this.isHeld(m)))) return previous.messageIds
    const messageIds = previous === undefined ? [...this.nextStep, ...this.nextTurn].filter(m => this.isHeld(m) && this.admissionFor(m.id) !== undefined).slice(0, 10).map(m => m.id) : [...previous.messageIds]
    this.session.append('agent/focus', { enabled: this.focus.enabled, check: { id, messageIds } })
    return messageIds
  }

  /** Prompts awaiting individual turns. */
  get nextTurn(): readonly UserMessage[] {
    return this.current()['next-turn']
  }

  /** Input awaiting the next step boundary. */
  get nextStep(): readonly UserMessage[] {
    return this.current()['next-step']
  }

  /** Whether either pending-message list contains work. */
  get hasPending(): boolean {
    const state = this.current()
    return [...state['next-turn'], ...state['next-step']].some(m => !this.isHeld(m))
  }

  /** Terminal execution disposition keeps original receipts as evidence. */
  settle(messages: readonly UserMessage[], reason: 'rejected' | 'discarded' | 'disposed'): void {
    const messageIds = messages.filter(m => this.admissionFor(m.id) !== undefined).map(m => m.id)
    if (messageIds.length > 0) this.session.append('agent/notification/terminal', { messageIds, reason })
  }

  /** Human Stop preserves admitted background input; teardown explicitly disposes it. */
  clear(disposeNotifications = false): void {
    for (const target of ['next-step', 'next-turn'] as const) {
      for (const [index, message] of [...this.current()[target].entries()].reverse()) {
        if (this.admissionFor(message.id) === undefined || disposeNotifications) {
          if (disposeNotifications) this.settle([message], 'disposed')
          this.splice(target, index, 1, [])
        }
      }
    }
  }

  /**
   * Remove and return the complete batch proposed for one step.
   * @param target - whether this boundary also consumes one queued turn.
   * @param turn - turn that will own the claimed batch.
   * @returns next-step input followed by the queued turn, when requested.
   */
  claim(target: InboxTarget, turn: number): UserMessage[] {
    const claimed: UserMessage[] = []
    const foreground = this.hasForeground
    const eligible = (m: UserMessage) => !this.isHeld(m) && !(this.focus.enabled && foreground && this.admissionFor(m.id) !== undefined)
    for (const [index, message] of [...this.nextStep.entries()].reverse()) {
      if (eligible(message)) claimed.unshift(...this.mutate('next-step', index, 1, [], false))
    }
    if (target === 'next-turn') {
      let index = this.nextTurn.findIndex(m => eligible(m) && this.admissionFor(m.id) === undefined)
      if (index < 0) index = this.nextTurn.findIndex(eligible)
      if (index >= 0) claimed.push(...this.mutate('next-turn', index, 1, [], false))
    }
    for (const message of claimed) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return claimed
  }

  /**
   * Append one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to append.
   */
  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.current()[target].length, 0, [message])
  }

  /**
   * Prepend one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to prepend.
   */
  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message])
  }

  /**
   * Replace one pending message in place.
   * @param messageId - identity of the pending message to replace.
   * @param newMessage - replacement message.
   * @returns whether the message was still pending.
   */
  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    const location = this.locate(messageId)
    if (location === undefined || this.admissionFor(messageId) !== undefined) return false
    this.splice(location.target, location.index, 1, [newMessage])
    return true
  }

  /**
   * Remove one pending message.
   * @param messageId - identity of the pending message to remove.
   * @returns whether the message was still pending.
   */
  remove(messageId: MessageId): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [])
    return true
  }

  /**
   * Apply standard splice semantics and durably record the normalized result.
   * @param target - pending list to mutate.
   * @param start - splice position.
   * @param deleteCount - maximum number of messages to remove.
   * @param inserted - messages to insert at the resolved position.
   * @returns messages removed by the splice.
   */
  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[] {
    if (inserted.length > 0) this.admission()?.assert()
    return this.mutate(target, start, deleteCount, inserted, true)
  }

  /** Locate one pending identity across both owned lists. */
  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    const state = this.current()
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = state[target].findIndex(message => message.id === messageId)
      if (index >= 0) return { target, index }
    }
    return undefined
  }

  /** Read the current durable projection state. */
  private current(): InboxState {
    const state = this.projections.stateOf(this.session, 'inbox')
    if (state === undefined) {
      throw new Error(
        `agent "${this.session.id}" cannot read inbox state: its projection registration is not active`,
      )
    }
    return state
  }

  /** Commit one normalized mutation and publish its live events. */
  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
    notification?: NotificationAdmission,
  ): UserMessage[] {
    const state = this.current()
    const inbox = state[target]
    const truncatedStart = Math.trunc(start)
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart
    const actualStart = offset < 0
      ? Math.max(inbox.length + offset, 0)
      : Math.min(offset, inbox.length)
    const truncatedDeleteCount = Math.trunc(deleteCount)
    const actualDeleteCount = Math.min(
      Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0),
      inbox.length - actualStart,
    )
    if (actualDeleteCount === 0 && inserted.length === 0) return []
    const candidate = inbox.toSpliced(actualStart, actualDeleteCount, ...inserted)
    const ids = new Set<string>()
    for (const message of target === 'next-turn'
      ? [...candidate, ...state['next-step']]
      : [...state['next-turn'], ...candidate]) {
      if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
      ids.add(message.id)
    }
    const outcome = discardRemoved && actualDeleteCount > 0 ? 'canceled' as const : undefined
    const splice: SessionEventMap['agent/inbox/spliced'] = {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(notification === undefined ? {} : { notification }),
      ...(outcome === undefined ? {} : { outcome }),
    }
    const removed = inbox.slice(actualStart, actualStart + actualDeleteCount)
    if (discardRemoved) this.settle(removed, 'discarded')
    const event = this.session.append('agent/inbox/spliced', splice)
    if (discardRemoved) {
      for (const message of removed) this.dispatch.emit('agent/inbox/discarded', { message })
    }
    for (const message of event.data.inserted) {
      this.dispatch.emit('agent/inbox/inserted', { message })
    }
    return removed
  }
}
