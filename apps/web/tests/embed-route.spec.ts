import { describe, expect, it, vi } from 'vitest'
import { initializeEmbedSession, parseEmbedContext, projectEmbedBootGraph } from '../src/embed.ts'

describe('compact embed route', () => {
  it('plumbs the stable context query parameters', () => {
    expect(parseEmbedContext({
      pathname: '/embed',
      search: '?slug=x&title=y&url=https%3A%2F%2Fexample.test%2Fp&session=s',
    } as Location)).toEqual({ slug: 'x', title: 'y', url: 'https://example.test/p', session: 's' })
    expect(parseEmbedContext({ pathname: '/', search: '?slug=x' } as Location)).toBeUndefined()
  })

  it('forces new embed sessions through page-curator with focused context', async () => {
    const create = vi.fn(async () => 'curator-session')
    const open = vi.fn()
    const postMessage = vi.fn()
    vi.stubGlobal('window', { parent: { postMessage } })
    await initializeEmbedSession({ get: () => ({ create, open, refresh: vi.fn(async () => {}) }) }, {
      slug: 'forage', title: 'Studio', url: 'https://forage.ink/studio', excerpt: 'Focused excerpt',
    })
    expect(create).toHaveBeenCalledWith({
      agentPreset: 'page-curator',
      focusedContext: { slug: 'forage', title: 'Studio', url: 'https://forage.ink/studio', excerpt: 'Focused excerpt' },
    })
    expect(open).toHaveBeenCalledWith('curator-session')
    expect(postMessage).toHaveBeenCalledWith({ type: 'dsh-embed-session', sessionId: 'curator-session' }, '*')
    vi.unstubAllGlobals()
  })

  it('mints a new page-curator session instead of resuming a stale drawer id', async () => {
    const create = vi.fn(async () => 'fresh-curator')
    const open = vi.fn()
    const postMessage = vi.fn()
    vi.stubGlobal('window', { parent: { postMessage } })
    await initializeEmbedSession({ get: () => ({ create, open, refresh: vi.fn(async () => {}) }) }, {
      session: 'existing', slug: 'forage', title: 'Forage', url: 'https://n8.forage.ink/#feed',
    })
    expect(create).toHaveBeenCalledWith({
      agentPreset: 'page-curator',
      focusedContext: { slug: 'forage', title: 'Forage', url: 'https://n8.forage.ink/#feed' },
    })
    expect(open).toHaveBeenCalledWith('fresh-curator')
    expect(postMessage).toHaveBeenCalledWith({ type: 'dsh-embed-session', sessionId: 'fresh-curator' }, '*')
    vi.unstubAllGlobals()
  })

  it('resumes a session-only embed without minting another', async () => {
    const create = vi.fn()
    const open = vi.fn()
    await initializeEmbedSession({ get: () => ({ create, open, refresh: vi.fn(async () => {}) }) }, { session: 'existing' })
    expect(create).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith('existing')
  })

  it('waits for the Host list before selecting the requested session', async () => {
    let resolveList!: () => void
    const refresh = vi.fn(() => new Promise<void>((resolve) => { resolveList = resolve }))
    const create = vi.fn()
    const open = vi.fn()
    const pending = initializeEmbedSession({ get: () => ({ create, open, refresh }) }, { session: 'pump-attempt' })
    expect(refresh).toHaveBeenCalledOnce()
    expect(open).not.toHaveBeenCalled()
    resolveList()
    await pending
    expect(open).toHaveBeenCalledWith('pump-attempt')
    expect(create).not.toHaveBeenCalled()
  })

  it('does not create or select when the Host list fails', async () => {
    const refresh = vi.fn(async () => { throw new Error('Host unreachable') })
    const create = vi.fn()
    const open = vi.fn()
    await expect(initializeEmbedSession({ get: () => ({ create, open, refresh }) }, { session: 'existing' }))
      .rejects.toThrow('Host unreachable')
    expect(open).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('keeps the conversation surface and drops sidebar/settings plugins', () => {
    const graph = projectEmbedBootGraph({ rev: 'r1', entries: [
      { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime', rev: '1' },
      { id: '@deepseek-ai/dsh-client-ui-renderer', url: '/renderer', rev: '1', inject: ['@deepseek-ai/dsh-client-runtime'] },
      { id: '@deepseek-ai/dsh-client-ui-conversation', url: '/conversation', rev: '1' },
      { id: '@deepseek-ai/dsh-client-ui-user-questions', url: '/questions', rev: '1' },
      { id: '@deepseek-ai/dsh-client-ui-sidebar', url: '/sidebar', rev: '1' },
      { id: '@deepseek-ai/dsh-client-ui-settings', url: '/settings', rev: '1' },
    ] }) as { rev: string; entries: Array<{ id: string }> }
    expect(graph.rev).toBe('r1:embed')
    expect(graph.entries.map(row => row.id)).toEqual([
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-user-questions',
    ])
  })
})
