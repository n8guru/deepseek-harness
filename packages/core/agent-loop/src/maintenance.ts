/**
 * Old-source durable maintenance receiver. Persists the owner-bound CLOSED
 * phase in one control session so a restarted Host boots CLOSED. It has no
 * process restart, activation, live reopen, receipt outbox or successor authority.
 * This same-process service has no authenticated transport binding. Its caller
 * must establish owner authority; Host/Origin trust is not authentication.
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

/** One owner-bound maintenance run. `released` takes effect at the next boot only. */
export interface OldMaintenanceRun { readonly owner: string; readonly runId: string; readonly phase: 'closed' | 'released' }
/** Durable control state; each `host/maintenance` event carries the whole next revision. */
export interface OldMaintenanceState { readonly version: 1; readonly revision: number; readonly active: OldMaintenanceRun | null }
/** Receiver command body. Owner authority comes only from the transport argument. */
export type OldMaintenanceCommand = { readonly runId: string; readonly action: 'close' | 'status' | 'release' }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One durable old maintenance control revision.
     * @param data - the complete next control state.
     */
    'host/maintenance': OldMaintenanceState
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context { hostMaintenance: OldHostMaintenance }
}

const CONTROL_ID = SessionId('old-host-maintenance-control')
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256

/** Parse one untrusted command body; unknown fields and owner fields are refused. */
function parseCommand(body: unknown): OldMaintenanceCommand {
  if (typeof body !== 'object' || body === null) throw new Error('maintenance command refused')
  const keys = Object.keys(body).sort().join(',')
  const { runId, action } = body as Record<string, unknown>
  if (keys !== 'action,runId' || !identity(runId) || (action !== 'close' && action !== 'status' && action !== 'release')) {
    throw new Error('maintenance command refused')
  }
  return { runId, action }
}

/** Validate one replayed control revision against its predecessor. */
function parseState(data: unknown, previous: OldMaintenanceState): OldMaintenanceState & { active: OldMaintenanceRun } {
  const state = data as OldMaintenanceState
  const run = state?.active
  if (state?.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision !== previous.revision + 1
    || Object.keys(state).sort().join(',') !== 'active,revision,version'
    || run === null || typeof run !== 'object'
    || Object.keys(run).sort().join(',') !== 'owner,phase,runId'
    || !identity(run.owner) || !identity(run.runId) || (run.phase !== 'closed' && run.phase !== 'released')) {
    throw new Error('invalid old maintenance control revision')
  }
  const active = previous.active
  if (run.phase === 'released'
    ? active?.phase !== 'closed' || active.owner !== run.owner || active.runId !== run.runId
    : active?.phase === 'closed') {
    throw new Error('invalid old maintenance control transition')
  }
  return { version: 1, revision: state.revision, active: structuredClone(run) }
}

/**
 * Durable receiver. Construction holds HostCutoff admission until the control
 * log replays; a replayed `closed` run closes the cutoff before release. Any
 * persistence failure leaves admission held (fail closed).
 */
export default class OldHostMaintenance extends Service {
  static inject = ['sessionPersistence', 'hostAdmission']
  private state: OldMaintenanceState = { version: 1, revision: 0, active: null }
  private seq = 0
  private failed = false
  private ready = false
  private stopping = false
  private readonly retired = new Set<string>()
  private tail: Promise<unknown> = Promise.resolve()
  private readonly persistence: SessionPersistence
  private readonly releaseBoot: () => void

  constructor(ctx: Context) {
    super(ctx, 'hostMaintenance')
    this.persistence = ctx.sessionPersistence
    const cutoff = ctx.hostAdmission
    this.releaseBoot = cutoff.hold()
    ctx.effect(() => async () => {
      this.stopping = true
      cutoff.hold()
      await this.tail
    }, 'old maintenance command join')
  }

  async [Service.init](): Promise<void> {
    const headers = await this.persistence.list()
    if (headers.some(header => header.id === CONTROL_ID)) {
      const { events } = await this.persistence.inspect(CONTROL_ID)
      for (const event of events) {
        if (event.type !== 'host/maintenance') throw new Error('foreign event in old maintenance control log')
        const next = parseState(event.data, this.state)
        const key = JSON.stringify([next.active.owner, next.active.runId])
        if (next.active.phase === 'closed' && this.retired.has(key)) throw new Error('maintenance run already released')
        if (next.active.phase === 'released') this.retired.add(key)
        this.state = next
      }
      this.seq = events.length
    } else {
      await this.persistence.create({ id: CONTROL_ID, version: SESSION_FORMAT_VERSION, createdAt: Date.now() })
    }
    if (this.state.active?.phase === 'closed') this.ctx.hostAdmission.close()
    if (this.stopping) throw new Error('old maintenance receiver stopped during replay')
    this.ready = true
    this.releaseBoot()
  }

  /**
   * Apply one command for a transport-authenticated owner, serialized with every
   * other command. `close` closes the live cutoff BEFORE its durable append; a
   * failed append poisons the receiver and keeps the cutoff closed. `release`
   * records the durable released phase; the live cutoff stays CLOSED and held
   * work is not resumed. Released-run retries return the durable tombstone,
   * including when a different run is active, without appending again.
   * @param owner - owner identity authenticated by the transport, never the body.
   * @param body - untrusted command body.
   * @returns the requested run (or null) and live cutoff status after the command.
   */
  async receive(owner: string, body: unknown): Promise<{ run: OldMaintenanceRun | null; cutoff: ReturnType<Context['hostAdmission']['status']> }> {
    if (!this.ready || this.stopping) throw new Error('old maintenance receiver not ready')
    if (!identity(owner)) throw new Error('maintenance owner refused')
    const command = parseCommand(body)
    const run = this.tail.then(() => this.apply(owner, command))
    this.tail = run.catch(() => undefined)
    return run
  }

  private async apply(owner: string, body: unknown) {
    if (this.stopping) throw new Error('old maintenance receiver stopping')
    if (this.failed) throw new Error('old maintenance receiver poisoned by a failed durable write')
    if (!identity(owner)) throw new Error('maintenance owner refused')
    const command = parseCommand(body)
    // An acknowledged release may have lost its response. Its durable tombstone
    // settles retries even after another run starts, without touching that run.
    if (command.action === 'release' && this.retired.has(JSON.stringify([owner, command.runId]))) {
      return { run: { owner, runId: command.runId, phase: 'released' as const }, cutoff: this.ctx.hostAdmission.status() }
    }
    const active = this.state.active
    const same = active !== null && active.owner === owner && active.runId === command.runId
    if (active?.phase === 'closed' && !same) throw new Error('maintenance run owned by another owner or run')
    switch (command.action) {
      case 'close':
        if (this.retired.has(JSON.stringify([owner, command.runId]))) throw new Error('maintenance run already released')
        if (!same) {
          this.ctx.hostAdmission.close()
          await this.commit({ owner, runId: command.runId, phase: 'closed' })
        }
        break
      case 'status':
        if (!same) throw new Error('maintenance status refused')
        break
      case 'release':
        if (!same || active.phase !== 'closed') throw new Error('maintenance release refused')
        await this.commit({ owner, runId: command.runId, phase: 'released' })
        break
    }
    return { run: structuredClone(this.state.active), cutoff: this.ctx.hostAdmission.status() }
  }

  private async commit(active: OldMaintenanceRun): Promise<void> {
    const next: OldMaintenanceState = { version: 1, revision: this.state.revision + 1, active }
    try {
      await this.persistence.append(CONTROL_ID, [{ type: 'host/maintenance', seq: this.seq, time: Date.now(), data: next }])
    } catch (error: unknown) {
      this.failed = true
      throw error
    }
    this.seq += 1
    this.state = next
    if (active.phase === 'released') this.retired.add(JSON.stringify([active.owner, active.runId]))
  }
}
