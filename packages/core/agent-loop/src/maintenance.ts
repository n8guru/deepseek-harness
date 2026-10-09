/** Optional native durable maintenance receiver. No process restart or activation authority. */
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { LlmBackendCoverage } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentHandle, AgentSetup, HostAdmission, HostAdmissionTicket, HostInitialAdmission, HostReservation } from '@deepseek-ai/dsh-agent'

const identity = z.string().min(1).max(256)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const itemSchema = z.object({ sequence: identity, kind: z.enum(['notification', 'supervisor']), payload: z.string().max(200_000) }).strict()
const receiptTargetSchema = z.object({ kind: z.literal('agent'), sessionId: identity }).strict()
const deliverySchema = itemSchema.extend({ target: receiptTargetSchema }).strict()
export const maintenanceReceiptGrantSchema = z.object({ owner: identity, kind: z.enum(['notification', 'supervisor']), target: receiptTargetSchema }).strict()
export type MaintenanceReceiptGrant = z.infer<typeof maintenanceReceiptGrantSchema>
const commandBase = { runId: identity }
/** Transport authenticates owner separately; a body can never confer owner authority. */
export const maintenanceCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...commandBase, action: z.literal('close') }).strict(),
  z.object({ ...commandBase, action: z.literal('status') }).strict(),
  z.object({ ...commandBase, action: z.literal('release') }).strict(),
  z.object({ ...commandBase, action: z.literal('receipts'), items: z.array(itemSchema).min(1).max(10) }).strict(),
  z.object({ ...commandBase, action: z.literal('deliver-receipts'), items: z.array(deliverySchema).min(1).max(10) }).strict(),
  z.object({ ...commandBase, action: z.literal('claim-successor'), batonDigest: digest }).strict(),
  z.object({ ...commandBase, action: z.literal('start-successor'), batonDigest: digest, baton: z.string().min(1).max(200_000) }).strict(),
])
export type MaintenanceCommand = z.infer<typeof maintenanceCommandSchema>
/** Only trusted Host configuration supplies launch authority; absent means disabled. */
export const maintenanceLaunchConfigSchema = z.object({
  owner: identity, agentPreset: identity, provider: identity, model: identity,
  cwd: z.string().min(1).refine(value => value.startsWith('/'), 'absolute native workspace required'),
}).strict()
export type MaintenanceLaunchConfig = z.infer<typeof maintenanceLaunchConfigSchema>
export const maintenanceConfigSchema = z.object({
  successor: maintenanceLaunchConfigSchema.optional(),
  receiptGrants: z.array(maintenanceReceiptGrantSchema).default([]),
}).strict()
export type MaintenanceConfig = z.input<typeof maintenanceConfigSchema>
const successorIntentSchema = z.object({
  messageId: identity, baton: z.string().min(1).max(200_000),
  launch: maintenanceLaunchConfigSchema,
}).strict()
const runSchema = z.object({
  owner: identity, runId: identity, phase: z.enum(['closed', 'released']),
  receipts: z.array(itemSchema.extend({ digest })),
  deliveries: z.array(deliverySchema.extend({ digest, messageId: identity, status: z.enum(['accepted-intent', 'delivered']) })).optional(),
  successor: z.object({ batonDigest: digest, sessionId: identity, status: z.enum(['claimed', 'accepted-intent', 'started', 'complete']), intent: successorIntentSchema.optional() }).nullable(),
}).strict()
export const maintenanceStateSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(), active: z.string().nullable(),
  runs: z.record(z.string(), runSchema),
}).strict()
export type MaintenanceState = z.infer<typeof maintenanceStateSchema>
export type MaintenanceRun = z.infer<typeof runSchema>
/** Unknown participants prohibit an idle claim; initiating agents are never excluded. */
export interface MaintenanceStatus extends MaintenanceRun {
  activity: {
    closed: boolean
    busy: boolean
    activeAgents: string[]
    activeTools: number
    activeReservations: { kind: string; sessionId?: string }[]
    unknownParticipants: string[]
    providerBackends?: LlmBackendCoverage
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One atomic owner/run gate, notification+supervisor receipt batch, and successor claim transaction. */
    'host/maintenance': MaintenanceState
    /** Immutable native successor session binding, committed before publication. */
    'host/maintenance-successor': { owner: string; runId: string; batonDigest: string; messageId: string; launch: MaintenanceLaunchConfig }
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    hostMaintenance: HostMaintenance
    /** Published only after the control write lease has replayed and flushed. */
    hostMaintenanceReady: HostMaintenance
    /** Trusted Host preset composer. Request bodies cannot register or replace it. */
    maintenanceSuccessorSetup?: { prepare(launch: MaintenanceLaunchConfig): AgentSetup }
  }
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const runKey = (owner: string, runId: string): string => hash(JSON.stringify([owner, runId]))

/** A single leased control log owns all transactions; uncertain durability poisons admission. */
export class HostMaintenance extends Service implements HostAdmission {
  static inject = ['sessionPersistence']
  /** Process-local identity fencing replacement of the admission owner. */
  readonly controlEpochId: string = randomUUID()
  private readonly ownedPersistence: SessionPersistence
  private handle: SessionHandle | undefined
  private seq = 0
  private ready = false
  private failed = false
  private closing = 0
  private activeTools = 0
  // Receipt/claim bookkeeping must not cancel concurrent admitted worker setup.
  private admissionEpoch = 0
  private tail: Promise<unknown> = Promise.resolve()
  private readonly producerCoverage = new WeakMap<object, { kind: 'publication' | 'job' | 'delegate' | 'workflow'; producer: object; joined: () => boolean }>()
  private readonly reservations = new Map<HostAdmissionTicket, { kind: 'publication' | 'job' | 'delegate' | 'workflow'; sessionId?: SessionId }>()
  private readonly initialAdmissions = new WeakMap<HostInitialAdmission, { parent: Agent; signal: AbortSignal; reservation: HostAdmissionTicket; ticket: HostAdmissionTicket; message: ReturnType<typeof createUserMessage>; compiler?: ((child: Agent, original: ReturnType<typeof createUserMessage>) => ReturnType<typeof createUserMessage>) | undefined; compiled: 'pending' | 'running' | 'complete' | 'failed'; claimed: boolean; accepted: boolean }>()
  private readonly initialTickets = new WeakMap<HostAdmissionTicket, HostInitialAdmission>()
  private readonly tickets = new WeakMap<HostAdmissionTicket, number>()
  private readonly permits = new WeakMap<HostAdmissionTicket, { key: string; sessionId: string; active: boolean }>()
  private readonly successors = new Map<string, AgentHandle>()
  private readonly successorPermits = new Map<string, HostAdmissionTicket>()
  private state: MaintenanceState = { version: 1, revision: 0, active: null, runs: {} }

  private readonly launchConfig: MaintenanceLaunchConfig | undefined
  private readonly receiptGrants: readonly MaintenanceReceiptGrant[]

  constructor(ctx: Context, config: MaintenanceConfig = {}) {
    super(ctx, 'hostMaintenance')
    this.ownedPersistence = ctx.sessionPersistence
    const trusted = maintenanceConfigSchema.parse(config)
    this.launchConfig = trusted.successor
    this.receiptGrants = trusted.receiptGrants
    // Publish the synchronous fail-closed barrier before the first persistence await.
    ctx.provide('hostAdmission', this)
    ctx.provide('maintenanceReceiver', this)
    ctx.on('tools/execute', async (_execution, next) => {
      this.activeTools += 1
      try { return await next() } finally { this.activeTools -= 1 }
    })
    ctx.effect(() => async () => {
      this.updateAdmission(() => { this.ready = false })
      await this.tail.catch(() => {})
      await this.handle?.close()
    })
  }

  async [Service.init](): Promise<void> {
    const persistence = this.ownedPersistence
    const id = SessionId('native-host-maintenance-control')
    try { this.handle = await persistence.open(id, 'write') }
    catch (error) {
      if (!(error instanceof SessionPersistenceNotFoundError)) throw error
      this.handle = await persistence.create({ id, version: SESSION_FORMAT_VERSION, createdAt: Date.now(), isSeeded: false })
    }
    const { events } = await this.handle.read()
    for (const event of events) {
      if (event.type !== 'host/maintenance') throw new Error('foreign event in native maintenance control log')
      const next = maintenanceStateSchema.parse(event.data)
      if (next.revision !== this.state.revision + 1) throw new Error('noncontiguous maintenance revision')
      this.state = next
    }
    this.seq = events.length
    await this.handle.flush()
    this.updateAdmission(() => { this.ready = true })
    this.ctx.provide('hostMaintenanceReady', this)
  }

  get open(): boolean {
    const active = this.state.active === null ? undefined : this.state.runs[this.state.active]
    return this.ready && !this.failed && this.closing === 0 && active?.phase !== 'closed'
  }

  private controlEpoch = 0
  /** Native live admission revision; committed before changed-event observers run. */
  get controlRevision(): number { return this.controlEpoch }

  /** Publish every live admission edge at its owner, including failed close round trips. */
  private updateAdmission(change: () => void): void {
    const wasOpen = this.open
    change()
    this.controlEpoch++
    if (wasOpen !== this.open) this.ctx.emit('host-admission/changed')
  }

  /** New work never inherits authority from a prompt, Focus, or ambient initiator. */
  assert(ticket?: HostAdmissionTicket): void {
    // A counted operation accepted before close may finish; this is not authority
    // for a new operation and uncertainty still refuses even existing reservations.
    if (this.ready && !this.failed && ticket !== undefined && this.reservations.has(ticket)) return
    const active = this.state.active === null ? undefined : this.state.runs[this.state.active]
    if (!this.ready || this.failed || this.closing > 0 || active?.phase === 'closed') throw new Error('native maintenance admission closed')
    if (ticket !== undefined && this.tickets.get(ticket) !== this.admissionEpoch) throw new Error('native maintenance admission epoch changed')
  }

  begin(): HostAdmissionTicket {
    this.assert()
    const ticket = Object.freeze({})
    this.tickets.set(ticket, this.admissionEpoch)
    return ticket
  }

  /** Issued once at instrumented producer construction, never retrospectively from an empty list. */
  coverage(kind: 'publication' | 'job' | 'delegate' | 'workflow', producer: object, joined: () => boolean = () => true): object {
    const capability = Object.freeze({})
    this.producerCoverage.set(capability, { kind, producer, joined })
    return capability
  }

  /** Synchronous reservation closes the admit/await/publication race without cancelling old work. */
  reserve(kind: 'publication' | 'job' | 'delegate' | 'workflow', sessionId?: SessionId): HostReservation {
    this.assert()
    const ticket = Object.freeze({})
    this.reservations.set(ticket, { kind, ...(sessionId === undefined ? {} : { sessionId }) })
    const children = new Set<HostAdmissionTicket>()
    return {
      ticket,
      child: (childId, message, parent, signal, compiler) => {
        this.assert()
        if (!this.reservations.has(ticket) || sessionId === undefined || parent.id !== sessionId || this.ctx.get('agents')?.get(sessionId) !== parent || kind !== 'delegate' || children.size > 0) throw new Error('native child lineage refused')
        const capability = Object.freeze({ sessionId: childId, messageId: message.id })
        const publication = Object.freeze({})
        this.reservations.set(publication, { kind: 'publication', sessionId: childId })
        this.initialAdmissions.set(capability, { parent, signal, reservation: ticket, ticket: publication, message: structuredClone(message), compiler, compiled: 'pending', claimed: false, accepted: false })
        this.initialTickets.set(publication, capability)
        children.add(publication)
        return capability
      },
      release: () => {
        this.reservations.delete(ticket)
        for (const child of children) {
          const capability = this.initialTickets.get(child)
          if (capability === undefined) throw new Error('native initial capability unavailable')
          const grant = this.initialAdmissions.get(capability)
          if (grant === undefined) throw new Error('native initial admission unavailable')
          if (!grant.claimed) this.reservations.delete(child)
        }
      },
    }
  }

  initial(capability: HostInitialAdmission, sessionId: SessionId, parent: Agent | undefined, consume: boolean) {
    const grant = this.initialAdmissions.get(capability)
    if (grant === undefined || grant.claimed || capability.sessionId !== sessionId || grant.parent !== parent
      || this.ctx.get('agents')?.get(grant.parent.id) !== parent || !this.reservations.has(grant.reservation)) throw new Error('native initial admission refused')
    this.assert(grant.ticket)
    grant.signal.throwIfAborted()
    if (consume) grant.claimed = true
    return {
      ticket: grant.ticket, message: structuredClone(grant.message), signal: grant.signal, deferred: grant.compiler !== undefined,
      release: () => { this.reservations.delete(grant.ticket) },
      join: () => { this.reservations.delete(grant.ticket); if (grant.compiler !== undefined) this.reservations.delete(grant.reservation) },
    }
  }

  compileInitial(capability: HostInitialAdmission, child: Agent, message?: ReturnType<typeof createUserMessage>) {
    const grant = this.initialAdmissions.get(capability)
    if (grant === undefined || !grant.claimed || grant.accepted || grant.compiler === undefined
      || capability.sessionId !== child.id || this.ctx.get('agents')?.get(child.id) !== child
      || this.ctx.get('agents')?.get(grant.parent.id) !== grant.parent || !this.reservations.has(grant.reservation)) throw new Error('native initial compiler refused')
    this.assert(grant.ticket)
    grant.signal.throwIfAborted()
    if (message === undefined) {
      if (grant.compiled !== 'pending') throw new Error('native initial compiler consumed')
      grant.compiled = 'running'
      try {
        const compiled = structuredClone(grant.compiler(child, structuredClone(grant.message)))
        if (compiled.id !== grant.message.id || JSON.stringify(compiled.source) !== JSON.stringify(grant.message.source)) throw new Error('native initial compiler identity refused')
        grant.message = compiled
        grant.compiled = 'complete'
      } catch (error) { grant.compiled = 'failed'; throw error }
    } else if (grant.compiled !== 'complete' || JSON.stringify(message) !== JSON.stringify(grant.message)) throw new Error('native compiled initial input refused')
    return { ticket: grant.ticket, message: structuredClone(grant.message), release: () => { this.reservations.delete(grant.ticket) } }
  }

  assertReceipt(ticket: HostAdmissionTicket, message: ReturnType<typeof createUserMessage>): void {
    const capability = this.initialTickets.get(ticket)
    if (capability === undefined) {
      if (this.reservations.has(ticket)) throw new Error('native publication is not receipt authority')
      return
    }
    const grant = this.initialAdmissions.get(capability)
    if (grant === undefined) throw new Error('native initial admission unavailable')
    this.assert(ticket)
    if (!grant.claimed || grant.accepted || (grant.compiler !== undefined && grant.compiled !== 'complete') || JSON.stringify(message) !== JSON.stringify(grant.message)) throw new Error('native initial input refused')
    grant.accepted = true
  }

  assertMaintenancePermit(ticket: HostAdmissionTicket): void {
    if (this.initialTickets.has(ticket)) throw new Error('native initial input is not general maintenance authority')
  }

  /** No ambient bypass: the opaque permit works only for its exact closed run/session. */
  forSession(permit: HostAdmissionTicket, sessionId: SessionId): HostAdmission {
    const reserved = this.reservations.get(permit)
    if (reserved?.kind === 'publication' && reserved.sessionId === sessionId) {
      const check = (): void => {
        if (!this.reservations.has(permit)) throw new Error('native reservation retired')
        this.assert(permit)
      }
      return { get open() { try { check(); return true } catch { return false } }, assert: check, begin: () => { check(); return permit } }
    }
    const authority = this.permits.get(permit)
    const check = (): void => {
      if (authority === undefined || !authority.active || authority.sessionId !== sessionId
        || !this.ready || this.failed || this.state.active !== authority.key
        || this.state.runs[authority.key]?.phase !== 'closed') throw new Error('native successor permit refused')
    }
    check()
    return {
      get open() { try { check(); return true } catch { return false } },
      assert: check,
      begin: () => { check(); return permit },
    }
  }

  private async commit(next: MaintenanceState, release = false): Promise<void> {
    next.revision = this.state.revision + 1
    const handle = this.handle
    if (handle === undefined) throw new Error('maintenance control handle unavailable')
    try {
      await handle.append([{ type: 'host/maintenance', seq: SessionSeq(this.seq), time: Date.now(), data: next }])
      await handle.flush()
    } catch (error) { this.updateAdmission(() => { this.failed = true }); throw error }
    this.seq += 1
    this.updateAdmission(() => {
      if (release) this.admissionEpoch += 1
      this.state = next
    })
  }

  private async materializeSuccessor(key: string): Promise<MaintenanceRun> {
    const run = this.state.runs[key]
    const successor = run?.successor
    if (run === undefined || successor?.intent === undefined) throw new Error('successor intent unavailable')
    if (successor.status !== 'accepted-intent') return structuredClone(run)
    const composer = this.ctx.get('maintenanceSuccessorSetup')
    if (composer === undefined) return structuredClone(run) // accepted intent, never a started ACK
    const agents = this.ctx.get('agents')
    const sessions = this.ctx.get('sessions')
    if (agents === undefined || sessions === undefined) throw new Error('native successor services unavailable')
    const launch = successor.intent.launch
    const setup = composer.prepare(structuredClone(launch)) // Host validates approved preset/route/workspace
    const permit = this.successorPermits.get(key) ?? Object.freeze({})
    const authority = this.permits.get(permit) ?? { key, sessionId: successor.sessionId, active: true }
    authority.active = true
    this.permits.set(permit, authority)
    this.successorPermits.set(key, permit)
    let child = this.successors.get(key)
    try {
      if (child === undefined) {
        const agentOptions = { provider: launch.provider, model: launch.model }
        const binding = {
          owner: run.owner, runId: run.runId, batonDigest: successor.batonDigest, messageId: successor.intent.messageId, launch,
        }
        const validateBinding: AgentSetup = async (ctx, agent) => {
          const prior = agent.session.snapshotEvents().filter(event => event.type === 'host/maintenance-successor')
          if (prior.length !== 1 || JSON.stringify(prior[0]?.data) !== JSON.stringify(binding)) throw new Error('successor durable owner/run binding mismatch')
          return await setup(ctx, agent)
        }
        try {
          child = await agents.resume({
            resumeSessionId: SessionId(successor.sessionId), agentOptions, setup: validateBinding, maintenancePermit: permit,
          })
        } catch (error) {
          if (!(error instanceof SessionPersistenceNotFoundError)) throw error
          child = await agents.create({
            sessionId: SessionId(successor.sessionId), meta: { cwd: launch.cwd, agentPreset: launch.agentPreset }, agentOptions,
            setup: async (ctx, agent) => {
              agent.session.append('host/maintenance-successor', binding)
              return await setup(ctx, agent)
            },
            maintenancePermit: permit,
          })
        }
        this.successors.set(key, child)
      }
      const inbox = child.agent.inbox.notifications
      if (inbox === undefined) throw new Error('successor native durable inbox unsupported')
      const origin = 'native:maintenance-successor'
      const sequence = successor.intent.messageId
      if (inbox.receipt(origin, sequence) === undefined) {
        const message = { ...createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: successor.intent.baton }] }), id: MessageId(sequence) }
        inbox.setFocus(true)
        inbox.admit('next-turn', message, { origin, sequence })
      }
      await sessions.flush(child.agent.session) // initial receipt MUST be durable before wake
      const entered = child.agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === sequence)
      if (!entered) {
        inbox.check(sequence)
        await sessions.flush(child.agent.session)
        child.agent.wakeInbox?.()
        await child.agent.whenIdle()
        await sessions.flush(child.agent.session)
      }
      const events = child.agent.session.snapshotEvents()
      if (!events.some(event => event.type === 'user/message' && event.data.id === sequence)) return structuredClone(run)
      const next = this.snapshot()
      const settled = next.runs[key]?.successor
      if (settled === undefined || settled === null) throw new Error('successor state lost')
      const entryIndex = events.findIndex(event => event.type === 'user/message' && event.data.id === sequence)
      settled.status = events.slice(entryIndex + 1).some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed') ? 'complete' : 'started'
      await this.commit(next)
      const committed = this.state.runs[key]
      if (committed === undefined) throw new Error('maintenance owner/run lost')
      return structuredClone(committed)
    } finally { authority.active = false }
  }

  private async deliverReceipts(key: string): Promise<MaintenanceRun> {
    const run = this.state.runs[key]
    if (run === undefined || run.phase !== 'closed' || this.state.active !== key) throw new Error('receipt delivery requires exact closed owner/run')
    const agents = this.ctx.get('agents')
    const sessions = this.ctx.get('sessions')
    for (const delivery of run.deliveries ?? []) {
      if (delivery.status === 'delivered') continue
      if (!this.receiptGrants.some(grant => grant.owner === run.owner && grant.kind === delivery.kind && grant.target.sessionId === delivery.target.sessionId)) throw new Error('native receipt target grant denied')
      const origin = `native:maintenance-receipt:${run.owner}`
      const sequence = delivery.messageId
      const content = [{ type: 'text' as const, text: delivery.payload }]
      const targetId = SessionId(delivery.target.sessionId)
      const target = agents?.get(targetId)
      if (target === undefined) {
        // Cold reconciliation reads durable evidence, never creates/resumes an executor.
        const handle = await this.ctx.sessionPersistence.open(targetId, 'read')
        try {
          const { events } = await handle.read()
          const prior = events.flatMap(event => event.type === 'agent/inbox/spliced' && event.data.notification?.origin === origin && event.data.notification.sequence === sequence ? event.data.inserted : [])
          if (prior.length !== 1 || prior[0]?.id !== sequence || JSON.stringify(prior[0].content) !== JSON.stringify(content)) throw new Error('native receipt target unavailable or evidence conflict')
        } finally { await handle.close() }
      } else {
        if (sessions === undefined || agents === undefined) throw new Error('native receipt services unavailable')
        const inbox = target.inbox.notifications
        if (inbox?.admitMaintenance === undefined) throw new Error('native receipt target driver unsupported')
        const prior = inbox.receipt(origin, sequence)
        if (prior !== undefined && (prior.id !== sequence || JSON.stringify(prior.content) !== JSON.stringify(content))) throw new Error('native target receipt content conflict')
        const permit = Object.freeze({})
        const authority = { key, sessionId: targetId, active: true }
        this.permits.set(permit, authority)
        try {
          inbox.admitMaintenance(permit, 'next-turn', { ...createUserMessage({ source: { kind: 'user' }, content }), id: MessageId(sequence) }, { origin, sequence })
          if (!await sessions.flush(target.session)) throw new Error('native target receipt durability unavailable')
          if (inbox.accepting !== true || agents.get(targetId) !== target) throw new Error('native receipt target owner changed or disposed')
        } finally { authority.active = false }
      }
      const next = this.snapshot()
      const accepted = next.runs[key]?.deliveries?.find(item => item.messageId === sequence)
      if (accepted === undefined) throw new Error('native receipt intent lost')
      accepted.status = 'delivered'
      await this.commit(next) // ACK only after target receipt durability, reconciled on restart
    }
    const committed = this.state.runs[key]
    if (committed === undefined) throw new Error('maintenance owner/run lost')
    return structuredClone(committed)
  }

  private readStatus(key: string): MaintenanceStatus {
    const run = this.state.runs[key]
    if (run === undefined) throw new Error('maintenance owner/run not found')
    const agents = this.ctx.get('agents')
    const activeAgents = agents?.list().filter(agent => agent.status !== 'idle').map(agent => agent.id) ?? []
    // These require authoritative global probes, not caller-filtered lists or guessed zeroes.
    const unknownParticipants: string[] = []
    const groups = [
      ['jobs-global', 'jobs', 'job'], ['delegates-global', 'subagents', 'delegate'],
      ['workflows-global', 'workflowEngine', 'workflow'], ['preclose-publications', 'agentLoop', 'publication'],
    ] as const
    for (const [group, service, kind] of groups) {
      try {
        const producer = this.ctx.get(service) as { maintenanceCoverage?: object } | undefined
        const proof = producer?.maintenanceCoverage === undefined ? undefined : this.producerCoverage.get(producer.maintenanceCoverage)
        if (producer === undefined || proof?.kind !== kind
          || proof.producer !== (Reflect.get(producer, symbols.original) ?? producer) || !proof.joined()
          || kind === 'publication' && (this.ctx.get('sessionPersistence')?.identity !== this.ownedPersistence.identity || this.ownedPersistence.writeJoined?.() !== true)
          || [...this.reservations.values()].some(reservation => reservation.kind === kind)) unknownParticipants.push(group)
      } catch { unknownParticipants.push(group) }
    }
    if (agents === undefined) unknownParticipants.push('agents')
    if (this.ctx.get('tools') === undefined) unknownParticipants.push('tools')
    // Actual runtime registration/caller ownership, never Agent idle or cancellation ACK.
    let providerBackends: LlmBackendCoverage | undefined
    try { providerBackends = this.ctx.get('llm')?.backendCoverage() } catch { /* unavailable remains UNKNOWN */ }
    if (providerBackends?.state !== 'JOINED') unknownParticipants.push('provider-backends')
    const activeReservations = [...this.reservations.values()].map(value => ({ ...value }))
    return {
      ...structuredClone(run),
      activity: {
        closed: !this.open,
        busy: activeAgents.length > 0 || this.activeTools > 0 || activeReservations.length > 0 || unknownParticipants.length > 0,
        activeAgents, activeTools: this.activeTools, activeReservations, unknownParticipants,
        ...providerBackends === undefined ? {} : { providerBackends },
      },
    }
  }

  /** Detached state prevents a caller mutating receiver authority or durable receipts. */
  snapshot(): MaintenanceState { return structuredClone(this.state) }

  /**
   * Invoke only after the existing transport authenticates an explicitly granted owner.
   * No live action, successor execution, goal mutation, or release of prior user pauses occurs here.
   */
  receive(authenticatedOwner: string, raw: { action: 'status'; runId: string }): Promise<MaintenanceStatus>
  receive(authenticatedOwner: string, raw: unknown): Promise<MaintenanceRun>
  receive(authenticatedOwner: string, raw: unknown): Promise<MaintenanceRun> {
    const owner = identity.parse(authenticatedOwner)
    const command = maintenanceCommandSchema.parse(raw)
    // Read a committed cut without joining the mutation tail: an initiating tool
    // or successor may itself be awaiting this status. Never omit that caller.
    if (command.action === 'status') return Promise.resolve(this.readStatus(runKey(owner, command.runId)))
    // Close rejects new calls immediately, including while its durable write is pending.
    const closes = command.action === 'close'
    if (closes) this.updateAdmission(() => { this.closing += 1; this.admissionEpoch += 1 })
    const result = this.tail.then(async () => {
      if (!this.ready || this.failed) throw new Error('native maintenance durability unavailable')
      const key = runKey(owner, command.runId)
      const next = this.snapshot()
      let run = next.runs[key]
      if (command.action === 'close') {
        if (run?.phase === 'released') throw new Error('released maintenance run cannot be reopened')
        if (next.active !== null && next.active !== key) throw new Error('maintenance run belongs to another owner or run')
        run ??= { owner, runId: command.runId, phase: 'closed', receipts: [], successor: null }
        next.runs[key] = run
        next.active = key
      } else {
        if (run === undefined) throw new Error('maintenance owner/run not found')
        if (command.action === 'release') {
          if (next.active !== null && next.active !== key) throw new Error('stale maintenance release')
          run.phase = 'released'
          next.active = null
        } else if (command.action === 'deliver-receipts') {
          if (run.phase !== 'closed' || next.active !== key) throw new Error('receipt intent requires exact closed owner/run')
          const seen = new Set<string>()
          for (const item of command.items) {
            if (seen.has(item.sequence)) throw new Error('duplicate receipt sequence')
            seen.add(item.sequence)
            if (!this.receiptGrants.some(grant => grant.owner === owner && grant.kind === item.kind && grant.target.sessionId === item.target.sessionId)) throw new Error('native receipt target grant denied')
            const itemDigest = hash(JSON.stringify(item))
            const prior = run.deliveries?.find(delivery => delivery.sequence === item.sequence)
            if (prior !== undefined && prior.digest !== itemDigest) throw new Error('native receipt sequence content conflict')
            if (prior === undefined) (run.deliveries ??= []).push({ ...item, digest: itemDigest, messageId: `maintenance-receipt-${hash(JSON.stringify([key, item.sequence]))}`, status: 'accepted-intent' })
          }
        } else if (command.action === 'receipts') {
          const sequences = new Set<string>()
          for (const item of command.items) {
            if (sequences.has(item.sequence)) throw new Error('duplicate maintenance receipt sequence')
            sequences.add(item.sequence)
            const itemDigest = hash(JSON.stringify(item))
            const prior = run.receipts.find(receipt => receipt.sequence === item.sequence)
            if (prior !== undefined && prior.digest !== itemDigest) throw new Error('maintenance receipt content conflict')
            if (prior === undefined) run.receipts.push({ ...item, digest: itemDigest })
          }
        } else {
          if (command.action === 'start-successor') {
            const launch = this.launchConfig
            if (launch === undefined || launch.owner !== owner) throw new Error('native successor launch disabled for this owner')
            if (run.phase !== 'closed' || next.active !== key) throw new Error('successor intent requires exact closed owner/run')
            if (hash(command.baton) !== command.batonDigest) throw new Error('successor baton digest mismatch')
            if (run.successor !== null && run.successor.batonDigest !== command.batonDigest) throw new Error('successor baton conflict')
            const intent = { messageId: `successor-input-${key}`, baton: command.baton, launch }
            if (run.successor?.intent !== undefined && JSON.stringify(run.successor.intent) !== JSON.stringify(intent)) throw new Error('immutable successor intent conflict')
            run.successor = { batonDigest: command.batonDigest, sessionId: `successor-${key}`, status: run.successor?.intent === undefined ? 'accepted-intent' : run.successor.status, intent }
          } else {
            if (next.active !== null && next.active !== key) throw new Error('successor claim belongs to another closed run')
            if (run.successor !== null && run.successor.batonDigest !== command.batonDigest) throw new Error('successor baton conflict')
            run.successor ??= { batonDigest: command.batonDigest, sessionId: `successor-${key}`, status: 'claimed' }
          }
        }
      }
      // A retry that changes nothing spends no new event or epoch.
      if (JSON.stringify(next) === JSON.stringify(this.state)) return command.action === 'start-successor' ? this.materializeSuccessor(key) : command.action === 'deliver-receipts' ? this.deliverReceipts(key) : structuredClone(run)
      await this.commit(next, command.action === 'release')
      this.ctx.emit('host-admission/changed')
      return command.action === 'start-successor' ? this.materializeSuccessor(key) : command.action === 'deliver-receipts' ? this.deliverReceipts(key) : structuredClone(run)
    }).finally(() => { if (closes) this.updateAdmission(() => { this.closing -= 1 }) })
    this.tail = result.catch(() => {})
    // Durable close ACK includes live drain telemetry, never waits for its caller.
    return closes ? result.then(() => this.readStatus(runKey(owner, command.runId))) : result
  }
}
export default HostMaintenance
