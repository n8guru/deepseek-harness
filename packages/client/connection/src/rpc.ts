/** Generic unary RPC contracts shared by the Host and Client Connection halves. */

import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'

/** Trust fence applied before a Host RPC channel reaches its handler. */
export type ConnectionRpcAuthority = 'trusted-host' | 'loopback'

/** Registration policy for one logical RPC channel. */
export interface ConnectionRpcHandlerOptions {
  /** Browser authority accepted by every endpoint in this channel. */
  readonly authority: ConnectionRpcAuthority
}

/** Handler invoked after Connection has decoded the transport envelope. */
export type ConnectionRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<RpcResult<unknown>>

/** Carrier-neutral refusal produced by a pre-dispatch guard. */
export interface ConnectionRpcFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

/**
 * Request facts handed to a pre-dispatch guard. `authority` is the verbatim
 * `Host` header the admitted request arrived on (the origin the browser tab
 * is served from), so a guard can tell a loopback owner tab from a tab opened
 * at the Host's tailnet origin. `rpcId` is the envelope's correlation id.
 */
export interface ConnectionRpcGuardRequest {
  readonly endpoint: string
  readonly rpcId: string
  readonly payload: unknown
  readonly authority: string | undefined
  readonly headers: Headers
}

/**
 * Pre-dispatch veto for one decoded `/api` RPC (interceptor-claimed OR
 * API Proxy fallback). Returns a failure to refuse the call (it becomes the
 * response's error result; no handler runs), or `undefined` to let it proceed.
 * Guards add policy only; they never grant.
 */
export type ConnectionRpcGuard = (
  request: ConnectionRpcGuardRequest,
) => ConnectionRpcFailure | undefined | Promise<ConnectionRpcFailure | undefined>

/** Synchronous ownership test for one endpoint on a shared RPC channel. */
export type ConnectionRpcEndpointMatcher = (endpoint: string) => boolean

/** Host registry for logical RPC channels carried by the current transport. */
export interface HostConnectionRpc {
  /**
   * Register one absolute channel prefix and its trust policy.
   * @param channel - absolute logical channel such as `/rpc`.
   * @param handler - decoded endpoint handler returning the existing RPC result shape.
   * @param options - channel trust policy.
   * @returns asynchronous disposer removing the channel and its physical route.
   */
  handle(
    channel: string,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void>

  /**
   * Intercept owned endpoints on the shared `/api` channel before its fallback.
   * @param channel - reserved shared channel; currently `/api`.
   * @param matches - synchronous endpoint ownership test.
   * @param handler - decoded endpoint handler returning the existing RPC result shape.
   * @param options - trust policy for every endpoint claimed by this interceptor.
   * @returns asynchronous disposer removing the interceptor.
   */
  intercept(
    channel: '/api',
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
    options: ConnectionRpcHandlerOptions,
  ): () => Promise<void>

  /**
   * Register a pre-dispatch guard on the shared `/api` channel. Every guard runs
   * (in registration order) after the envelope is decoded and before the
   * interceptor or API Proxy fallback; the first refusal ends the call.
   * @param channel - reserved shared channel; currently `/api`.
   * @param guard - policy veto, see {@link ConnectionRpcGuard}.
   * @returns asynchronous disposer removing the guard.
   */
  guard(channel: '/api', guard: ConnectionRpcGuard): () => Promise<void>
}

/** Host `ctx.connection` shape consumed by transport-independent adapters. */
export interface HostConnectionHandle {
  /** Generic RPC channel registry. */
  readonly rpc: HostConnectionRpc
}

/** Client caller for logical RPC channels carried by the current transport. */
export interface ClientConnectionRpc {
  /**
   * Call one endpoint through an already registered logical channel.
   * @param channel - absolute logical channel such as `/api`.
   * @param endpoint - channel-relative endpoint such as `goals/create`.
   * @param payload - channel-owned request payload.
   * @param signal - optional caller cancellation.
   * @returns the existing RPC success/error result; correlation stays inside Connection.
   */
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<RpcResult<unknown>>
}
