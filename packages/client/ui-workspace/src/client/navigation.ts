/**
 * Peer-origin deep-link receiver (dsh-mesh-session-view step 4). Clicking a
 * peer Host's session row opens `<scheme>://<authority>/?session=<id>` in a
 * new tab; that Host's own browser app reads the parameter here and selects
 * the exact session once its list has loaded.
 */
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Parse the `?session=<id>` query parameter from an href string.
 * Pure: no side effects, no consumed flag.
 * @param href - absolute URL string.
 * @returns the session id, or undefined for an invalid URL / absent / empty parameter.
 */
export function parseDeepLinkSession(href: string): SessionId | undefined {
  let url: URL
  try { url = new URL(href) } catch { return undefined }
  const sessionId = url.searchParams.get('session')
  if (sessionId === null || sessionId === '') return undefined
  return sessionId as SessionId
}

let deepLinkConsumed = false

/**
 * Read and consume the `?session=<id>` parameter of the current URL. Returns
 * the id exactly once per page load; the parameter is removed through
 * `replaceState` so a manual reload does not re-navigate.
 * @returns the deep-linked session id, once.
 */
export function resolveDeepLinkSession(): SessionId | undefined {
  if (deepLinkConsumed) return undefined
  deepLinkConsumed = true
  if (typeof globalThis.location === 'undefined') return undefined
  const parsed = parseDeepLinkSession(globalThis.location.href)
  if (parsed === undefined) return undefined
  const url = new URL(globalThis.location.href)
  url.searchParams.delete('session')
  try { globalThis.history.replaceState(globalThis.history.state, '', url.toString()) } catch { /* no history API (non-browser) */ }
  return parsed
}

/** Minimal list face the receiver needs (ISessions.list + open). */
export interface DeepLinkSessions {
  readonly list: {
    getSnapshot: () => SessionListState
    subscribe: (listener: () => void) => () => void
  }
  open: (id: SessionId) => void
}

/**
 * Open the deep-linked session once the Session list is ready. An id the Host
 * does not list (stale link, deleted session) is ignored: normal boot
 * selection stays in force.
 * @param sessions - the sessions service face.
 * @param id - deep-linked session id, if any.
 * @returns disposer for the pending wait.
 */
export function openDeepLinkWhenReady(sessions: DeepLinkSessions, id: SessionId | undefined): () => void {
  if (id === undefined) return () => {}
  let dispose = () => {}
  let settled = false
  const attempt = (): void => {
    if (settled) return
    const snapshot = sessions.list.getSnapshot()
    if (snapshot.phase !== 'ready') return
    settled = true
    dispose()
    if (snapshot.byId[id] !== undefined) sessions.open(id)
  }
  dispose = sessions.list.subscribe(attempt)
  attempt()
  return () => { settled = true; dispose() }
}
