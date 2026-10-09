/** Process-local authenticated GUI observations. No notification release authority. */
import { randomBytes, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import type { ActivitySnapshot, ActivityTransport } from './rpc.ts'

const openSchema = z.object({ version: z.literal(1), sessionId: z.string().min(1).max(256) }).strict()
const frameSchema = z.object({
  version: z.literal(1), bindingEpoch: z.string().min(1).max(256),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  interaction: z.enum(['input', 'submit', 'focus-control', 'stop', 'leave']),
}).strict()

/** Injectable clock pair; wall time is diagnostic, monotonic time governs age. */
export interface ActivityClock {
  /** @returns server UTC epoch milliseconds. */
  wall(): number
  /** @returns monotonic elapsed milliseconds. */
  mono(): number
}

interface Binding {
  epoch: string
  sequence: number
  order: number
  left: boolean
  at: number | null
  mono: number | null
  valid: () => boolean
}
interface SessionActivity {
  agent: Agent
  revision: number
  controlRevision: number
  controls: string
  bindings: Set<Binding>
  lastActivityAt: number | null
  clockUnknown: boolean
}

/**
 * Connection-owned activity observations for exact existing Agents.
 * This checkpoint deliberately reports unknown Stop/goal controls and never grants release.
 */
export class OperatorActivity {
  readonly hostEpoch = randomBytes(32).toString('base64url')
  private readonly sessions = new Map<string, SessionActivity>()
  private previousWall: number | undefined
  private previousMono: number | undefined
  private order = 0

  /**
   * @param ctx - host registry; reads never create an Agent.
   * @param idleThresholdMs - validated host inactivity threshold.
   * @param clock - paired server clocks.
   */
  constructor(private readonly ctx: Context, readonly idleThresholdMs: number,
    private readonly clock: ActivityClock = { wall: () => Date.now(), mono: () => performance.now() }) {
    if (!Number.isSafeInteger(idleThresholdMs) || idleThresholdMs < 1000 || idleThresholdMs > 3600000) throw new Error('invalid activity idleThresholdMs')
    ctx.on('agent/disposed', ({ agent }) => {
      if (this.sessions.get(agent.id)?.agent === agent) this.sessions.delete(agent.id)
    })
  }

  private time(): { wall: number; mono: number } {
    const wall = this.clock.wall()
    const mono = this.clock.mono()
    if (!Number.isSafeInteger(wall) || wall < 0 || !Number.isSafeInteger(Math.floor(mono)) || mono < 0) {
      this.invalidateClock()
      throw new Error('activity clock unavailable')
    }
    if ((this.previousWall !== undefined && wall < this.previousWall)
      || (this.previousMono !== undefined && mono < this.previousMono)) this.invalidateClock()
    this.previousWall = wall
    this.previousMono = mono
    return { wall, mono }
  }

  private invalidateClock(): void {
    for (const state of this.sessions.values()) {
      state.clockUnknown = true
      for (const binding of state.bindings) { binding.at = null; binding.mono = null }
      state.revision++
    }
  }

  private state(agent: Agent): SessionActivity {
    let state = this.sessions.get(agent.id)
    if (state?.agent !== agent) {
      state = { agent, revision: 0, controlRevision: 0, controls: '', bindings: new Set(), lastActivityAt: null, clockUnknown: false }
      this.sessions.set(agent.id, state)
    }
    return state
  }

  /**
   * Read one synchronous diagnostic cut. Missing authoritative controls remain unknown.
   * @param sessionId - exact authorized existing session id.
   * @returns v1 snapshot, or undefined when no live native Agent exists.
   */
  snapshot(sessionId: string): ActivitySnapshot | undefined {
    const agent = this.ctx.get('agents')?.get(SessionId(sessionId))
    if (agent?.inbox.notifications === undefined) return undefined
    const { wall, mono } = this.time()
    const state = this.state(agent)
    let selected: Binding | undefined
    for (const binding of state.bindings) {
      if (!binding.left && !binding.valid()) { binding.left = true; state.revision++ }
      if (binding.left || binding.at === null || binding.mono === null) continue
      if (binding.at > wall || binding.mono > mono) {
        this.invalidateClock()
        selected = undefined
        break
      }
      if (selected === undefined || binding.order > selected.order) selected = binding
    }
    const age = selected?.mono === null || selected?.mono === undefined ? null : Math.floor(mono - selected.mono)
    const activity = state.clockUnknown ? 'unknown'
      : selected !== undefined ? (age !== null && age < this.idleThresholdMs ? 'active' : 'idle')
        : state.lastActivityAt === null || [...state.bindings].some(binding => !binding.left) ? 'unknown' : 'stale'
    const focus = agent.inbox.notifications.focus.enabled ? 'enabled' : 'disabled'
    const admission = this.ctx.get('hostAdmission')
    const hostAdmission = admission === undefined ? 'unknown' : admission.open ? 'open' : 'closed'
    const foregroundBusy = agent.status !== 'idle' || agent.inbox.notifications.hasForeground
    const controls = JSON.stringify([focus, hostAdmission, foregroundBusy])
    if (state.controls !== controls) { state.controls = controls; state.controlRevision++ }
    const holdReasons = [
      'stop-unknown', 'goal-unknown',
      ...activity === 'active' ? [] : [`activity-${activity}`],
      ...focus === 'enabled' ? ['focus-enabled'] : [],
      ...hostAdmission === 'open' ? [] : [`admission-${hostAdmission}`],
      ...foregroundBusy ? ['foreground-busy'] : [],
    ]
    return {
      schema: 'operator-activity/v1' as const, sessionId, hostEpoch: this.hostEpoch,
      activityRevision: state.revision, controlRevision: state.controlRevision,
      observedAt: wall, lastActivityAt: selected?.at ?? state.lastActivityAt, activityAgeMs: age,
      idleThresholdMs: this.idleThresholdMs, snapshotTtlMs: 5000 as const, state: activity,
      binding: selected === undefined ? null : { bindingEpoch: selected.epoch, principalClass: 'authenticated-operator-gui' as const },
      stop: 'unknown' as const, focus, goal: { state: 'unknown' as const }, hostAdmission, foregroundBusy,
      eligible: false, holdReasons,
    }
  }

  /**
   * Bind a logical activity stream to the authenticated socket and exact live Agent.
   * @param raw - strict version/session open payload.
   * @param uplink - frames on this socket's logical stream.
   * @param transport - physical socket freshness owner.
   * @param authenticated - revalidate the upgrade's browser credential and host fence.
   * @param signal - logical stream cancellation.
   * @returns opening epoch followed by typed frame acknowledgements.
   */
  async *open(raw: unknown, uplink: AsyncIterable<unknown>, transport: ActivityTransport,
    authenticated: () => boolean, signal: AbortSignal): AsyncIterable<unknown> {
    const request = openSchema.parse(raw)
    const agent = this.ctx.get('agents')?.get(SessionId(request.sessionId))
    if (!authenticated() || agent?.inbox.notifications === undefined || agent.inbox.notifications.accepting === false || signal.aborted) throw new Error('operator activity unavailable')
    const state = this.state(agent)
    const binding: Binding = {
      epoch: randomUUID(), sequence: 0, order: 0, left: false, at: null, mono: null,
      valid: () => !signal.aborted && authenticated() && transport.live()
        && this.ctx.get('agents')?.get(agent.id) === agent && agent.inbox.notifications?.accepting !== false,
    }
    state.bindings.add(binding)
    // Opening does not advance activity or displace another tab's qualifying observation.
    try {
      yield { version: 1, bindingEpoch: binding.epoch }
      for await (const rawFrame of uplink) {
        const parsed = frameSchema.safeParse(rawFrame)
        if (!parsed.success) { yield { version: 1, accepted: false, reason: 'invalid-frame' }; continue }
        const frame = parsed.data
        if (frame.bindingEpoch !== binding.epoch || frame.sequence <= binding.sequence) {
          yield { version: 1, accepted: false, reason: 'stale-binding' }; continue
        }
        // An authenticated accepted gesture can establish initial transport freshness;
        // an expired socket may not revive itself through buffered frames.
        if (binding.left || !binding.valid()) { yield { version: 1, accepted: false, reason: 'stale-binding' }; continue }
        const time = this.time()
        binding.sequence = frame.sequence
        if (frame.interaction === 'leave') {
          binding.left = true
          state.revision++
        } else {
          transport.observed()
          binding.at = time.wall
          binding.mono = time.mono
          binding.order = ++this.order
          state.lastActivityAt = time.wall
          state.clockUnknown = false
          state.revision++
        }
        yield { version: 1, accepted: true, sequence: frame.sequence }
      }
    } finally {
      if (!binding.left) state.revision++
      state.bindings.delete(binding)
      binding.left = true
    }
  }
}
