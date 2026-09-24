/** Peer poll loop, live volatile Config updates, and the published dshHostDirectory/list Remote. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import DshHostDirectoryService from '../src/index.ts'
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
