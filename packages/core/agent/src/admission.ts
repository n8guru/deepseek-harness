/** Exact old-source cutoff. Process-local; not a fence on an already loaded old Host. */
import type {} from '@deepseek-ai/cordis'
import type { Agent } from './runtime-types.ts'
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'
export type HostWorkKind = 'publication' | 'job' | 'delegate' | 'workflow'
export interface HostInitialAdmission { readonly sessionId: SessionId; readonly messageId: UserMessage['id'] }
/**
 * Authenticated failed-publication receipt. `unpublished`: the canonical driver
 * took ownership of the exact request (`request`) but never claimed the grant,
 * which is now revoked so no later factory call can publish it. `joined`:
 * the claimed publication's actual cleanup (handle disposal, or prepared-agent
 * disposal plus raw setup settlement) completed. Only {@link HostCutoff.verify}
 * authenticates a receipt; a copied object confers nothing.
 */
export interface HostPublicationFailureReceipt { readonly sessionId: SessionId; readonly outcome: 'unpublished' | 'joined' }
export interface HostReservation {
  release(): void
  child?(id: SessionId, message: UserMessage, parent: Agent, signal: AbortSignal, request: object): HostInitialAdmission
}
type Initial = {
  reservation: object
  publication: object
  parent: Agent
  signal: AbortSignal
  message: UserMessage
  request: object
  claimed: boolean
  accepted: boolean
  revoked: boolean
  driven: boolean
  joined: PromiseWithResolvers<undefined>
  child?: Agent
}
export class HostCutoff {
  private accepting: boolean
  private readonly reservations = new Map<object, HostWorkKind>()
  private readonly coverage = new Map<HostWorkKind, Set<() => boolean>>()
  private readonly initials = new WeakMap<HostInitialAdmission, Initial>()
  private readonly receipts = new WeakSet<HostPublicationFailureReceipt>()
  constructor(closed = false, private readonly backend: () => { state: 'JOINED' | 'UNKNOWN' } | undefined = () => undefined,
    private readonly live: (id: SessionId) => Agent | undefined = () => undefined) { this.accepting = !closed }
  private holds = 0
  get open(): boolean { return this.accepting && this.holds === 0 }
  /**
   * Hold admission during durable replay. A failed replay keeps its hold;
   * releasing a hold never reopens an explicit close.
   * @returns an idempotent release for this hold.
   */
  hold(): () => void {
    this.holds += 1
    let released = false
    return () => { if (!released) { released = true; this.holds -= 1 } }
  }
  close(): void { this.accepting = false }
  assert(): void { if (!this.open) throw new Error('native Host admission CLOSED') }
  reserve(kind: HostWorkKind, parent?: Agent): HostReservation {
    this.assert()
    const identity = Object.freeze({})
    this.reservations.set(identity, kind)
    let initial: Initial | undefined
    return Object.freeze({
      release: () => { this.reservations.delete(identity); if (initial && !initial.claimed) this.reservations.delete(initial.publication) },
      child: (id: SessionId, message: UserMessage, exactParent: Agent, signal: AbortSignal, request: object) => {
        this.assert()
        if (kind !== 'delegate' || parent !== exactParent || this.live(parent.id) !== parent
          || !this.reservations.has(identity) || initial !== undefined) throw new Error('native initial lineage refused')
        signal.throwIfAborted()
        const capability = Object.freeze({ sessionId: id, messageId: message.id })
        const publication = Object.freeze({})
        this.reservations.set(publication, 'publication')
        initial = { reservation: identity, publication, parent, signal, request, message: structuredClone(message),
          claimed: false, accepted: false, revoked: false, driven: false, joined: Promise.withResolvers<undefined>() }
        this.initials.set(capability, initial)
        return capability
      },
    })
  }
  request(capability: HostInitialAdmission, request: object): void {
    const grant = this.initials.get(capability)
    if (!grant || grant.claimed || grant.revoked || grant.request !== request) throw new Error('native initial request refused')
    // The canonical driver now owns this exact request; an unclaimed failure
    // from here on is authoritative `unpublished` evidence.
    grant.driven = true
    grant.signal.throwIfAborted()
  }
  /** Exact pre-await request identity; never ambient permission for new work. */
  initial(capability: HostInitialAdmission, id: SessionId, parent: Agent | undefined, signal: AbortSignal | undefined) {
    const grant = this.initials.get(capability)
    if (!grant || grant.claimed || grant.revoked || capability.sessionId !== id || grant.parent !== parent
      || grant.signal !== signal || this.live(grant.parent.id) !== grant.parent
      || !this.reservations.has(grant.reservation)) throw new Error('native initial admission refused')
    grant.signal.throwIfAborted()
    grant.claimed = true
    return { message: structuredClone(grant.message),
      publish: (child: Agent) => { if (grant.child || child.id !== id) throw new Error('native initial publication refused'); grant.child = child },
      join: () => { this.reservations.delete(grant.publication); grant.joined.resolve(undefined) },
    }
  }
  /**
   * The exact reserved initial message for a caller-delivered claimed grant
   * (continuable materialization delivers through its own Activation accounting).
   */
  initialMessage(capability: HostInitialAdmission, child: Agent): UserMessage {
    const grant = this.initials.get(capability)
    if (!grant || !grant.claimed || grant.accepted || grant.child !== child) throw new Error('native initial message refused')
    return structuredClone(grant.message)
  }
  /**
   * Failed-start receipt. An unclaimed grant is revoked and its publication
   * retired immediately. A claimed grant yields a receipt only after its actual
   * publication cleanup calls `join`; a cleanup that never completes or fails
   * leaves the promise pending, so callers retain their reservation as UNKNOWN.
   * @param capability - the failed start's initial capability.
   * @returns the pending receipt, or undefined for an unknown capability.
   */
  failure(capability: HostInitialAdmission): Promise<HostPublicationFailureReceipt> | undefined {
    const grant = this.initials.get(capability)
    if (!grant || grant.accepted || grant.revoked) return undefined
    const issue = (outcome: HostPublicationFailureReceipt['outcome']) => {
      const receipt = Object.freeze({ sessionId: capability.sessionId, outcome })
      this.receipts.add(receipt)
      return receipt
    }
    if (!grant.claimed) {
      // Provider work that never entered the canonical driver is not attested.
      if (!grant.driven) return new Promise(() => {})
      grant.revoked = true
      this.reservations.delete(grant.publication)
      return Promise.resolve(issue('unpublished'))
    }
    return grant.joined.promise.then(() => issue('joined'))
  }
  /** @returns whether this exact receipt object was issued by this cutoff. */
  verify(receipt: HostPublicationFailureReceipt): boolean { return this.receipts.has(receipt) }
  /** Inbox consumes once, at the durable insertion boundary, including while OPEN. */
  accept(capability: HostInitialAdmission, child: Agent, message: UserMessage): void {
    const grant = this.initials.get(capability)
    if (!grant || !grant.claimed || grant.accepted || grant.child !== child || capability.sessionId !== child.id
      || this.live(child.id) !== child || this.live(grant.parent.id) !== grant.parent
      || !this.reservations.has(grant.reservation) || JSON.stringify(message) !== JSON.stringify(grant.message)) {
      throw new Error('native initial input refused')
    }
    grant.signal.throwIfAborted()
    grant.accepted = true
  }
  /** Constructor-only instrumentation, retained after provider deregistration. */
  cover(kind: HostWorkKind, joined: () => boolean): void {
    const owners = this.coverage.get(kind) ?? new Set()
    owners.add(joined)
    this.coverage.set(kind, owners)
  }
  status() {
    const pending = [...this.reservations.values()]
    const unknown = (['publication', 'job', 'delegate', 'workflow'] as const).filter((kind) => {
      const owners = this.coverage.get(kind)
      if (!owners?.size) return true
      try { return [...owners].some(joined => !joined()) } catch { return true }
    })
    let backend: 'JOINED' | 'UNKNOWN' = 'UNKNOWN'
    try { backend = this.backend()?.state ?? 'UNKNOWN' } catch { /* unavailable stays UNKNOWN */ }
    return { open: this.open, pending, unknown, backend, busy: pending.length > 0 || unknown.length > 0 || backend !== 'JOINED' }
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context { hostAdmission: HostCutoff }
}
