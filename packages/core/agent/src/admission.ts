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
/** Native Host admission cutoff: gates producer reservations and exact initial-message grants. */
export class HostCutoff {
  private accepting: boolean
  private readonly reservations = new Map<object, HostWorkKind>()
  private readonly coverage = new Map<HostWorkKind, Set<() => boolean>>()
  private readonly initials = new WeakMap<HostInitialAdmission, Initial>()
  private readonly receipts = new WeakSet<HostPublicationFailureReceipt>()
  constructor(closed = false, private readonly backend: () => { state: 'JOINED' | 'UNKNOWN' } | undefined = () => undefined,
    private readonly live: (id: SessionId) => Agent | undefined = () => undefined,
    private maintenanceReplayPending = false) { this.accepting = !closed }
  private holds = 0
  get open(): boolean { return this.accepting && this.holds === 0 && !this.maintenanceReplayPending }
  /**
   * Claim the boot barrier armed at registry construction, before any producer
   * can observe hostAdmission. Missing or duplicate receiver wiring fails closed.
   * @returns the one-shot release, called only after successful durable replay.
   */
  claimMaintenanceReplay(): () => void {
    if (!this.maintenanceReplayPending || this.maintenanceReplayClaimed) {
      this.close()
      throw new Error('maintenance receiver requires the registry maintenanceReplay boot barrier')
    }
    this.maintenanceReplayClaimed = true
    return () => { this.maintenanceReplayPending = false }
  }
  private maintenanceReplayClaimed = false
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
  /** Close admission for this Host lifetime; nothing reopens it in-process. */
  close(): void { this.accepting = false }
  /** Throw when admission is not open. */
  assert(): void { if (!this.open) throw new Error('native Host admission CLOSED') }
  /**
   * Reserve one unit of producer work while admission is open.
   * @param kind - the producer kind being reserved.
   * @param parent - the live parent Agent, required for delegate initial lineage.
   * @returns the reservation with its idempotent release.
   */
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
  /**
   * Bind the canonical driver to an exact initial grant request.
   * @param capability - the initial capability issued by `reserve().child`.
   * @param request - the exact provider request object bound at issue.
   */
  request(capability: HostInitialAdmission, request: object): void {
    const grant = this.initials.get(capability)
    if (!grant || grant.claimed || grant.revoked || grant.request !== request) throw new Error('native initial request refused')
    // The canonical driver now owns this exact request; an unclaimed failure
    // from here on is authoritative `unpublished` evidence.
    grant.driven = true
    grant.signal.throwIfAborted()
  }
  /**
   * Claim an exact initial grant by pre-await request identity; never ambient permission for new work.
   * @param capability - the initial capability issued by `reserve().child`.
   * @param id - the child session id the grant names.
   * @param parent - the live parent Agent bound at issue.
   * @param signal - the abort signal bound at issue.
   * @returns the reserved message plus one-shot publish and join callbacks.
   */
  initial(
    capability: HostInitialAdmission, id: SessionId, parent: Agent | undefined, signal: AbortSignal | undefined,
  ): { message: UserMessage; publish: (child: Agent) => void; join: () => void } {
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
   * @param capability - the claimed initial capability.
   * @param child - the Agent published for that grant.
   * @returns a copy of the reserved initial message.
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
  /**
   * Authenticate a failed-publication receipt by object identity.
   * @param receipt - the receipt to check.
   * @returns whether this exact receipt object was issued by this cutoff.
   */
  verify(receipt: HostPublicationFailureReceipt): boolean { return this.receipts.has(receipt) }
  /**
   * Consume a claimed grant once at the inbox durable insertion boundary, including while OPEN.
   * @param capability - the claimed initial capability.
   * @param child - the published child Agent.
   * @param message - the message being inserted; must equal the reserved message.
   */
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
  /**
   * Register settlement coverage for a producer kind; constructor-only, retained after provider deregistration.
   * @param kind - the producer kind covered.
   * @param joined - reports whether that producer's work has settled.
   */
  cover(kind: HostWorkKind, joined: () => boolean): void {
    const owners = this.coverage.get(kind) ?? new Set()
    owners.add(joined)
    this.coverage.set(kind, owners)
  }
  /**
   * Snapshot admission, pending reservations, uncovered producer kinds and backend settlement.
   * @returns the admission status; `busy` is true unless everything is provably settled.
   */
  status(): {
    open: boolean
    pending: HostWorkKind[]
    unknown: HostWorkKind[]
    backend: 'JOINED' | 'UNKNOWN'
    busy: boolean
  } {
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
