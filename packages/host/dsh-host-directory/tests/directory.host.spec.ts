/** Peer poll loop, live volatile Config updates, and the published dshHostDirectory/list Remote. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import DshHostDirectoryService, { classifyPendingInput } from '../src/index.ts'
import type { DshHostPeer } from '../src/types.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  vi.unstubAllGlobals()
})

const activePlugin: Plugin.Function = () => {}

async function harness(config: { machine?: string; peers?: DshHostPeer[]; pollIntervalMs?: number } = {}): Promise<{
  ctx: Context
  entryId: string
  directory: DshHostDirectoryService
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.active = activePlugin
  ctx.loader.builtins.directory = DshHostDirectoryService
  const entryId = await ctx.loader.create({ name: 'cordis:directory', config })
  const directory = ctx.get('dshHostDirectory') as DshHostDirectoryService
  return { ctx, entryId, directory }
}

describe('DshHostDirectoryService', () => {
  it('publishes one direct list method under the dshHostDirectory namespace', async () => {
    const { directory } = await harness()
    expect(directory.typertRemote).toMatchObject({ serviceKey: 'dshHostDirectory', namespace: 'dshHostDirectory' })
    expect(remoteMethods(directory)).toEqual([{ method: 'list', invocation: { kind: 'direct' } }])
  })

  it('starts empty with no configured peers, falling back to os.hostname() as the label', async () => {
    const { directory } = await harness()
    const snapshot = directory.list()
    expect(snapshot.sessions).toEqual([])
    expect(snapshot.peers).toEqual([])
    expect(snapshot.self.length).toBeGreaterThan(0)
  })

  it('uses the configured machine label when provided', async () => {
    const { directory } = await harness({ machine: 'forge' })
    expect(directory.list().self).toBe('forge')
  })

  it('polls a configured peer, merges its sessions with the machine label, and reports ok status', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://peer.example:3080/api/session/list')
      expect(init?.method).toBe('POST')
      const headers = init?.headers as Record<string, string>
      expect(headers.cookie).toBe('dsh-auth-abc=signed-value')
      const body = JSON.parse(init?.body as string) as { method: string; type: string }
      expect(body).toMatchObject({ type: 'client-request', method: 'session/list' })
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: 'x',
        result: { ok: true, value: { items: [
          { sessionId: 's1', updatedAt: 111, running: true, blank: false, cwd: '/home/n8/proj' },
        ] } },
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { directory } = await harness({
      peers: [{ machine: 'peer-machine', authority: 'peer.example:3080', sessionCookie: 'dsh-auth-abc=signed-value' }],
      pollIntervalMs: 1000,
    })

    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalled() }, { timeout: 2000, interval: 20 })
    await vi.waitFor(() => {
      const snapshot = directory.list()
      expect(snapshot.sessions).toEqual([
        { sessionId: 's1', machine: 'peer-machine', updatedAt: 111, running: true, blank: false, cwd: '/home/n8/proj' },
      ])
      expect(snapshot.peers).toEqual([
        { machine: 'peer-machine', authority: 'peer.example:3080', status: { state: 'ok', lastPolledAt: expect.any(Number) as number, sessionCount: 1 } },
      ])
    }, { timeout: 2000, interval: 20 })
  })

  it('reports an unreachable peer without throwing, and never invents sessions it could not read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const { directory } = await harness({
      peers: [{ machine: 'down-machine', authority: 'down.example:3080', sessionCookie: 'dsh-auth-x=y' }],
      pollIntervalMs: 1000,
    })

    await vi.waitFor(() => {
      const snapshot = directory.list()
      expect(snapshot.sessions).toEqual([])
      expect(snapshot.peers).toEqual([{
        machine: 'down-machine', authority: 'down.example:3080',
        status: {
          state: 'unreachable',
          lastAttemptAt: expect.any(Number) as number,
          message: expect.stringContaining('ECONNREFUSED') as string,
        },
      }])
    }, { timeout: 2000, interval: 20 })
  })

  it('fails closed with a visible status when a peer has no sessionCookie configured, never guessing one', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { directory } = await harness({
      peers: [{ machine: 'no-cookie-machine', authority: 'nocookie.example:3080', sessionCookie: '' }],
      pollIntervalMs: 1000,
    })

    await vi.waitFor(() => {
      const snapshot = directory.list()
      expect(snapshot.peers).toEqual([{
        machine: 'no-cookie-machine', authority: 'nocookie.example:3080',
        status: {
          state: 'unreachable',
          lastAttemptAt: expect.any(Number) as number,
          message: expect.stringContaining('sessionCookie') as string,
        },
      }])
    }, { timeout: 2000, interval: 20 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces a 401 from a peer as a visible unreachable status naming the cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })))
    const { directory } = await harness({
      peers: [{ machine: 'stale-cookie-machine', authority: 'stale.example:3080', sessionCookie: 'dsh-auth-old=expired' }],
      pollIntervalMs: 1000,
    })

    await vi.waitFor(() => {
      const status = directory.list().peers[0]?.status
      expect(status).toMatchObject({ state: 'unreachable', message: expect.stringContaining('401') as string })
    }, { timeout: 2000, interval: 20 })
  })

  it('reacts to a live volatile config update: a peer added after boot starts polling without a restart', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      type: 'server-response', rpcId: 'x', result: { ok: true, value: { items: [] } },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { ctx, entryId, directory } = await harness({ peers: [], pollIntervalMs: 1000 })
    expect(directory.list().peers).toEqual([])

    await ctx.loader.update(entryId, {
      config: {
        peers: [{ machine: 'late-machine', authority: 'late.example:3080', sessionCookie: 'dsh-auth-l=m' }],
        pollIntervalMs: 1000,
      },
    })

    await vi.waitFor(() => {
      expect(directory.list().peers).toEqual([
        {
          machine: 'late-machine',
          authority: 'late.example:3080',
          status: expect.objectContaining({ state: expect.any(String) as string }) as unknown,
        },
      ])
    }, { timeout: 2000, interval: 20 })
  })

  it('drops a peer removed from config and stops reporting its sessions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      type: 'server-response', rpcId: 'x', result: { ok: true, value: { items: [] } },
    }), { status: 200 })))
    const { ctx, entryId, directory } = await harness({
      peers: [{ machine: 'temp-machine', authority: 'temp.example:3080', sessionCookie: 'dsh-auth-z=w' }],
      pollIntervalMs: 1000,
    })
    await vi.waitFor(() => { expect(directory.list().peers).toHaveLength(1) }, { timeout: 2000, interval: 20 })

    await ctx.loader.update(entryId, { config: { peers: [], pollIntervalMs: 1000 } })
    expect(directory.list().peers).toEqual([])
  })
})

// dsh-mesh-session-view step 6: read-only pending-input classification, the
// SAME rule app/session_inspector.py::classify_pending_input applies to the
// Hub's own history poll — kept in sync by design, tested independently here.
describe('classifyPendingInput', () => {
  const call = (callId: string, name = 'ask_user_question', args?: unknown) => (
    { type: 'tool/call', data: { callId, name, arguments: args } }
  )
  const result = (callId: string) => ({ type: 'tool/result', data: { callId } })
  const asked = (id: string, toolName = 'dsh-bash-local', reason = 'escalation needed') => (
    { type: 'approval/asked', data: { id, toolName, reason } }
  )
  const decided = (id: string) => ({ type: 'approval/decided', data: { id, outcome: 'allowed-once' } })

  it('returns undefined when nothing is open', () => {
    expect(classifyPendingInput([])).toBeUndefined()
    expect(classifyPendingInput([call('c1'), result('c1')])).toBeUndefined()
    expect(classifyPendingInput([asked('a1'), decided('a1')])).toBeUndefined()
  })

  it('classifies an open ask_user_question as a pending question, with a summary', () => {
    const events = [call('c1', 'ask_user_question', { questions: [{ question: 'Confirm task scope' }] })]
    expect(classifyPendingInput(events)).toEqual({
      kind: 'question', toolName: 'ask_user_question', summary: 'Confirm task scope',
    })
  })

  it('never classifies a non-ask_user_question tool/call as a question', () => {
    expect(classifyPendingInput([call('c1', 'dsh-bash-local')])).toBeUndefined()
  })

  it('classifies an open approval/asked as a pending approval, with its reason', () => {
    const events = [asked('a1', 'dsh-bash-local', 'git push needs escalation')]
    expect(classifyPendingInput(events)).toEqual({
      kind: 'approval', toolName: 'dsh-bash-local', summary: 'git push needs escalation',
    })
  })

  it('prefers an open question over an open approval when both appear', () => {
    const events = [asked('a1'), call('c1', 'ask_user_question', { questions: [{ question: 'pick one' }] })]
    expect(classifyPendingInput(events)?.kind).toBe('question')
  })

  it('an answered question is not pending', () => {
    expect(classifyPendingInput([call('c1'), result('c1')])).toBeUndefined()
  })

  it('a decided approval is not pending', () => {
    expect(classifyPendingInput([asked('a1'), decided('a1')])).toBeUndefined()
  })
})

describe('DshHostDirectoryService pendingInput (step 6, opt-in)', () => {
  it('omits pendingInput entirely when pollPendingInput is not set (R2 contract unchanged by default)', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/api/session/list')) {
        return new Response(JSON.stringify({
          type: 'server-response', rpcId: 'x',
          result: { ok: true, value: { items: [{ sessionId: 's1', updatedAt: 1, running: true, blank: false }] } },
        }), { status: 200 })
      }
      throw new Error(`unexpected call to ${String(url)} — session.history must not be read when pollPendingInput is unset`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { directory } = await harness({
      peers: [{ machine: 'peer-machine', authority: 'peer.example:3080', sessionCookie: 'dsh-auth-abc=v' }],
      pollIntervalMs: 1000,
    })
    await vi.waitFor(() => {
      expect(directory.list().sessions).toEqual([{ sessionId: 's1', machine: 'peer-machine', updatedAt: 1, running: true, blank: false }])
    }, { timeout: 2000, interval: 20 })
    expect('pendingInput' in directory.list().sessions[0]!).toBe(false)
  })

  it('surfaces pendingInput per session when pollPendingInput is enabled', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/api/session/list')) {
        return new Response(JSON.stringify({
          type: 'server-response', rpcId: 'x',
          result: { ok: true, value: { items: [{ sessionId: 's1', updatedAt: 1, running: true, blank: false }] } },
        }), { status: 200 })
      }
      if (String(url).endsWith('/api/session.history')) {
        const body = JSON.parse(init?.body as string) as { payload: { sessionId: string } }
        expect(body.payload.sessionId).toBe('s1')
        return new Response(JSON.stringify({
          type: 'server-response', rpcId: 'y',
          result: { ok: true, value: { events: [
            { event: { type: 'tool/call', data: { callId: 'c1', name: 'ask_user_question', arguments: { questions: [{ question: 'Confirm task scope' }] } } } },
          ] } },
        }), { status: 200 })
      }
      throw new Error(`unexpected url ${String(url)}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { directory } = await harness({
      peers: [{ machine: 'peer-machine', authority: 'peer.example:3080', sessionCookie: 'dsh-auth-abc=v', pollPendingInput: true }],
      pollIntervalMs: 1000,
    })
    await vi.waitFor(() => {
      expect(directory.list().sessions).toEqual([{
        sessionId: 's1', machine: 'peer-machine', updatedAt: 1, running: true, blank: false,
        pendingInput: { kind: 'question', toolName: 'ask_user_question', summary: 'Confirm task scope' },
      }])
    }, { timeout: 2000, interval: 20 })
  })

  it('a failed per-session history read omits pendingInput but never marks the peer unreachable', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/api/session/list')) {
        return new Response(JSON.stringify({
          type: 'server-response', rpcId: 'x',
          result: { ok: true, value: { items: [{ sessionId: 's1', updatedAt: 1, running: true, blank: false }] } },
        }), { status: 200 })
      }
      if (String(url).endsWith('/api/session.history')) throw new Error('ECONNRESET')
      throw new Error(`unexpected url ${String(url)}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { directory } = await harness({
      peers: [{ machine: 'peer-machine', authority: 'peer.example:3080', sessionCookie: 'dsh-auth-abc=v', pollPendingInput: true }],
      pollIntervalMs: 1000,
    })
    await vi.waitFor(() => { expect(directory.list().sessions).toHaveLength(1) }, { timeout: 2000, interval: 20 })
    expect(directory.list().peers[0]?.status.state).toBe('ok')
    expect('pendingInput' in directory.list().sessions[0]!).toBe(false)
  })
})
