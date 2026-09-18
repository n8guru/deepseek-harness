import { describe, expect, it, vi } from 'vitest'
import { connectOrchestratorSelection } from '../src/orchestrator-bridge.ts'

function fixture(search = '?orchestrator_parent=https%3A%2F%2Fforage.ink') {
  let current: string | undefined
  let ids: string[] = []
  let notify = (): void => {}
  const dispose = vi.fn()
  const postMessage = vi.fn()
  const sessions = { list: {
    getSnapshot: () => current === undefined ? { ids } : { current, ids },
    subscribe: vi.fn((listener: () => void) => { notify = listener; return dispose }),
  } }
  const host = { location: { search }, parent: { postMessage } } as unknown as Window
  return { host, postMessage, dispose, sessions, select: (id?: string, listed = true) => {
    current = id
    ids = id !== undefined && listed ? [id] : []
    notify()
  } }
}

describe('Forage orchestrator selection receipt', () => {
  it('waits for restored selection, reports native changes once, and unsubscribes', () => {
    const f = fixture()
    const stop = connectOrchestratorSelection({ get: () => f.sessions }, f.host)
    expect(f.postMessage).not.toHaveBeenCalled()
    f.select('orchestrator')
    f.select('orchestrator')
    f.select(undefined)
    f.select('next')
    expect(f.postMessage.mock.calls).toEqual([
      [{ type: 'dsh-orchestrator-session', sessionId: 'orchestrator' }, 'https://forage.ink'],
      [{ type: 'dsh-orchestrator-session', sessionId: null }, 'https://forage.ink'],
      [{ type: 'dsh-orchestrator-session', sessionId: 'next' }, 'https://forage.ink'],
    ])
    stop()
    expect(f.dispose).toHaveBeenCalledOnce()
  })

  it('reports an already restored selection immediately', () => {
    const f = fixture()
    f.select('restored')
    connectOrchestratorSelection({ get: () => f.sessions }, f.host)
    expect(f.postMessage).toHaveBeenCalledWith(
      { type: 'dsh-orchestrator-session', sessionId: 'restored' }, 'https://forage.ink')
  })

  it.each(['', '?orchestrator_parent=https://evil.test', '?orchestrator_parent=https://forage.ink/path',
    '?orchestrator_parent=https://user:pass@forage.ink'])('rejects absent or untrusted opt-in %s', (search) => {
    const f = fixture(search)
    connectOrchestratorSelection({ get: () => f.sessions }, f.host)
    expect(f.sessions.list.subscribe).not.toHaveBeenCalled()
    f.select('private-id')
    expect(f.postMessage).not.toHaveBeenCalled()
  })

  it('does not publish from a top-level window', () => {
    const f = fixture()
    Object.defineProperty(f.host, 'parent', { value: f.host })
    connectOrchestratorSelection({ get: () => f.sessions }, f.host)
    expect(f.sessions.list.subscribe).not.toHaveBeenCalled()
  })

  it('invalidates a candidate when selecting a catalog-only child', () => {
    const f = fixture()
    connectOrchestratorSelection({ get: () => f.sessions }, f.host)
    f.select('parent')
    f.select('catalog-child', false)
    expect(f.postMessage).toHaveBeenLastCalledWith(
      { type: 'dsh-orchestrator-session', sessionId: null }, 'https://forage.ink')
  })

  it('does not publish invalid ids or require session creation', () => {
    const f = fixture()
    connectOrchestratorSelection({ get: () => f.sessions }, f.host)
    for (const id of ['', 'https://evil.test', 'bad?id', 'x'.repeat(129)]) f.select(id)
    expect(f.postMessage).not.toHaveBeenCalled()
    expect(() => connectOrchestratorSelection({ get: () => undefined }, f.host)).not.toThrow()
  })
})
