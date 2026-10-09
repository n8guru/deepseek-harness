/**
 * Driver-owned durable agent inbox projection and command facade.
 *
 * @module @deepseek-ai/dsh-agent-loop/inbox
 */

import { LlmError, type MessageId } from '@deepseek-ai/dsh-llm'
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
  NotificationActivityGuard,
  GatedNotificationItem,
  NotificationState,
} from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { gatedNotificationBatchSchema } from './notifications.ts'

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
    private readonly activity: () => string | undefined = () => undefined,
  ) {
    // Until Stop has durable custody, restored/forked history cannot establish a clear latch.
    this.stop = session.seq === 0 && !session.header.isSeeded ? 'clear' : 'unknown'
  }

  private acceptingAdmissions = true
  get accepting(): boolean { return this.acceptingAdmissions }
  /** Disposal closes admission synchronously; human Stop does not dispose. */
  stopAccepting(): void { this.acceptingAdmissions = false }

  /** Native driver capability; alternate drivers need not pretend to implement it. */
  readonly notifications = this

  private notificationState(): NotificationState {
    const state = this.projections.stateOf(this.session, 'notifications')
    if (state === undefined) throw new Error('notification projection unavailable')
    for (const receipt of state.receipts) {
      if ((receipt.admission.activityGated === true) !== (receipt.activityGate !== undefined)
        || (receipt.activityGate !== undefined && receipt.activityGate.sessionId !== this.session.id && !this.session.header.isSeeded)) throw new Error('invalid gated notification state')
    }
    for (const message of [...this.nextStep, ...this.nextTurn]) {
      // Connection declares this extension; durable readers need not load its compiler face.
      const sourceKind: string = message.source.kind
      if (sourceKind === 'notification' && !state.receipts.some(r => r.message.id === message.id)) {
        throw new Error('pending notification lacks its receipt')
      }
    }
    return state
  }

  private stop: 'clear' | 'stopped' | 'unknown' = 'clear'

  private controlRevision = 0

  get controls(): { stop: 'clear' | 'stopped' | 'unknown'; focus: boolean; revision: number } {
    return { stop: this.stop, focus: this.notificationState().enabled, revision: this.controlRevision }
  }

  /**
   * Commit a control revision before observers run; only the driver's own phase can preserve its selection.
   * @param ownPhase - whether this is the selected driver's synchronous phase transition.
   */
  advanceControlRevision(ownPhase = false): void {
    const selected = ownPhase && this.activitySelectionRevision !== undefined
      && this.activitySelectionRevision === this.activity()
    this.controlRevision++
    if (selected) this.activitySelectionRevision = this.activity()
  }

  /** A resumed empty log also cannot establish pre-restart Stop state. */
  restoreStop(): void { if (this.stop === 'clear') this.setStop('unknown') }

  /** Commit native cancellation intent even while idle and without a goal. */
  latchStop(): void { this.setStop('stopped') }

  resumeOperator(): void {
    if (!this.accepting) throw new Error('native inbox admission disposed')
    this.setStop('clear')
  }

  private setStop(stop: 'clear' | 'stopped' | 'unknown'): void {
    if (stop === this.stop) return
    this.stop = stop
    this.advanceControlRevision()
    this.dispatch.emit('agent/stop-changed', {})
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
    const receipt = this.admissionFor(message.id)
    if (receipt?.activityGate !== undefined) return receipt.activityGate.sessionId !== this.session.id
      || !this.activitySelection.has(message.id) || this.hasForeground || this.activitySelectionRevision === undefined
      || this.activity() !== this.activitySelectionRevision
    return state.enabled && receipt !== undefined && !state.released.includes(message.id)
  }

  receipt(origin: string, sequence: string): UserMessage | undefined {
    return this.notificationState().receipts.find(r => r.admission.origin === origin && r.admission.sequence === sequence)?.message
  }

  isActivityGatedReceipt(origin: string, sequence: string): boolean {
    return this.notificationState().receipts.some(r =>
      r.admission.origin === origin && r.admission.sequence === sequence && r.activityGate !== undefined)
  }

  isPendingReceipt(origin: string, sequence: string): boolean {
    const message = this.receipt(origin, sequence)
    return message !== undefined && this.locate(message.id) !== undefined && !this.isHeld(message)
  }

  admit(target: InboxTarget, message: UserMessage, admission: NotificationAdmission): boolean {
    if (!this.accepting) throw new Error('native inbox admission disposed')
    if (admission.activityGated !== undefined || this.isActivityGatedReceipt(admission.origin, admission.sequence)) {
      throw new Error('gated notifications require ordered custody staging')
    }
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
    if (admission.activityGated !== undefined || this.isActivityGatedReceipt(admission.origin, admission.sequence)) {
      throw new Error('gated notifications require ordered custody staging')
    }
    if (this.receipt(admission.origin, admission.sequence) !== undefined) return false
    this.mutate(target, Infinity, 0, [message], true, admission)
    return true
  }

  stageActivityGated(
    target: InboxTarget, items: GatedNotificationItem[], guard: NotificationActivityGuard,
  ): readonly { sequence: string; messageId: MessageId; duplicate: boolean }[] {
    if (!this.accepting) throw new Error('native inbox admission disposed')
    const batch = { version: 1 as const, sessionId: this.session.id, target, guard, items }
    gatedNotificationBatchSchema.parse(batch)
    const state = this.notificationState()
    const sequences = new Set<string>()
    const ids = new Set<string>()
    const fresh: GatedNotificationItem[] = []
    const receipts = items.map((item) => {
      const { message, admission } = item
      const key = JSON.stringify([admission.origin, admission.sequence])
      if (sequences.has(key) || ids.has(message.id)) throw new Error('duplicate gated batch identity')
      sequences.add(key)
      ids.add(message.id)
      const prior = state.receipts.find(r => r.admission.origin === admission.origin && r.admission.sequence === admission.sequence)
      if (prior !== undefined) {
        if (prior.activityGate?.sessionId !== this.session.id || prior.target !== target
          || JSON.stringify(prior.admission) !== JSON.stringify(admission)
          || JSON.stringify(prior.message.content) !== JSON.stringify(message.content)
          || JSON.stringify(prior.message.source) !== JSON.stringify(message.source)) throw new Error('gated receipt conflict')
        return { sequence: admission.sequence, messageId: prior.message.id, duplicate: true }
      }
      if (state.receipts.some(r => r.message.id === message.id) || this.locate(message.id) !== undefined) throw new Error('gated message identity conflict')
      fresh.push(item)
      return { sequence: admission.sequence, messageId: message.id, duplicate: false }
    })
    if (fresh.length === 0) return receipts
    this.admission()?.assert()
    // One required event owns the complete ordered selection even if insertion is interrupted.
    const event = this.session.append('agent/notification/activity-gated', { ...batch, items: fresh })
    for (const { message, admission } of event.data.items) this.mutate(target, Infinity, 0, [message], true, admission)
    return receipts
  }

  /** Restore admissions canceled before model-visible entry; committed messages never replay. */
  recoverUnentered(): void {
    const state = this.notificationState()
    const order = new Map(state.receipts.map((receipt, index) => [receipt.message.id, index]))
    for (const [index, { target, message, admission, activityGate }] of state.receipts.entries()) {
      if (activityGate !== undefined && activityGate.sessionId !== this.session.id) continue
      if (!state.entered.includes(message.id)
        && !state.terminal.some(item => item.messageId === message.id)
        && this.locate(message.id) === undefined) {
        // A post-claim arrival must not overtake retained gated input on recovery.
        const later = activityGate === undefined ? -1
          : this.current()[target].findIndex(pending => (order.get(pending.id) ?? -1) > index)
        this.mutate(target, later < 0 ? Infinity : later, 0, [message], false, activityGate === undefined ? undefined : admission)
      }
    }
  }

  setFocus(enabled: boolean): void {
    this.advanceControlRevision()
    this.session.append('agent/focus', { enabled })
  }

  private activitySelection = new Set<string>()
  private activitySelectionRevision: string | undefined
  /** Whether selected custody still awaits native acceptance (not a tool continuation). */
  get hasUnenteredActivitySelection(): boolean {
    const entered = this.notificationState().entered
    return [...this.activitySelection].some(id => !entered.includes(id))
  }

  /**
   * Capture a fixed ordered selection; late arrivals wait for another release.
   * @returns up to ten pending gated message identities, or none while held.
   */
  selectActivityGated(): readonly string[] {
    if (!this.accepting || this.hasForeground || this.activity() === undefined) return []
    return [...this.nextStep, ...this.nextTurn].filter(m =>
      this.admissionFor(m.id)?.activityGate?.sessionId === this.session.id).slice(0, 10).map(m => m.id)
  }

  /**
   * Process-local selection is never restored from recorded activity tuples.
   * @param ids - fixed bounded selection captured before the successful flush.
   */
  armActivitySelection(ids: readonly string[]): void {
    this.activitySelection = new Set(ids)
    this.activitySelectionRevision = this.activity()
  }

  /** Retire the selection when its driver ends, including canceled or failed preparation. */
  clearActivitySelection(): void {
    this.activitySelection.clear()
    this.activitySelectionRevision = undefined
  }

  /**
   * Preserve selected custody across middleware; rejection defers rather than retires it.
   * @param claimed - native ordered input, not the waterfall's mutable array.
   * @param proposed - waterfall input, or empty for a rejected step.
   */
  assertActivityDecision(claimed: readonly UserMessage[], proposed: readonly UserMessage[]): void {
    const gated = (message: UserMessage) => this.admissionFor(message.id)?.activityGate !== undefined
    const expected = claimed.filter(gated)
    const actual = proposed.filter(gated)
    if (expected.length !== actual.length || expected.some((message, index) => message !== actual[index])) {
      throw new LlmError('activity-gated selection changed by preparation', 'ACTIVITY_HELD')
    }
    this.assertActivityEntry(actual)
  }

  /**
   * Recheck selected input even after claim removes it from pending lists.
   * @param messages - proposed or natively accepted input for this request.
   */
  assertActivityEntry(messages: readonly UserMessage[]): void {
    if (messages.some(m => this.admissionFor(m.id)?.activityGate !== undefined && this.isHeld(m))) {
      throw new LlmError('activity-gated model entry held', 'ACTIVITY_HELD')
    }
  }

  /**
   * Live controls remain mandatory after input is accepted into model history.
   * @param messages - request input whose gated receipts remain selected.
   * @returns current revision, or undefined for entirely ungated input; throws while held.
   */
  activityEntryRevision(messages: readonly UserMessage[]): string | undefined {
    if (!messages.some(m => this.admissionFor(m.id)?.activityGate !== undefined)) return undefined
    this.assertActivityEntry(messages)
    return this.activity()
  }

  /**
   * Await fences include Session.seq; native synchronous log writes are not external controls.
   * @param messages - input awaiting asynchronous preparation.
   * @returns revision and sequence checkpoint, or undefined for ungated input.
   */
  activityCheckpoint(messages: readonly UserMessage[]): string | undefined {
    const revision = this.activityEntryRevision(messages)
    return revision === undefined ? undefined : JSON.stringify([this.session.seq, revision])
  }

  /**
   * Refuse intervening control changes even when they returned to the same value.
   * @param messages - input whose preparation has just settled.
   * @param checkpoint - state captured immediately before the await.
   */
  assertActivityCheckpoint(messages: readonly UserMessage[], checkpoint: string | undefined): void {
    if (checkpoint !== this.activityCheckpoint(messages)) throw new LlmError('activity changed during preparation', 'ACTIVITY_HELD')
  }

  check(id: string): readonly string[] {
    const previous = this.notificationState().checks.find(c => c.id === id)
    if (previous !== undefined && !previous.messageIds.some(id => [...this.nextStep, ...this.nextTurn]
      .some(m => m.id === id && this.isHeld(m)))) return previous.messageIds
    const messageIds = previous === undefined
      ? [...this.nextStep, ...this.nextTurn]
        .filter(m => this.isHeld(m) && this.admissionFor(m.id)?.activityGate === undefined).slice(0, 10).map(m => m.id)
      : [...previous.messageIds]
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
    if (foreground) this.clearActivitySelection()
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
    if (notification === undefined && inserted.some(message => this.admissionFor(message.id) === undefined)) {
      // Foreground insertion irreversibly retires a background selection, even if
      // a later claim/removal makes hasForeground false again in this same driver.
      this.activitySelectionRevision = undefined
      this.advanceControlRevision()
    }
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
