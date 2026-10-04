/**
 * Step 4 (dsh-mesh-session-view): `?session=<id>` deep-link resolution.
 *
 * `parseDeepLinkSession` is the pure URL parser — tested exhaustively here.
 * `resolveDeepLinkSession` wraps it with a consumed flag and replaceState
 * side effect — tested once for the consume contract.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDeepLinkSession, resolveDeepLinkSession } from '../src/client/navigation.ts'

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
