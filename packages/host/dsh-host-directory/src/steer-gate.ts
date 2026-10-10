/**
 * allow-remote-steer gate (dsh-mesh-session-view step 5, R4 steer + R5 gate;
 * capability `dsh-host`, never `mesh`).
 *
 * Steering a peer session is NOT a new primitive: a tab opened by the step-4
 * deep link is served from the OWNING Host's own origin, so its composer
 * issues the very same `session/prompt` write RPC the Host's local composer
 * does. There is nothing to relay. What this module adds is an explicit,
 * per-session, default-OFF opt-in that the owning Host enforces before such a
 * request is dispatched (defense in depth on top of tailnet/transport auth).
 *
 * WHICH REQUESTS ARE "REMOTE". The deep-link tab reaches the Host through its
 * non-loopback authority (the tailnet/trusted-host name carried in the
 * `Host` header); the owner's own local UI is served from loopback. A request
 * whose `Host` authority is loopback is the owner at the keyboard and is never
 * gated. Any other authority — including a missing/unparsable one — is remote
 * and must hold the opt-in. (The `Host` header is the same fence input
 * `api-request-trust.ts` already treats as unforgeable by a browser.)
 *
 * WHAT IS GATED. Session-addressed mutators (`GATED_STEER_ENDPOINTS`) from a
 * remote origin, and the opt-in setter itself (a remote tab can never grant
 * itself the opt-in). Reads (`session/page`, `follow`, `list`, ...) and the
 * approval/question answer channel are untouched: permission and approval
 * prompts ride the exact same forwarded-event stream for every origin
 * (`API_REMOTE_FORWARDED_EVENTS` `approval/request` -> Gateway Remote event
 * stream -> `REMOTE_EVENT_RESULT_ENDPOINT`), so a steer that is admitted raises
 * the identical prompts in the deep-linked tab.
 *
 * MESH-PUMP SESSIONS. Never eligible. The pump mints deterministic session ids
 * `session-mesh-<task>-a<attempt>` and prompts with request ids
 * `mesh-dispatch-<task>-<attempt>`; either signal marks a session pump-owned,
 * which is sticky for the process lifetime, refuses the opt-in, and revokes an
 * existing one. Prompting into a pump session would race the attempt fence and
 * the question_bridge, which this project must not touch.
 *
 * No ClaudeSession / mesh-pump / mesh-pull-dispatch state is read or written.
 */

import type { ConnectionRpcFailure, ConnectionRpcGuardRequest } from '@deepseek-ai/dsh-client-connection'
import type { DshHostSteerIneligibleReason, DshHostSteerState } from './types.ts'

/** Capability name of the opt-in. */
export const ALLOW_REMOTE_STEER = 'allow-remote-steer'

/** Session-addressed write verbs a non-loopback origin may only use on an opted-in session. */
export const GATED_STEER_ENDPOINTS: ReadonlySet<string> = new Set([
  // DSH 0.1.0-rc.8 API Proxy unary methods (dotted wire names).
  'session.prompt',
  'session.updateQueue',
  'session.cancel',
  'session.selectModel',
  'session.fork',
  'session.rename',
  // Typert-bound spelling used by later DSH lines; harmless where unrouted.
  'session/prompt',
  'session/updateQueue',
  'session/cancel',
  'session/selectModel',
  'session/fork',
  'session/rename',
])

/** Endpoints that submit a prompt (the pump's request id rides the envelope rpcId). */
const PROMPT_ENDPOINTS: ReadonlySet<string> = new Set(['session.prompt', 'session/prompt'])

/** Opt-in setter endpoint: only a loopback (owner) origin may call it. */
export const SET_ALLOW_REMOTE_STEER_ENDPOINT = 'dshHostDirectory/setAllowRemoteSteer'

/**
 * A refused opt-in. rc.8's Typert Gateway folds any thrown Error into the
 * closed `internal` RPC code, so the stable machine-readable code travels as
 * the message prefix (`dsh-host/steer-denied: ...`) and on this error object.
 */
export class SteerDeniedError extends Error {
  readonly code = 'dsh-host/steer-denied' as const
  constructor(message: string, readonly details: Readonly<Record<string, string>>) {
    super(`dsh-host/steer-denied: ${message}`)
    this.name = 'SteerDeniedError'
  }
}

/** Failure code a refused steer carries on the wire. */
export const STEER_DENIED_CODE = 'dsh-host/steer-denied' as const

/** Session id prefix the mesh pump mints for every session it owns. */
const PUMP_SESSION_ID_PREFIX = 'session-mesh-'
/** Prompt request-id prefix the mesh pump stamps on every prompt it sends. */
const PUMP_REQUEST_ID_PREFIX = 'mesh-dispatch-'

/**
 * Whether a `Host` header authority names the local loopback (owner) origin.
 * @param authority - verbatim `Host` header, or undefined when absent.
 * @returns true only for localhost / 127.0.0.0/8 / ::1 with or without a port.
 */
export function isLoopbackAuthority(authority: string | undefined): boolean {
  if (authority === undefined) return false
  let hostname: string
  try {
    hostname = new URL(`http://${authority}`).hostname
  } catch {
    return false
  }
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Pull the addressed session id out of a decoded RPC payload. Two wire shapes
 * exist: the rc.8 API Proxy carries the request object directly
 * (`{ sessionId, ... }`); Typert-bound endpoints wrap it as
 * `{ args: { request: { sessionId, ... } } }`.
 * @param payload - decoded envelope payload.
 * @returns the session id, or undefined when the shape is not recognised (callers fail closed).
 */
export function sessionIdOfPayload(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const args = (payload as { args?: unknown }).args
  let request: unknown = payload
  if (typeof args === 'object' && args !== null) request = (args as { request?: unknown }).request
  if (typeof request !== 'object' || request === null) return undefined
  const sessionId = (request as { sessionId?: unknown }).sessionId
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
}

/** Prompt request id carried by a decoded `session/prompt` payload, if any. */
function requestIdOfPayload(payload: unknown): string | undefined {
  const request = (payload as { args?: { request?: { requestId?: unknown } } } | null | undefined)?.args?.request
  return typeof request?.requestId === 'string' ? request.requestId : undefined
}

function denied(message: string, details: object): ConnectionRpcFailure {
  return { code: STEER_DENIED_CODE, message, details }
}

/** The per-Host, per-session opt-in set and the decision procedure that enforces it. */
export class RemoteSteerGate {
  private readonly optIns = new Set<string>()
  private readonly pumpOwned = new Set<string>()

  /**
   * Why a session may never be opted in, if it may not.
   * @param sessionId - session identity.
   * @returns the reason, or undefined when eligible.
   */
  ineligibleReason(sessionId: string): DshHostSteerIneligibleReason | undefined {
    return this.pumpOwned.has(sessionId) || sessionId.startsWith(PUMP_SESSION_ID_PREFIX) ? 'mesh-pump-owned' : undefined
  }

  /**
   * Record that a user message with this RPC/request id was admitted into a session;
   * a mesh-pump prompt id marks the session pump-owned and revokes any opt-in.
   * @param sessionId - session the message landed in.
   * @param requestId - the message's request id (`source.rpcId`).
   */
  observeRequestId(sessionId: string, requestId: string | undefined): void {
    if (requestId === undefined || !requestId.startsWith(PUMP_REQUEST_ID_PREFIX)) return
    this.pumpOwned.add(sessionId)
    this.optIns.delete(sessionId)
  }

  /**
   * Read one session's effective allow-remote-steer state.
   * @param sessionId - session identity.
   * @returns the state; `allowRemoteSteer` is false for any ineligible or not-opted-in session.
   */
  state(sessionId: string): DshHostSteerState {
    const reason = this.ineligibleReason(sessionId)
    return {
      sessionId,
      allowRemoteSteer: reason === undefined && this.optIns.has(sessionId),
      eligible: reason === undefined,
      ...reason === undefined ? {} : { ineligibleReason: reason },
    }
  }

  /**
   * Grant or revoke the opt-in. Granting a pump-owned session throws.
   * @param sessionId - session identity.
   * @param allow - true to opt in, false to revoke.
   * @returns the resulting state.
   * @throws SteerDeniedError `dsh-host/steer-denied` when the session is pump-owned.
   */
  setAllow(sessionId: string, allow: boolean): DshHostSteerState {
    if (allow) {
      const reason = this.ineligibleReason(sessionId)
      if (reason !== undefined) {
        throw new SteerDeniedError(
          `session "${sessionId}" is ${reason}: ${ALLOW_REMOTE_STEER} is never available for it`,
          { sessionId, reason, capability: ALLOW_REMOTE_STEER },
        )
      }
      this.optIns.add(sessionId)
    } else {
      this.optIns.delete(sessionId)
    }
    return this.state(sessionId)
  }

  /** Session ids currently opted in (effective: never includes ineligible sessions). */
  allowedSessionIds(): string[] {
    return [...this.optIns].filter(id => this.ineligibleReason(id) === undefined)
  }

  /**
   * Pre-dispatch policy for one decoded `/api` request.
   * @param request - endpoint, payload and the origin authority the request arrived on.
   * @returns a refusal, or undefined to let the request proceed to normal dispatch.
   */
  guard(request: Pick<ConnectionRpcGuardRequest, 'endpoint' | 'payload' | 'authority'> & { readonly rpcId?: string }): ConnectionRpcFailure | undefined {
    const { endpoint, payload, authority } = request
    // Stamp pump prompts from ANY origin so a pump session is excluded even
    // when no live session event has been observed yet. rc.8 carries the
    // pump's request id as the envelope rpcId; later lines in the payload.
    if (PROMPT_ENDPOINTS.has(endpoint)) {
      const sessionId = sessionIdOfPayload(payload)
      if (sessionId !== undefined) this.observeRequestId(sessionId, requestIdOfPayload(payload) ?? request.rpcId)
    }
    const setter = endpoint === SET_ALLOW_REMOTE_STEER_ENDPOINT
    if (!setter && !GATED_STEER_ENDPOINTS.has(endpoint)) return undefined
    if (isLoopbackAuthority(authority)) return undefined // the owner's own local UI
    if (setter) {
      return denied(
        `${ALLOW_REMOTE_STEER} can only be granted from this Host's own local origin, never from a remote tab`,
        { endpoint, capability: ALLOW_REMOTE_STEER },
      )
    }
    const sessionId = sessionIdOfPayload(payload)
    if (sessionId === undefined) {
      return denied('remote steer refused: request does not name a session', { endpoint, capability: ALLOW_REMOTE_STEER })
    }
    const state = this.state(sessionId)
    if (state.allowRemoteSteer) return undefined
    if (state.ineligibleReason !== undefined) {
      return denied(
        `This is a mesh-pump-owned session: ${ALLOW_REMOTE_STEER} is never available for it, so it cannot be steered from a remote tab`,
        { endpoint, sessionId, capability: ALLOW_REMOTE_STEER, reason: state.ineligibleReason },
      )
    }
    return denied(
      `This session has not opted in to ${ALLOW_REMOTE_STEER}; open it on its owning machine to steer it, or enable remote steering there first`,
      { endpoint, sessionId, capability: ALLOW_REMOTE_STEER, reason: 'not-opted-in' },
    )
  }
}
