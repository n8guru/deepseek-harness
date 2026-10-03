/**
 * Incremental projection of durable agent inbox events.
 *
 * @module @deepseek-ai/dsh-agent/inbox
 */

import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEventMap, UserMessage } from '@deepseek-ai/dsh-session'
import type { InboxTarget, NotificationAdmission } from './types.ts'

/** Mutable state privately owned by an {@link Inbox}. */
type InboxState = Record<InboxTarget, UserMessage[]>

/** Live notifications committed by inbox mutations. */
export interface InboxNotifications {
  /** Publish one inserted message. */
  inserted(message: UserMessage): void
  /** Publish one discarded message. */
  discarded(message: UserMessage): void
  /** Publish one claimed message inside its owning turn. */
  claimed(message: UserMessage, turn: number): void
}

/** A replay-once projection that incrementally consumes later inbox splices. */
export class Inbox {
  private readonly state: InboxState = { 'next-turn': [], 'next-step': [] }
  private focused = false
  private readonly released = new Set<string>()
  private readonly checks = new Map<string, string[]>()
  private readonly admissions = new Map<string, { message: UserMessage; target: InboxTarget; admission: NotificationAdmission }>()

  /** Durable operator Focus setting and held notification count. */
  get focus(): { enabled: boolean; queued: number } {
    return { enabled: this.focused, queued: [...this.nextTurn, ...this.nextStep].filter(m => this.isHeld(m)).length }
  }

  /** Unknown, human and coordinator input is always foreground. */
  get hasForeground(): boolean { return [...this.nextTurn, ...this.nextStep].some(m => this.admissionFor(m.id) === undefined) }

  /** Whether an admitted step-boundary input is runnable. */
  get hasNextStep(): boolean { return this.nextStep.some(m => !this.isHeld(m)) }

  /** Only notifications with explicit trusted admission can be held.
   * @param message - pending input to classify.
   * @returns whether Focus excludes it from claim and wake.
   */
  isHeld(message: UserMessage): boolean {
    const receipt = this.admissionFor(message.id)
    return this.focused && receipt !== undefined && receipt.admission.urgency === undefined && !this.released.has(message.id)
  }

  /** Inspect a stable receipt by authenticated origin and sequence.
   * @param origin - trusted producer namespace.
   * @param sequence - stable producer message/checkpoint identity.
   * @returns the original accepted message, including consumed receipts.
   */
  receipt(origin: string, sequence: string): UserMessage | undefined {
    return this.admissions.get(JSON.stringify([origin, sequence]))?.message
  }

  /** Whether a stable receipt still names runnable pending input.
   * @param origin - trusted producer namespace.
   * @param sequence - stable producer message/checkpoint identity.
   * @returns whether an ambiguous-ACK retry may wake this pending message.
   */
  isPendingReceipt(origin: string, sequence: string): boolean {
    const message = this.receipt(origin, sequence)
    return message !== undefined && this.locate(message.id) !== undefined && !this.isHeld(message)
  }

  /** Commit trusted provenance and insertion in one log event.
   * @param target - pending list to receive this message.
   * @param message - identified retained notification content.
   * @param admission - trusted producer and stable sequence.
   * @returns false for an existing receipt; retries retain its original content.
   */
  admit(target: InboxTarget, message: UserMessage, admission: NotificationAdmission): boolean {
    if (this.receipt(admission.origin, admission.sequence) !== undefined) return false
    this.mutate(target, Infinity, 0, [message], true, admission)
    return true
  }

  /** Set Focus without granting a background turn or releasing a snapshot.
   * @param enabled - whether routine admitted notifications remain held.
   */
  setFocus(enabled: boolean): void {
    const event = this.session.append('agent/focus', { enabled })
    this.applyFocus(event.data)
  }

  /** Release at most ten held messages once per caller-generated Check identity.
   * @param id - exact retry identity for this bounded snapshot.
   * @returns the original released ids; late arrivals stay held on retry.
   */
  check(id: string): readonly string[] {
    const prior = this.checks.get(id)
    if (prior !== undefined) return prior
    const messageIds = [...this.nextStep, ...this.nextTurn].filter(m => this.isHeld(m)).slice(0, 10).map(m => m.id)
    const event = this.session.append('agent/focus', { enabled: this.focused, check: { id, messageIds } })
    this.applyFocus(event.data)
    return messageIds
  }

  /** Preserve notification evidence if cancellation interrupted a claim before model-visible logging. */
  recoverUnentered(): void {
    const entered = new Set(this.session.events.slice(this.session.header.seedLength ?? 0).flatMap(e => e.type === 'user/message' ? [e.data.id] : []))
    for (const { message, target } of this.admissions.values()) {
      if (!entered.has(message.id) && this.locate(message.id) === undefined) this.append(target, message)
    }
  }

  private admissionFor(id: string) {
    return [...this.admissions.values()].find(a => a.message.id === id)
  }

  private applyFocus(data: SessionEventMap['agent/focus']): void {
    if (typeof data.enabled !== 'boolean' || (data.check !== undefined && (typeof data.check.id !== 'string' || !Array.isArray(data.check.messageIds) || data.check.messageIds.some(id => typeof id !== 'string')))) throw new Error('invalid persisted Focus control')
    this.focused = data.enabled
    if (data.check !== undefined) {
      this.checks.set(data.check.id, [...data.check.messageIds])
      for (const id of data.check.messageIds) this.released.add(id)
    }
  }

  constructor(
    private readonly session: Session,
    private readonly notifications: InboxNotifications,
  ) {
    for (const event of session.events.slice(session.header.seedLength ?? 0)) {
      if (event.type === 'agent/focus') { this.applyFocus(event.data); continue }
      if (event.type !== 'agent/inbox/spliced') continue
      try {
        this.apply(event.data)
      } catch (error: unknown) {
        throw new Error(`invalid persisted inbox splice at session seq ${event.seq}`, { cause: error })
      }
    }
    this.recoverUnentered()
  }

  /** Prompts awaiting individual turns. */
  get nextTurn(): readonly UserMessage[] {
    return this.state['next-turn']
  }

  /** Input awaiting the next step boundary. */
  get nextStep(): readonly UserMessage[] {
    return this.state['next-step']
  }

  /** Whether either pending-message list contains work. */
  get hasPending(): boolean {
    return this.nextTurn.some(m => !this.isHeld(m)) || this.hasNextStep
  }

  /** Durably cancel ordinary pending input, preserving all admitted evidence. */
  clear(): void {
    for (const target of ['next-step', 'next-turn'] as const) {
      const inbox = this.state[target]
      if (!inbox.some(m => this.admissionFor(m.id) !== undefined)) { this.splice(target, 0, inbox.length, []); continue }
      for (const [i, message] of [...inbox.entries()].reverse()) {
        if (this.admissionFor(message.id) === undefined) this.splice(target, i, 1, [])
      }
    }
  }

  /**
   * Remove and return the complete batch proposed for one step, publishing
   * each claimed message. The durable splices are pure deletions.
   * @param target - whether this boundary also consumes one queued turn.
   * @param turn - turn that will own the claimed batch.
   * @returns next-step input followed by the queued turn, when requested.
   * @internal - The agent loop's step-boundary operation, not a plugin extension point.
   */
  claim(target: InboxTarget, turn: number): UserMessage[] {
    const claimed: UserMessage[] = []
    const foreground = target === 'next-turn' && this.nextTurn.some(m => this.admissionFor(m.id) === undefined)
    const eligible = (message: UserMessage) => !this.isHeld(message)
      && !(this.focused && foreground
        && this.admissionFor(message.id)?.admission.urgency === undefined && this.admissionFor(message.id) !== undefined)
    if (this.nextStep.every(eligible)) claimed.push(...this.mutate('next-step', 0, this.nextStep.length, [], false))
    else for (const [i, message] of [...this.nextStep.entries()].reverse()) {
      if (eligible(message)) claimed.unshift(...this.mutate('next-step', i, 1, [], false))
    }
    if (target === 'next-turn') {
      const queue = this.state['next-turn']
      // Foreground human/coordinator input wins even against an explicitly released background snapshot.
      let index = queue.findIndex(m => this.admissionFor(m.id) === undefined)
      if (index < 0) index = queue.findIndex(m => !this.isHeld(m))
      if (index >= 0) claimed.push(...this.mutate('next-turn', index, 1, [], false))
      if (this.focused && !foreground) {
        for (const [i, message] of [...queue.entries()].reverse()) if (eligible(message)) claimed.push(...this.mutate('next-turn', i, 1, [], false))
      }
    }
    for (const message of claimed) this.notifications.claimed(message, turn)
    return claimed
  }

  /**
   * Append one message to a pending list and durably record the insertion.
   * @param target - pending list to extend.
   * @param message - message to append.
   * @throws if the message identity is already pending.
   */
  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.state[target].length, 0, [message])
  }

  /**
   * Prepend one message to a pending list and durably record the insertion.
   * @param target - pending list to extend.
   * @param message - message to prepend.
   * @throws if the message identity is already pending.
   */
  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message])
  }

  /**
   * Replace one pending message in place, possibly changing its identity. A
   * successful replacement publishes the old message as discarded and the new
   * message as inserted.
   * @param messageId - identity of the pending message to replace.
   * @param newMessage - replacement message.
   * @returns whether the message was still pending.
   * @throws if the replacement duplicates another pending message identity.
   */
  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    const location = this.locate(messageId)
    if (location === undefined || this.admissionFor(messageId) !== undefined) return false
    this.splice(location.target, location.index, 1, [newMessage])
    return true
  }

  /**
   * Remove one pending message and durably record its cancellation.
   * @param messageId - identity of the pending message to remove.
   * @returns whether the message was still pending.
   */
  remove(messageId: MessageId): boolean {
    const location = this.locate(messageId)
    if (location === undefined || this.admissionFor(messageId) !== undefined) return false
    this.splice(location.target, location.index, 1, [])
    return true
  }

  /**
   * Apply standard splice semantics and durably record the normalized result.
   * The durable event commits before the live projection mutates, so synchronous
   * `session/event` observers see the pre-splice lists and can reconstruct the
   * removed messages from the normalized coordinates.
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
    return this.mutate(target, start, deleteCount, inserted, true)
  }

  /** Locate one pending identity across both owned lists. */
  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = this.state[target].findIndex(message => message.id === messageId)
      if (index >= 0) return { target, index }
    }
    return undefined
  }

  /** Commit one normalized mutation and publish its live notifications. */
  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
    notification?: NotificationAdmission,
  ): UserMessage[] {
    const inbox = this.state[target]
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
    if (discardRemoved && inbox.slice(actualStart, actualStart + actualDeleteCount).some(m => this.admissionFor(m.id) !== undefined)) throw new Error('notification evidence cannot be edited or discarded')
    if (actualDeleteCount === 0 && inserted.length === 0) return []
    const outcome = discardRemoved && actualDeleteCount > 0 ? 'canceled' as const : undefined
    const splice = {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(notification === undefined ? {} : { notification }),
      ...(outcome === undefined ? {} : { outcome }),
    }
    this.validate(splice)
    const event = this.session.append('agent/inbox/spliced', splice)
    const removed = this.apply(event.data)
    if (discardRemoved) {
      for (const message of removed) this.notifications.discarded(message)
    }
    for (const message of event.data.inserted) this.notifications.inserted(message)
    return removed
  }

  /** Apply one normalized durable splice to the projection. */
  private apply(splice: SessionEventMap['agent/inbox/spliced']): UserMessage[] {
    this.validate(splice)
    const inbox = this.state[splice.target]
    if (splice.notification !== undefined) {
      const n = splice.notification
      if (typeof n.origin !== 'string' || !n.origin || typeof n.sequence !== 'string' || !n.sequence || splice.inserted.length !== 1) throw new Error('invalid persisted notification admission')
      if (n.urgency !== undefined && (!['safety', 'security', 'deadline'].includes(n.urgency.kind) || typeof n.urgency.reason !== 'string' || !n.urgency.reason)) throw new Error('invalid persisted notification urgency')
      if (this.receipt(n.origin, n.sequence) !== undefined) throw new Error('duplicate persisted notification identity')
      const message = splice.inserted[0]
      if (message === undefined) throw new Error('notification admission requires its message')
      this.admissions.set(JSON.stringify([n.origin, n.sequence]), { message, target: splice.target, admission: n })
    }
    return inbox.splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
  }

  /** Validate one normalized splice against the current projection. */
  private validate(splice: SessionEventMap['agent/inbox/spliced']): void {
    const inbox = this.state[splice.target]
    const removedCount = splice.removedCount ?? 0
    if (!Number.isSafeInteger(splice.start) || splice.start < 0 || splice.start > inbox.length
      || !Number.isSafeInteger(removedCount) || removedCount < 0
      || splice.start + removedCount > inbox.length) {
      throw new Error('invalid inbox splice')
    }
    const candidate = inbox.toSpliced(splice.start, removedCount, ...splice.inserted)
    const ids = new Set<string>()
    for (const message of splice.target === 'next-turn'
      ? [...candidate, ...this.nextStep]
      : [...this.nextTurn, ...candidate]) {
      if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`)
      ids.add(message.id)
    }
  }
}
