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
}) satisfies z<DshHostPeer>

/** Default per-peer poll interval. */
const DEFAULT_POLL_INTERVAL_MS = 5000
/** Lower bound on the configurable poll interval: guards against a fat-fingered 0/near-0 hammering every peer. */
const MIN_POLL_INTERVAL_MS = 1000
/** Per-request timeout for one peer poll; a hung/unreachable peer must not stall the whole tick. */
const POLL_TIMEOUT_MS = 4000

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
          payload: {},
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
      current.sessions = items.map((item): DshHostRemoteSession => ({
        sessionId: item.sessionId,
        machine: peer.machine,
        updatedAt: item.updatedAt,
        running: item.running,
        blank: item.blank,
        ...item.cwd === undefined ? {} : { cwd: item.cwd },
      }))
      current.status = { state: 'ok', lastPolledAt: attemptAt, sessionCount: items.length }
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
