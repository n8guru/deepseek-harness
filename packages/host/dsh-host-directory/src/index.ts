/**
 * Host-side tailnet directory: polls a static list of peer DSH Hosts' own
 * `session/list` Typert Remote method server-to-server over plain `POST
 * /api/session/list` (the EXISTING wire protocol — no new endpoint shape),
 * and publishes the merged remote-session view as one Typert Remote method
 * of its own, `dshHostDirectory/list`, over the same shared `/api` channel
 * (the same mechanism `@deepseek-ai/dsh-host-plugin-inventory` uses).
 *
 * CONFIG: `peers` and `pollIntervalMs` are ordinary `.volatile()` Config
 * fields (Loader's live-reference mechanism — see
 * `@deepseek-ai/dsh-settings`'s README: "Business plugins read their Config
 * references directly"), edited through the profile's Cordis patch or the
 * generic Settings form, exactly like `dsh-bash-local`'s `timeoutMs`. No
 * bespoke settings-namespace registration.
 *
 * AUTH NOTE (ground truth as of this build, later than the Fable 5.1 review
 * this step re-scopes from): every `/api` request — including a
 * server-to-server one — now requires the peer's signed browser-session
 * cookie (Agent Note 2026-08-24-browser-token-authentication; landed BEFORE
 * the review, which still assumed "the Host has no authentication layer to
 * consume a token"). There is no non-browser bearer by design (that note
 * explicitly declined one). This plugin does not invent a second credential:
 * it sends the SAME cookie a browser would hold, supplied once per peer via
 * `DshHostPeer.sessionCookie` — see that field's doc and RESULT.md for the
 * one-time operator bootstrap ceremony this requires per peer pair.
 *
 * R2 read side only (dsh-mesh-session-view project 1479605, step 2): never
 * writes ClaudeSession, mesh-pump, or mesh-pull-dispatch tables; owns no
 * write path into any peer session. Naming follows R6 — "dsh-host", not
 * "mesh" — everywhere in this package.
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  DshHostDirectorySnapshot,
  DshHostPeer,
  DshHostPeerStatus,
  DshHostPeerView,
  DshHostPendingInput,
  DshHostRemoteSession,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Live peer-session directory built from server-to-server session/list polls. */
    dshHostDirectory: DshHostDirectoryService
  }
}

const DshHostPeerSchema = z.object({
  machine: z.string().required(),
  authority: z.string().required(),
  scheme: z.union(['http', 'https'] as const).default('http'),
  // The peer's own signed browser-session cookie value, obtained once via
  // that peer's token-URL exchange (Agent Note
  // 2026-08-24-browser-token-authentication) and pasted here by the
  // operator. Marked secret so settings.describe(redactSecrets) never
  // returns it to a configuration UI.
  sessionCookie: z.string().role('secret'),
  // dsh-mesh-session-view step 6: opt-in per-session pending-input poll.
  // See DshHostPeer.pollPendingInput's doc in types.ts.
  pollPendingInput: z.boolean().default(false),
}) satisfies z<DshHostPeer>

/** Default per-peer poll interval. */
const DEFAULT_POLL_INTERVAL_MS = 5000
/** Lower bound on the configurable poll interval: guards against a fat-fingered 0/near-0 hammering every peer. */
const MIN_POLL_INTERVAL_MS = 1000
/** Per-request timeout for one peer poll; a hung/unreachable peer must not stall the whole tick. */
const POLL_TIMEOUT_MS = 4000
/** Per-session timeout for the OPT-IN pending-input history tail read (step 6). */
const PENDING_INPUT_TIMEOUT_MS = 3000
/** Only the most recent page is needed: an open question/approval is by definition current. */
const PENDING_INPUT_MAX_MESSAGES = 20
/** Tool name the human-facing ask_user_question composer raises (packages/interaction/tool-ask-user). */
const ASK_USER_QUESTION_TOOL = 'ask_user_question'

/** Shape this package actually reads out of one `session.history` event; the
 * Host's own event vocabulary has far more fields, all ignored here. */
interface HistoryEvent {
  type?: string
  data?: {
    callId?: string
    name?: string
    id?: string
    toolName?: string
    reason?: string
    arguments?: { questions?: Array<{ question?: string; header?: string }> }
  }
}

/**
 * Read-only classification of the most recent unresolved human-input
 * request in one page of history events — the exact same rule the Hub's
 * `app/session_inspector.py::classify_pending_input` applies, kept in sync
 * by design (both read `tool/call`+`tool/result` and
 * `approval/asked`+`approval/decided` pairing from the same event
 * vocabulary, KNOWN_SESSION_EVENT_TYPES). A question takes precedence over
 * an open approval when both appear. Returns `undefined` (never guessed)
 * when nothing is pending in this page.
 */
export function classifyPendingInput(events: readonly HistoryEvent[]): DshHostPendingInput | undefined {
  const openCalls = new Map<string, NonNullable<HistoryEvent['data']>>()
  const openApprovals = new Map<string, NonNullable<HistoryEvent['data']>>()
  for (const event of events) {
    const data = event.data
    if (data === undefined) continue
    if (event.type === 'tool/call' && data.callId !== undefined && data.name === ASK_USER_QUESTION_TOOL) {
      openCalls.set(data.callId, data)
    } else if (event.type === 'tool/result' && data.callId !== undefined) {
      openCalls.delete(data.callId)
    } else if (event.type === 'approval/asked' && data.id !== undefined) {
      openApprovals.set(data.id, data)
    } else if (event.type === 'approval/decided' && data.id !== undefined) {
      openApprovals.delete(data.id)
    }
  }
  const lastCall = [...openCalls.values()].at(-1)
  if (lastCall !== undefined) {
    const first = lastCall.arguments?.questions?.[0]
    const summary = first?.question ?? first?.header
    return { kind: 'question', toolName: ASK_USER_QUESTION_TOOL, ...summary === undefined ? {} : { summary } }
  }
  const lastApproval = [...openApprovals.values()].at(-1)
  if (lastApproval !== undefined) {
    return {
      kind: 'approval',
      ...lastApproval.toolName === undefined ? {} : { toolName: lastApproval.toolName },
      ...lastApproval.reason === undefined ? {} : { summary: lastApproval.reason },
    }
  }
  return undefined
}

/** Ref-ified live Config: `.get()` reads the current committed value, no reload needed. */
interface Config {
  machine: Volatile<string | undefined>
  peers: Volatile<DshHostPeer[]>
  pollIntervalMs: Volatile<number>
}

/** One peer's live poll state, private bookkeeping behind the published DshHostPeerView. */
interface PeerState {
  peer: DshHostPeer
  status: DshHostPeerStatus
  sessions: DshHostRemoteSession[]
}

/**
 * Host-only Remote service: owns the peer poll loop and publishes the merged
 * directory snapshot. Declares no same-process Context merge beyond its own
 * `dshHostDirectory` key — Client packages consume it exclusively through
 * the generated `dshHostDirectory/list` Remote, mirroring plugin-inventory.
 * @typert service dshHostDirectory
 */
export class DshHostDirectoryService extends TypertRemoteService {
  static Config = z.object({
    /** Operator-declared label for THIS host in the directory. @default os.hostname() */
    machine: z.string().volatile(),
    /** Configured peers, in operator-declared order. Empty = solo, no polling. */
    peers: z.array(DshHostPeerSchema).default([]).volatile(),
    /** Poll interval in milliseconds for each configured peer. */
    pollIntervalMs: z.natural().default(DEFAULT_POLL_INTERVAL_MS).volatile(),
  })

  private readonly peers = new Map<string, PeerState>()
  private timer: ReturnType<typeof setInterval> | undefined
  private timerIntervalMs: number | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'dshHostDirectory')
    this.syncPeers()
    ctx.on('loader/volatile-update', () => { this.syncPeers() })

    ctx.effect(() => {
      this.rearmTimer()
      return () => {
        clearInterval(this.timer)
        this.timer = undefined
        this.timerIntervalMs = undefined
      }
    }, 'dsh-host-directory: peer poll loop')
  }

  private machineLabel(): string {
    return this.config.machine.get() ?? os.hostname()
  }

  private rearmTimer(): void {
    const intervalMs = Math.max(MIN_POLL_INTERVAL_MS, this.config.pollIntervalMs.get())
    if (this.timerIntervalMs === intervalMs) return
    clearInterval(this.timer)
    this.timerIntervalMs = intervalMs
    this.timer = setInterval(() => {
      void this.pollAllPeers()
    }, intervalMs)
  }

  /** Reconcile tracked peer state against the current live `peers` config on every volatile update. */
  private syncPeers(): void {
    const next = this.config.peers.get()
    const nextAuthorities = new Set(next.map(peer => peer.authority))
    for (const authority of this.peers.keys()) {
      if (!nextAuthorities.has(authority)) this.peers.delete(authority)
    }
    for (const peer of next) {
      const existing = this.peers.get(peer.authority)
      if (existing === undefined) {
        this.peers.set(peer.authority, { peer, status: { state: 'never-polled' }, sessions: [] })
      } else {
        existing.peer = peer
      }
    }
    if (this.timer !== undefined) this.rearmTimer()
  }

  /** Poll every configured peer concurrently; one peer's failure never blocks another's. */
  private async pollAllPeers(): Promise<void> {
    await Promise.all([...this.peers.values()].map(state => this.pollOnePeer(state)))
  }

  private async pollOnePeer(state: PeerState): Promise<void> {
    const { peer } = state
    const scheme = peer.scheme ?? 'http'
    // session/list: the SAME wire endpoint a peer's own browser Client calls
    // (namespace `session`, method `list` — SessionController's Typert
    // binding), reached over the existing shared /api channel. No new route.
    const url = `${scheme}://${peer.authority}/api/session/list`
    const attemptAt = Date.now()
    try {
      if (peer.sessionCookie === undefined || peer.sessionCookie.length === 0) {
        throw new Error('no sessionCookie configured for this peer: run the one-time token-URL exchange first (see RESULT.md)')
      }
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cookie': peer.sessionCookie,
        },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: randomUUID(),
          method: 'session/list',
          // Typert Remote HTTP envelope (0.1.7): the payload carries exactly one
          // `args` object keyed by the method's parameter names; session/list's
          // sole parameter is the reserved empty `_request`. A bare `{}` is
          // rejected by the gateway ("exactly one plain-object args field").
          payload: { args: { _request: {} } },
        }),
        signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
      })
      if (response.status === 401 || response.status === 403) {
        throw new Error(`peer rejected this request with ${String(response.status)} (stale/missing sessionCookie or untrusted authority)`)
      }
      if (!response.ok) {
        throw new Error(`peer responded ${String(response.status)}`)
      }
      const body = await response.json() as {
        result?: { ok?: boolean; value?: { items?: SessionSummary[] }; error?: { message?: string } }
      }
      if (body.result?.ok !== true) {
        throw new Error(body.result?.error?.message ?? 'peer session/list returned an error result')
      }
      const items = body.result.value?.items ?? []
      const current = this.peers.get(peer.authority)
      if (current === undefined || current.peer.authority !== peer.authority) return // config changed mid-flight
      const sessions = items.map((item): DshHostRemoteSession => ({
        sessionId: item.sessionId,
        machine: peer.machine,
        updatedAt: item.updatedAt,
        running: item.running,
        blank: item.blank,
        ...item.cwd === undefined ? {} : { cwd: item.cwd },
      }))
      current.sessions = sessions
      current.status = { state: 'ok', lastPolledAt: attemptAt, sessionCount: items.length }
      // Opt-in only (dsh-mesh-session-view step 6): never blocks or fails the
      // session/list poll above — a per-session read hiccup just omits that
      // one row's pendingInput for this tick, still counted as an 'ok' peer.
      if (peer.pollPendingInput === true && sessions.length > 0) {
        await Promise.all(sessions.map(async (session) => {
          const pendingInput = await this.readOnePendingInput(peer, session.sessionId)
          if (pendingInput === undefined) return
          const stillCurrent = this.peers.get(peer.authority)
          if (stillCurrent === undefined || stillCurrent.peer.authority !== peer.authority) return
          const row = stillCurrent.sessions.find(candidate => candidate.sessionId === session.sessionId)
          if (row !== undefined) (row as { pendingInput?: DshHostPendingInput }).pendingInput = pendingInput
        }))
      }
    } catch (error) {
      const current = this.peers.get(peer.authority)
      if (current === undefined) return
      const lastOkAt = current.status.state === 'ok'
        ? current.status.lastPolledAt
        : current.status.state === 'unreachable' ? current.status.lastOkAt : undefined
      current.status = {
        state: 'unreachable',
        lastAttemptAt: attemptAt,
        ...lastOkAt === undefined ? {} : { lastOkAt },
        message: error instanceof Error ? error.message : String(error),
      }
      current.sessions = []
    }
  }

  /**
   * OPT-IN (step 6, `peer.pollPendingInput`): one extra `session.history`
   * tail read for a single session, the SAME wire endpoint and envelope
   * shape the Hub's `app/session_inspector.py::read_host_history` already
   * uses server-to-server. Never throws — a failure here (network, auth,
   * shape) just means this tick has no pendingInput opinion for this
   * session; it never marks the peer unreachable or clears its sessions,
   * since `session/list` already succeeded for this peer this tick.
   */
  private async readOnePendingInput(peer: DshHostPeer, sessionId: string): Promise<DshHostPendingInput | undefined> {
    const scheme = peer.scheme ?? 'http'
    const url = `${scheme}://${peer.authority}/api/session.history`
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cookie': peer.sessionCookie ?? '' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: randomUUID(),
          method: 'session.history',
          payload: { sessionId, maxMessages: PENDING_INPUT_MAX_MESSAGES },
        }),
        signal: AbortSignal.timeout(PENDING_INPUT_TIMEOUT_MS),
      })
      if (!response.ok) return undefined
      const body = await response.json() as {
        result?: { ok?: boolean; value?: { events?: Array<{ event?: HistoryEvent }> } }
      }
      if (body.result?.ok !== true) return undefined
      const events = (body.result.value?.events ?? [])
        .map(item => item.event)
        .filter((event): event is HistoryEvent => event !== undefined)
      return classifyPendingInput(events)
    } catch {
      return undefined
    }
  }

  /**
   * Read the current merged directory snapshot: every session known from a
   * currently-tracked peer's last successful poll, plus per-peer freshness.
   * Never blocks on a network call — always returns the last poll's result.
   * @returns This host's label, remote sessions, and peer poll status.
   */
  @Remote('list')
  list(): DshHostDirectorySnapshot {
    const sessions: DshHostRemoteSession[] = []
    const peers: DshHostPeerView[] = []
    for (const state of this.peers.values()) {
      sessions.push(...state.sessions)
      peers.push({ machine: state.peer.machine, authority: state.peer.authority, status: state.status })
    }
    return { self: this.machineLabel(), sessions, peers }
  }
}

export default DshHostDirectoryService
