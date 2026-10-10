/**
 * Step 4 (dsh-mesh-session-view): peer-machine group derivation and
 * deep-link URL construction from the dshHostDirectory snapshot.
 */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { DshHostRemoteSession, DshHostPeerView } from '@deepseek-ai/dsh-host-directory/types'
import {
  derivePeerGroups,
  peerSessionUrl,
  remoteSessionNode,
} from '../src/client/tree.ts'

const sid = (id: string) => id as SessionId

const remoteSession = (
  sessionId: string,
  machine: string,
  updatedAt: number,
  overrides: Partial<DshHostRemoteSession> = {},
): DshHostRemoteSession => ({
  sessionId: sid(sessionId),
  machine,
  updatedAt,
  running: false,
  blank: false,
  ...overrides,
})

const peer = (
  machine: string,
  authority: string,
  state: 'ok' | 'unreachable' | 'never-polled' = 'ok',
): DshHostPeerView => ({
  machine,
  authority,
  scheme: 'http',
  status: state === 'ok'
    ? { state: 'ok', lastPolledAt: Date.now(), sessionCount: 0 }
    : state === 'unreachable'
      ? { state: 'unreachable', lastAttemptAt: Date.now(), message: 'timeout' }
      : { state: 'never-polled' },
})

describe('remoteSessionNode', () => {
  it('builds a SessionNode with machine and peerScheme from a DshHostRemoteSession', () => {
    const session = remoteSession('s1', 'forge', 1000, { running: true })
    const node = remoteSessionNode(session, 'https')
    expect(node.id).toBe('s1')
    expect(node.machine).toBe('forge')
    expect(node.peerScheme).toBe('https')
    expect(node.running).toBe(true)
    expect(node.blank).toBe(false)
    expect(node.updatedAt).toBe(1000)
    // Remote sessions carry no local state.
    expect(node.runningSubagentCount).toBe(0)
    expect(node.completed).toBe(false)
  })

  it('carries a pending interaction when the remote session has pendingInput', () => {
    const node = remoteSessionNode(
      remoteSession('s2', 'n8razer', 2000),
      'http',
      'question',
    )
    expect(node.pendingInteraction).toBe('question')
  })

  it('omits pendingInteraction when no pendingInput is classified', () => {
    const node = remoteSessionNode(remoteSession('s3', 'n8razer', 3000), 'http')
    expect(node.pendingInteraction).toBeUndefined()
  })
})

describe('derivePeerGroups', () => {
  it('returns an empty array when no peers are configured', () => {
    const groups = derivePeerGroups([], [], new Set())
    expect(groups).toEqual([])
  })

  it('groups remote sessions by peer authority in configured peer order', () => {
    const sessions: DshHostRemoteSession[] = [
      remoteSession('s1', 'forge', 100),
      remoteSession('s2', 'forge', 200),
      remoteSession('s3', 'n8razer', 300),
    ]
    const peers: DshHostPeerView[] = [
      peer('n8razer', 'n8razer.local:3080'),
      peer('forge', 'forge.ts.net:3080'),
    ]
    const groups = derivePeerGroups(sessions, peers, new Set(['n8razer.local:3080', 'forge.ts.net:3080']))

    expect(groups).toHaveLength(2)
    // Peer order follows the configured order (n8razer first, forge second).
    expect(groups[0]!.machine).toBe('n8razer')
    expect(groups[0]!.key).toBe('n8razer.local:3080')
    expect(groups[0]!.sessionCount).toBe(1)
    expect(groups[0]!.sessions).toHaveLength(1)
    expect(groups[0]!.sessions[0]!.id).toBe('s3')

    expect(groups[1]!.machine).toBe('forge')
    expect(groups[1]!.key).toBe('forge.ts.net:3080')
    expect(groups[1]!.sessionCount).toBe(2)
    expect(groups[1]!.sessions).toHaveLength(2)
    // Sessions sorted newest-first within the group.
    expect(groups[1]!.sessions[0]!.id).toBe('s2')
    expect(groups[1]!.sessions[1]!.id).toBe('s1')
  })

  it('shows collapsed groups (zero sessions) when the peer is not expanded', () => {
    const sessions: DshHostRemoteSession[] = [
      remoteSession('s1', 'forge', 100),
    ]
    const peers: DshHostPeerView[] = [peer('forge', 'forge.ts.net:3080')]
    const groups = derivePeerGroups(sessions, peers, new Set())

    expect(groups[0]!.sessionCount).toBe(1)
    expect(groups[0]!.expanded).toBe(false)
    expect(groups[0]!.sessions).toEqual([])
  })

  it('includes unreachable peers with zero sessions', () => {
    const peers: DshHostPeerView[] = [
      peer('down-machine', 'down.local:3080', 'unreachable'),
    ]
    const groups = derivePeerGroups([], peers, new Set(['down.local:3080']))
    expect(groups[0]!.machine).toBe('down-machine')
    expect(groups[0]!.peerStatus.state).toBe('unreachable')
    expect(groups[0]!.sessionCount).toBe(0)
    expect(groups[0]!.sessions).toEqual([])
  })

  it('remote session nodes carry the correct peerAuthority (not machine label)', () => {
    const sessions: DshHostRemoteSession[] = [
      remoteSession('s1', 'forge', 100),
    ]
    const peers: DshHostPeerView[] = [peer('forge', 'forge.ts.net:3080')]
    const groups = derivePeerGroups(sessions, peers, new Set(['forge.ts.net:3080']))
    const node = groups[0]!.sessions[0]!
    expect(node.machine).toBe('forge')
    expect(node.peerAuthority).toBe('forge.ts.net:3080')
  })

  it('respects peerSchemes map', () => {
    const sessions: DshHostRemoteSession[] = [
      remoteSession('s1', 'forge', 100),
    ]
    const peers: DshHostPeerView[] = [peer('forge', 'forge.ts.net:3080')]
    const schemes = new Map([['forge.ts.net:3080', 'https' as const]])
    const groups = derivePeerGroups(
      sessions, peers, new Set(['forge.ts.net:3080']), schemes,
    )
    expect(groups[0]!.peerScheme).toBe('https')
    expect(groups[0]!.sessions[0]!.peerScheme).toBe('https')
  })
})

describe('peerSessionUrl', () => {
  it('returns undefined for a local session without peer metadata', () => {
    const node = remoteSessionNode(remoteSession('s1', 'local', 100), 'http')
    // remoteSessionNode leaves the authority to derivePeerGroups, so this node has none.
    expect(node.peerAuthority).toBeUndefined()
    expect(peerSessionUrl(node)).toBeUndefined()
  })

  it('constructs an http deep-link URL for a remote session', () => {
    const node = remoteSessionNode(remoteSession('s1', 'forge', 100), 'http')
    const url = peerSessionUrl({ ...node, peerAuthority: 'forge.ts.net:3080' })
    expect(url).toBe('http://forge.ts.net:3080/?session=s1')
  })

  it('constructs an https deep-link URL when peerScheme is https', () => {
    const node = remoteSessionNode(remoteSession('s1', 'forge', 100), 'https')
    const url = peerSessionUrl({ ...node, peerAuthority: 'forge.ts.net:3080' })
    expect(url).toBe('https://forge.ts.net:3080/?session=s1')
  })

  it('encodes special characters in the session id', () => {
    const node = remoteSessionNode(
      remoteSession('session/with spaces', 'forge', 100), 'http',
    )
    const url = peerSessionUrl({ ...node, peerAuthority: 'forge.ts.net:3080' })!
    expect(url).toContain('session%2Fwith%20spaces')
    // Round-trip: decoding the URL extracts the original session id.
    const parsed = new URL(url)
    expect(parsed.searchParams.get('session')).toBe('session/with spaces')
  })
})
