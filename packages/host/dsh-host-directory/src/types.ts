import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * One configured peer DSH Host this Host polls server-to-server. `authority`
 * is a bare `host[:port]` matching the peer's own `--trusted-host` /
 * loopback authority (the same shape `trustedHosts` entries already use), so
 * the poll's `Host` header admits through the peer's existing Host/Origin
 * fence. `machine` is a short display label — never derived from DNS or
 * reverse lookups, always operator-declared.
 *
 * `sessionCookie` carries the SAME signed browser-session cookie value every
 * `dsh web` deployment already mints (Agent Note
 * 2026-08-24-browser-token-authentication): the peer's `admit()` requires it
 * on every /api request, with no non-browser bearer alternative by design
 * (that note explicitly declined a persistent launch-token bearer). This
 * plugin invents no second credential — the operator performs the SAME
 * one-time token-URL exchange the note already documents (open the peer's
 * printed `dsh web` URL once in any browser, or `curl -i` it), then copies
 * the resulting `dsh-auth-<hash>=...` cookie value here. It is a per-peer,
 * operator-provisioned bootstrap secret, not a wire-protocol addition.
 */
export interface DshHostPeer {
  /** Operator-declared short label shown in the directory (e.g. "n8razer"). */
  readonly machine: string
  /** Bare authority the peer Host's own fence already trusts (host or host:port). */
  readonly authority: string
  /** `http:` (default) or `https:`; peers behind `tailscale serve` use https. */
  readonly scheme?: 'http' | 'https'
  /**
   * Raw `Cookie` header value for the peer's signed browser-session cookie
   * (`dsh-auth-<sha256(authority)>=<payload>`), obtained once via the peer's
   * own token-URL exchange. Absent = configured but unauthenticated; polls
   * fail closed with a 401 surfaced in that peer's status, never silently
   * skipped, so a missing bootstrap is visible in the directory itself.
   */
  readonly sessionCookie?: string
  /**
   * Opt-in: also classify each of this peer's sessions' pending human-input
   * state (dsh-mesh-session-view step 6) via one extra per-session
   * `session.history` tail read per poll tick, alongside the existing
   * `session/list` poll. Default false/absent — R2's directory keeps its
   * original single-request-per-tick shape unless an operator asks for
   * this. When enabled, a session with nothing pending simply omits
   * `pendingInput`; a per-session read failure is silent (the session row
   * still appears from `session/list`, just without a pendingInput
   * classification for that tick) rather than marking the whole peer
   * unreachable over one session's read hiccup.
   */
  readonly pollPendingInput?: boolean
}

/**
 * A peer session's most recent unresolved human-input request, classified
 * read-only from the SAME `session.history` server-to-server RPC the Hub's
 * `app/session_inspector.py` already polls for its own fallback view — no
 * new wire endpoint. `question` = an open `ask_user_question` tool/call with
 * no paired `tool/result`; `approval` = an open `approval/asked` with no
 * paired `approval/decided`. A question takes precedence when both are
 * somehow open, matching the Hub-side classifier's tie-break (see
 * app/session_inspector.py's `classify_pending_input`). This is observation
 * only: nothing here answers, decides, or steers the peer session —
 * dsh-mesh-session-view step 6's acceptance criterion is a read-only notice
 * with a deep link, never a second write path into a Host that does not own
 * it (R2/R6: the owning Host stays sole writer).
 */
export type DshHostPendingInput =
  | { readonly kind: 'question'; readonly toolName: string; readonly summary?: string }
  | { readonly kind: 'approval'; readonly toolName?: string; readonly summary?: string }

/** One session row as read from a peer's own `session/list`, plus its owning machine. */
export interface DshHostRemoteSession {
  readonly sessionId: SessionId
  readonly machine: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly cwd?: string
  /**
   * Present only when `pollPendingInput` is enabled for this peer AND the
   * most recent per-session history poll actually classified an open
   * question/approval. Omitted (not merely `undefined`) otherwise, so R2's
   * original `session/list`-mirror contract is byte-for-byte unchanged for
   * every existing consumer that does not opt into this field.
   */
  readonly pendingInput?: DshHostPendingInput
}

/** Live poll status for one configured peer, for directory-freshness display. */
export type DshHostPeerStatus =
  | { readonly state: 'ok'; readonly lastPolledAt: number; readonly sessionCount: number }
  | { readonly state: 'unreachable'; readonly lastAttemptAt: number; readonly lastOkAt?: number; readonly message: string }
  | { readonly state: 'never-polled' }

/** One row of the peer roster, joining static config with live poll status. */
export interface DshHostPeerView {
  readonly machine: string
  readonly authority: string
  readonly status: DshHostPeerStatus
}

/** Directory snapshot returned by the Remote `dshHostDirectory/list` method. */
export interface DshHostDirectorySnapshot {
  /** This Host's own declared machine label (Config `machine`, falling back to hostname). */
  readonly self: string
  /**
   * Sessions discovered on every currently-reachable configured peer. Never
   * includes local sessions — callers already have `session/list` for those.
   */
  readonly sessions: readonly DshHostRemoteSession[]
  /** Configured peers and their live poll freshness, in configured order. */
  readonly peers: readonly DshHostPeerView[]
}
