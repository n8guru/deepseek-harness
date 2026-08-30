/** Compact embed-surface routing and boot-graph projection. */

export interface EmbedContext {
  slug?: string
  title?: string
  url?: string
  session?: string
  excerpt?: string
}

interface BootEntry {
  id: string
  inject?: string[]
  external?: string[]
}

interface BootGraph {
  rev: string
  entries: BootEntry[]
}

/** Browser globals published for embed-aware client plugins. */
declare global {
  interface Window {
    __DSH_EMBED__?: EmbedContext
    __DSH_BOOT__?: unknown
  }
}

const EMBED_UI = new Set([
  '@deepseek-ai/dsh-client-ui-theme',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-brand-official',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-jobs',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-plan',
  '@deepseek-ai/dsh-client-ui-user-questions',
])

const NON_UI = (id: string): boolean => !id.startsWith('@deepseek-ai/dsh-client-ui-')

/** Parse the stable query-parameter intake for `/embed`. */
export function parseEmbedContext(location: Pick<Location, 'pathname' | 'search'>): EmbedContext | undefined {
  if (location.pathname !== '/embed' && location.pathname !== '/embed/') return undefined
  const query = new URLSearchParams(location.search)
  const context: EmbedContext = {}
  for (const key of ['slug', 'title', 'url', 'session', 'excerpt'] as const) {
    const value = query.get(key)
    if (value !== null && value !== '') context[key] = value
  }
  return context
}

/**
 * Keep host-composed graph rows, but project the embed surface to its compact
 * conversation roster plus every declared transitive dependency.
 */
export function projectEmbedBootGraph(wire: unknown): unknown {
  if (typeof wire !== 'object' || wire === null) return wire
  const graph = wire as BootGraph
  if (!Array.isArray(graph.entries)) return wire
  const byId = new Map(graph.entries.map(row => [row.id, row]))
  const keep = new Set(graph.entries.filter(row => NON_UI(row.id) || EMBED_UI.has(row.id)).map(row => row.id))
  const visit = (id: string): void => {
    if (keep.has(id)) return
    const row = byId.get(id)
    if (row === undefined) return
    keep.add(id)
    for (const dependency of [...(row.inject ?? []), ...(row.external ?? [])]) visit(dependency.replace(/\/client$/, ''))
  }
  for (const id of [...keep]) {
    const row = byId.get(id)
    for (const dependency of [...(row?.inject ?? []), ...(row?.external ?? [])]) visit(dependency.replace(/\/client$/, ''))
  }
  return { ...graph, rev: `${graph.rev}:embed`, entries: graph.entries.filter(row => keep.has(row.id)) }
}

/** Publish embed context and project the already host-injected graph in-place. */
export function configureEmbedSurface(win: Window): EmbedContext | undefined {
  const context = parseEmbedContext(win.location)
  if (context === undefined) return undefined
  win.__DSH_EMBED__ = context
  win.document.documentElement.dataset.dshSurface = 'embed'
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) win.document.documentElement.dataset[`dshEmbed${key.charAt(0).toUpperCase()}${key.slice(1)}`] = value
  }
  win.__DSH_BOOT__ = projectEmbedBootGraph(win.__DSH_BOOT__)
  return context
}


interface EmbedSessions {
  create(opts: { agentPreset: string; focusedContext: { slug: string; title?: string; url: string; excerpt?: string } }): Promise<string>
  open(sessionId: string): void
}
interface EmbedClientContext { get(name: 'sessions'): EmbedSessions | undefined }

/** Force the compact surface onto the page-curator session boundary before UI mount. */
export async function initializeEmbedSession(ctx: EmbedClientContext, context?: EmbedContext): Promise<void> {
  if (context === undefined) return
  const sessions = ctx.get('sessions')
  if (sessions === undefined) throw new Error('embed: sessions service unavailable')
  if (context.session !== undefined) {
    sessions.open(context.session)
    return
  }
  if (context.slug === undefined || context.url === undefined) throw new Error('embed: slug and url are required')
  const sessionId = await sessions.create({
    agentPreset: 'page-curator',
    focusedContext: {
      slug: context.slug, url: context.url,
      ...(context.title === undefined ? {} : { title: context.title }),
      ...(context.excerpt === undefined ? {} : { excerpt: context.excerpt }),
    },
  })
  sessions.open(sessionId)
  window.parent.postMessage({ type: 'dsh-embed-session', sessionId }, '*')
}
