/** Read-only selection receipt for the explicitly opted-in Forage orchestrator. */
interface OrchestratorSessions {
  list: {
    getSnapshot(): {
      current?: string
      ids: readonly string[]
      byId: Readonly<Record<string, { displayTitle: string }>>
      phase: 'pending' | 'ready'
    }
    subscribe(listener: () => void): () => void
  }
}
interface OrchestratorContext { get(name: 'sessions'): OrchestratorSessions | undefined }

/** Parent-facing metadata only; consumers render displayTitle as text, never HTML. */
export interface OrchestratorSelectionReceipt {
  type: 'dsh-orchestrator-session'
  sessionId: string | null
  /** Echo of a validated chooser-load id; null for older or invalid callers. */
  attempt: string | null
  displayTitle?: string
  phase: 'pending' | 'ready'
  reason?: 'no-selection' | 'unsupported-session'
}

const PARENTS = new Set(['https://forage.ink', 'https://n8.forage.ink'])

function parentOriginOf(host: Window): string | undefined {
  const origin = new URLSearchParams(host.location.search).get('orchestrator_parent')
  return host.parent !== host && origin !== null && PARENTS.has(origin) ? origin : undefined
}

/**
 * Reveal the native root chooser before the shell mounts; compact embeds keep
 * their conversation-only projection. This changes no session selection.
 * @param host Browser window requesting the trusted iframe surface.
 */
export function configureOrchestratorSurface(host: Window): void {
  const chooser = host.location.pathname === '/' && parentOriginOf(host) !== undefined
  if (chooser) host.document.documentElement.dataset.dshOrchestratorChooser = 'true'
  else delete host.document.documentElement.dataset.dshOrchestratorChooser
}

function displayTitleOf(title: string | undefined): string | null {
  if (title === undefined) return null
  // Strip control/bidi formatting and bound metadata crossing the frame.
  const text = title.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ').trim()
  return Array.from(text).slice(0, 160).join('') || null
}

/**
 * Report native selection, readiness and bounded display metadata immediately
 * (including no selection), then on changes. No messages or mutation authority
 * cross to the parent; catalog-only children cannot be restored by id.
 * @param ctx Activated client context containing the native session service.
 * @param host Browser window with an explicitly opted-in, trusted parent.
 * @returns Unsubscribe callback owned by the application context effect.
 */
export function connectOrchestratorSelection(ctx: OrchestratorContext, host: Window): () => void {
  const parentOrigin = parentOriginOf(host)
  if (parentOrigin === undefined) return () => {}
  const sessions = ctx.get('sessions')
  if (sessions === undefined) return () => {}
  const requestedAttempt = new URLSearchParams(host.location.search).get('orchestrator_attempt')
  const attempt = requestedAttempt !== null && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(requestedAttempt)
    ? requestedAttempt : null
  let previous: string | undefined
  const publish = (): void => {
    const { current, ids, byId, phase } = sessions.list.getSnapshot()
    const eligible = typeof current === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(current)
      && ids.includes(current)
    const sessionId = phase === 'ready' && eligible ? current : null
    const displayTitle = sessionId === null ? null : displayTitleOf(byId[sessionId]?.displayTitle)
    const receipt: OrchestratorSelectionReceipt = {
      type: 'dsh-orchestrator-session',
      sessionId,
      attempt,
      ...(displayTitle === null ? {} : { displayTitle }),
      phase,
      ...(phase === 'ready' && sessionId === null
        ? { reason: current === undefined ? 'no-selection' as const : 'unsupported-session' as const }
        : {}),
    }
    const signature = JSON.stringify(receipt)
    if (signature === previous) return
    host.parent.postMessage(receipt, parentOrigin)
    previous = signature
  }
  const unsubscribe = sessions.list.subscribe(publish)
  publish()
  return unsubscribe
}
