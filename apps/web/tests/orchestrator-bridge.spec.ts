import { describe, expect, it, vi } from 'vitest'
import type { OrchestratorSelectionReceipt } from '../src/orchestrator-bridge.ts'
import { configureOrchestratorSurface, connectOrchestratorSelection } from '../src/orchestrator-bridge.ts'

function fixture(search = '?orchestrator_parent=https%3A%2F%2Fforage.ink&orchestrator_attempt=1', pathname = '/') {
  let current: string | undefined
  let ids: string[] = []
  let phase: 'pending' | 'ready' = 'pending'
  let byId: Record<string, { displayTitle: string }> = {}
  let notify = (): void => {}
  const dispose = vi.fn(() => { notify = () => {} })
  const postMessage = vi.fn<(receipt: OrchestratorSelectionReceipt, targetOrigin: string) => void>()
  const dataset: Record<string, string> = {}
  const sessions = { list: {
    getSnapshot: () => ({ ...(current === undefined ? {} : { current }), ids, phase, byId }),
    subscribe: vi.fn((listener: () => void) => { notify = listener; return dispose }),
  } }
  const host = { location: { search, pathname }, document: { documentElement: { dataset } },
    parent: { postMessage } } as unknown as Window
  return { host, postMessage, dispose, sessions, dataset,
    phase: (next: 'pending' | 'ready') => { phase = next; notify() },
    select: (id?: string, listed = true, title = 'Native chat') => {
      current = id
      ids = id !== undefined && listed ? [id] : []
      byId = id === undefined ? {} : { [id]: { displayTitle: title } }
      notify()
    },
  }
}

describe('Forage orchestrator surface', () => {
  it.each(['https://forage.ink', 'https://n8.forage.ink'])('opts in trusted root iframe %s before mount', (origin) => {
    const f = fixture('?orchestrator_parent=' + encodeURIComponent(origin))
    configureOrchestratorSurface(f.host)
    expect(f.dataset.dshOrchestratorChooser).toBe('true')
    expect(f.sessions.list.subscribe).not.toHaveBeenCalled()
    expect(f.postMessage).not.toHaveBeenCalled()
  })

  it.each(['', '?orchestrator_parent=https://evil.test', '?orchestrator_parent=https://forage.ink/path',
    '?orchestrator_parent=https://user:pass@forage.ink'])('rejects absent or untrusted opt-in %s', (search) => {
    const f = fixture(search)
    f.dataset.dshOrchestratorChooser = 'true'
    configureOrchestratorSurface(f.host)
    connectOrchestratorSelection({ get: () => f.sessions }, f.host)
    expect(f.dataset.dshOrchestratorChooser).toBeUndefined()
    expect(f.sessions.list.subscribe).not.toHaveBeenCalled()
    f.select('private-id')
    expect(f.postMessage).not.toHaveBeenCalled()
  })

  it.each(['/embed', '/embed/', '/other'])('does not change non-root layout %s', (path) => {
    const f = fixture(undefined, path)
    configureOrchestratorSurface(f.host)
    expect(f.dataset.dshOrchestratorChooser).toBeUndefined()
  })

  it('does not opt in or publish from a top-level window', () => {
    const f = fixture()
    Object.defineProperty(f.host, 'parent', { value: f.host })
    configureOrchestratorSurface(f.host)
    connectOrchestratorSelection({ get: () => f.sessions }, f.host)
    expect(f.dataset.dshOrchestratorChooser).toBeUndefined()
    expect(f.sessions.list.subscribe).not.toHaveBeenCalled()
  })
})

describe('Forage orchestrator selection receipt', () => {
  it.each(['', '&orchestrator_attempt=', '&orchestrator_attempt=bad%3Fid', '&orchestrator_attempt=' + 'x'.repeat(129)])(
    'echoes null for absent or invalid attempt without denying older parents: %s', (suffix) => {
      const f = fixture('?orchestrator_parent=https%3A%2F%2Fforage.ink' + suffix)
      connectOrchestratorSelection({ get: () => f.sessions }, f.host)
      expect(f.postMessage.mock.lastCall?.[0]).toEqual({
        type: 'dsh-orchestrator-session', sessionId: null, attempt: null, phase: 'pending',
      })
      f.phase('ready')
      expect(f.postMessage.mock.lastCall?.[0].attempt).toBeNull()
    })

  it('captures each load attempt so a late receipt cannot claim the retry id', () => {
    const f = fixture()
    connectOrchestratorSelection({ get: () => f.sessions }, f.host)
    // Model the stable WindowProxy URL after a retry; the old subscription
    // must keep the token it captured instead of rereading the current URL.
    f.host.location.search = '?orchestrator_parent=https%3A%2F%2Fforage.ink&orchestrator_attempt=2'
    f.phase('ready')
    expect(f.postMessage.mock.lastCall?.[0].attempt).toBe('1')
    connectOrchestratorSelection({ get: () => f.sessions }, f.host)
    expect(f.postMessage.mock.lastCall?.[0].attempt).toBe('2')
  })

  it('reports initial loading, ready-empty, selection and clearing, then unsubscribes', () => {
    const f = fixture()
    const stop = connectOrchestratorSelection({ get: () => f.sessions }, f.host)
    f.phase('ready')
    f.select('orchestrator')
    f.select('orchestrator')
    f.select(undefined)
    expect(f.postMessage.mock.calls).toEqual([
      [{ type: 'dsh-orchestrator-session', attempt: '1', sessionId: null, phase: 'pending' }, 'https://forage.ink'],
      [{ type: 'dsh-orchestrator-session', attempt: '1', sessionId: null, phase: 'ready', reason: 'no-selection' }, 'https://forage.ink'],
      [{ type: 'dsh-orchestrator-session', attempt: '1', sessionId: 'orchestrator', displayTitle: 'Native chat', phase: 'ready' }, 'https://forage.ink'],
      [{ type: 'dsh-orchestrator-session', attempt: '1', sessionId: null, phase: 'ready', reason: 'no-selection' }, 'https://forage.ink'],
    ])
    stop()
    f.select('later')
    expect(f.postMessage).toHaveBeenCalledTimes(4)
    expect(f.dispose).toHaveBeenCalledOnce()
  })

  it('reports an already restored selection immediately and updates its title', () => {
    const f = fixture()
    f.phase('ready')
    f.select('restored')
    connectOrchestratorSelection({ get: () => f.sessions }, f.host)
    f.select('restored', true, 'Renamed')
    expect(f.postMessage).toHaveBeenCalledTimes(2)
    expect(f.postMessage).toHaveBeenLastCalledWith(
      { type: 'dsh-orchestrator-session', attempt: '1', sessionId: 'restored', displayTitle: 'Renamed', phase: 'ready' }, 'https://forage.ink')
  })

  it('does not offer a selected id until catalog readiness', () => {
    const f = fixture()
    f.select('restored')
    connectOrchestratorSelection({ get: () => f.sessions }, f.host)
    expect(f.postMessage.mock.calls[0]?.[0]).toMatchObject({ sessionId: null, phase: 'pending' })
    f.phase('ready')
    expect(f.postMessage.mock.lastCall?.[0]).toMatchObject({ sessionId: 'restored', phase: 'ready' })
  })

  it('invalidates a candidate and withholds title for catalog-only children', () => {
    const f = fixture()
    f.phase('ready')
    f.select('parent')
    connectOrchestratorSelection({ get: () => f.sessions }, f.host)
    f.select('catalog-child', false, 'Hidden child title')
    expect(f.postMessage).toHaveBeenLastCalledWith(
      { type: 'dsh-orchestrator-session', attempt: '1', sessionId: null, phase: 'ready', reason: 'unsupported-session' }, 'https://forage.ink')
  })

  it('rejects invalid ids without creation or other session methods', () => {
    const f = fixture()
    f.phase('ready')
    connectOrchestratorSelection({ get: () => f.sessions }, f.host)
    for (const id of ['', 'https://evil.test', 'bad?id', 'x'.repeat(129)]) f.select(id)
    expect(f.postMessage.mock.calls.every(([message]) => message.sessionId === null && message.displayTitle === undefined)).toBe(true)
    expect(f.postMessage.mock.lastCall?.[0].reason).toBe('unsupported-session')
    expect(() => connectOrchestratorSelection({ get: () => undefined }, f.host)).not.toThrow()
  })

  it('bounds plain-text title metadata and strips controls and bidi formatting', () => {
    const f = fixture()
    f.phase('ready')
    f.select('chat', true, '  Hello\n\u202e world  ')
    connectOrchestratorSelection({ get: () => f.sessions }, f.host)
    expect(f.postMessage.mock.lastCall?.[0].displayTitle).toBe('Hello world')
    f.select('chat', true, '🙂'.repeat(200))
    expect(f.postMessage.mock.lastCall?.[0].displayTitle).toBe('🙂'.repeat(160))
    f.select('chat', true, '\n\u202e ')
    expect(f.postMessage.mock.lastCall?.[0].displayTitle).toBeUndefined()
  })
})
