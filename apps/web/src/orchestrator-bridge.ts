/** Read-only selection receipt for the explicitly opted-in Forage orchestrator. */
interface OrchestratorSessions {
  list: {
    getSnapshot(): { current?: string; ids: readonly string[] }
    subscribe(listener: () => void): () => void
  }
}
interface OrchestratorContext { get(name: 'sessions'): OrchestratorSessions | undefined }

const PARENTS = new Set(['https://forage.ink', 'https://n8.forage.ink'])

/**
 * Persist the native picker's chosen id in its owning Forage parent, without
 * sharing messages, credentials, page context, or any mutation authority.
 * @param ctx Activated client context containing the native session service.
 * @param host Browser window with an explicitly opted-in, trusted parent.
 * @returns Unsubscribe callback owned by the application context effect.
 */
export function connectOrchestratorSelection(ctx: OrchestratorContext, host: Window): () => void {
  const parentOrigin = new URLSearchParams(host.location.search).get('orchestrator_parent')
  if (host.parent === host || parentOrigin === null || !PARENTS.has(parentOrigin)) return () => {}
  const sessions = ctx.get('sessions')
  if (sessions === undefined) return () => {}
  let previous: string | null = null
  const publish = (): void => {
    const { current, ids } = sessions.list.getSnapshot()
    // Catalog-only children need an address; the id-only embed cannot restore them.
    const id = typeof current === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(current)
      && ids.includes(current) ? current : null
    if (id === previous) return
    host.parent.postMessage({ type: 'dsh-orchestrator-session', sessionId: id }, parentOrigin)
    previous = id
  }
  const unsubscribe = sessions.list.subscribe(publish)
  publish()
  return unsubscribe
}
