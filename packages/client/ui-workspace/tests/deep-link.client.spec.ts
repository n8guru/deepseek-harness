/**
 * Step 4 (dsh-mesh-session-view): `?session=<id>` deep-link resolution.
 *
 * `parseDeepLinkSession` is the pure URL parser — tested exhaustively here.
 * `resolveDeepLinkSession` wraps it with a consumed flag and replaceState
 * side effect — tested once for the consume contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { openDeepLinkWhenReady, parseDeepLinkSession, resolveDeepLinkSession } from '../src/client/navigation.ts'

describe('parseDeepLinkSession', () => {
  it('returns the session id from a URL with ?session=<id>', () => {
    expect(parseDeepLinkSession('http://127.0.0.1:3080/?session=test-123')).toBe('test-123')
  })

  it('returns undefined when no session parameter is present', () => {
    expect(parseDeepLinkSession('http://127.0.0.1:3080/')).toBeUndefined()
  })

  it('returns undefined when session parameter is empty', () => {
    expect(parseDeepLinkSession('http://127.0.0.1:3080/?session=')).toBeUndefined()
  })

  it('handles a session id with encoded characters', () => {
    expect(parseDeepLinkSession('http://127.0.0.1:3080/?session=a%2Fb')).toBe('a/b')
  })

  it('preserves other query parameters (they are not its concern)', () => {
    expect(parseDeepLinkSession('http://127.0.0.1:3080/?foo=bar&session=s1&baz=qux')).toBe('s1')
  })

  it('returns undefined for an invalid URL', () => {
    expect(parseDeepLinkSession('not a url')).toBeUndefined()
  })

  it('works with https and non-default ports', () => {
    expect(parseDeepLinkSession('https://forge.ts.net:3080/?session=s-42')).toBe('s-42')
  })
})

describe('resolveDeepLinkSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the session id on first call and undefined on subsequent calls (consumed once per load)', () => {
    const states: Array<{ url: string }> = []
    vi.stubGlobal('location', { href: 'http://127.0.0.1:3080/?session=deep-s1' })
    vi.stubGlobal('history', {
      state: null,
      replaceState: (_s: unknown, _t: string, url: string) => { states.push({ url }) },
    })

    // First call returns the session id and removes the param via replaceState.
    const first = resolveDeepLinkSession()
    expect(first).toBe('deep-s1')
    expect(states).toHaveLength(1)
    expect(new URL(states[0]!.url).searchParams.has('session')).toBe(false)

    // Second call returns undefined (consumed once per page load).
    const second = resolveDeepLinkSession()
    expect(second).toBeUndefined()
  })
})

describe('openDeepLinkWhenReady', () => {
  function sessionsBench(initial: Partial<SessionListState>) {
    let state = { ids: [], byId: {}, phase: 'pending', ...initial } as unknown as SessionListState
    const listeners = new Set<() => void>()
    const open = vi.fn()
    return {
      open,
      sessions: {
        list: {
          getSnapshot: () => state,
          subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
        },
        open,
      },
      set: (next: Partial<SessionListState>) => {
        state = { ...state, ...next }
        for (const listener of [...listeners]) listener()
      },
      listenerCount: () => listeners.size,
    }
  }
  const id = 'deep-s1' as SessionId

  it('is a no-op without a deep link', () => {
    const b = sessionsBench({ phase: 'ready' })
    openDeepLinkWhenReady(b.sessions, undefined)
    expect(b.open).not.toHaveBeenCalled()
    expect(b.listenerCount()).toBe(0)
  })

  it('waits for the list to be ready, then opens the listed session once', () => {
    const b = sessionsBench({})
    openDeepLinkWhenReady(b.sessions, id)
    expect(b.open).not.toHaveBeenCalled()
    b.set({ phase: 'ready', byId: { [id]: {} } as never })
    expect(b.open).toHaveBeenCalledExactlyOnceWith(id)
    b.set({})
    expect(b.open).toHaveBeenCalledOnce()
    expect(b.listenerCount()).toBe(0)
  })

  it('ignores a session id the Host does not list (stale link)', () => {
    const b = sessionsBench({ phase: 'ready' })
    openDeepLinkWhenReady(b.sessions, id)
    expect(b.open).not.toHaveBeenCalled()
    expect(b.listenerCount()).toBe(0)
  })

  it('the disposer cancels a pending wait', () => {
    const b = sessionsBench({})
    const dispose = openDeepLinkWhenReady(b.sessions, id)
    dispose()
    b.set({ phase: 'ready', byId: { [id]: {} } as never })
    expect(b.open).not.toHaveBeenCalled()
  })
})
