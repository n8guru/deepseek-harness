/** ctx.connection.rpc.guard: pre-dispatch veto on the shared /api channel (interceptor AND API Proxy fallback). */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { HostConnectionService } from '../src/rpc-host.ts'
import type { ConnectionRpcGuardRequest } from '../src/rpc.ts'

async function harness(): Promise<{
  ctx: Context
  connection: HostConnectionService
  handled: string[]
  fallback: string[]
}> {
  const ctx = new Context()
  await ctx.plugin((owner) => { new HostConnectionService(owner, []) }).await()
  const connection = ctx.get('connection') as HostConnectionService
  const handled: string[] = []
  const fallback: string[] = []
  connection.rpc.intercept('/api', endpoint => endpoint.includes('/'), async (endpoint) => {
    handled.push(endpoint)
    return { ok: true, value: { handled: endpoint } }
  }, { authority: 'trusted-host' })
  return { ctx, connection, handled, fallback }
}

/** The API Proxy stand-in: serves every dotted rc.8 method the interceptor does not claim. */
function fallbackFor(fallback: string[]): { fetch: (request: Request) => Promise<Response> } {
  return {
    fetch: async (request) => {
      const endpoint = new URL(request.url).pathname.slice('/api/'.length)
      fallback.push(endpoint)
      return Response.json({ type: 'server-response', rpcId: 'r1', result: { ok: true, value: { fallback: endpoint } } })
    },
  }
}

function call(
  h: { connection: HostConnectionService; fallback: string[] },
  endpoint: string,
  host: string,
  payload: unknown = { sessionId: 's1' },
): Promise<Response> {
  return h.connection.createSharedFetchHandler('/api', fallbackFor(h.fallback)).fetch(new Request(`http://${host}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: endpoint, payload }),
  }))
}

describe('Connection rpc.guard', () => {
  it('hands the guard endpoint, rpcId, decoded payload and Host authority; a refusal never reaches the API Proxy fallback', async () => {
    const h = await harness()
    const { ctx, connection, fallback } = h
    try {
      const seen: ConnectionRpcGuardRequest[] = []
      connection.rpc.guard('/api', (request) => {
        seen.push(request)
        return request.authority === '100.64.0.1:3182'
          ? { code: 'fixture/refused', message: 'no', details: { why: 'remote' } }
          : undefined
      })
      const refused = await (await call(h, 'session.prompt', '100.64.0.1:3182')).json() as { rpcId: string; result: unknown }
      expect(refused).toEqual({
        type: 'server-response', rpcId: 'r1',
        result: { ok: false, error: { code: 'internal', message: 'fixture/refused: no', details: {} } },
      })
      expect(fallback).toEqual([])
      const allowed = await (await call(h, 'session.prompt', '127.0.0.1:3182')).json() as { result: unknown }
      expect(allowed.result).toEqual({ ok: true, value: { fallback: 'session.prompt' } })
      expect(fallback).toEqual(['session.prompt'])
      expect(seen.map(request => [request.endpoint, request.authority, request.rpcId])).toEqual([
        ['session.prompt', '100.64.0.1:3182', 'r1'],
        ['session.prompt', '127.0.0.1:3182', 'r1'],
      ])
      expect(seen[0]!.payload).toEqual({ sessionId: 's1' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('also guards Typert-claimed endpoints before the interceptor handler runs', async () => {
    const h = await harness()
    const { ctx, connection, handled } = h
    try {
      connection.rpc.guard('/api', request => request.authority === '100.64.0.1:3182'
        ? { code: 'fixture/refused', message: 'no', details: {} }
        : undefined)
      const refused = await (await call(h, 'dshHostDirectory/setAllowRemoteSteer', '100.64.0.1:3182')).json() as { result: { ok: boolean } }
      expect(refused.result.ok).toBe(false)
      expect(handled).toEqual([])
      const allowed = await (await call(h, 'dshHostDirectory/setAllowRemoteSteer', '127.0.0.1:3182')).json() as { result: { ok: boolean } }
      expect(allowed.result.ok).toBe(true)
      expect(handled).toEqual(['dshHostDirectory/setAllowRemoteSteer'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails closed when a guard throws, and stops guarding once its owner disposes', async () => {
    const h = await harness()
    const { ctx, connection, fallback } = h
    try {
      const remove = connection.rpc.guard('/api', () => { throw new Error('boom') })
      const crashed = await call(h, 'session.prompt', '127.0.0.1:3182')
      expect(crashed.status).toBe(500)
      expect(fallback).toEqual([])
      await remove()
      const open = await (await call(h, 'session.prompt', '127.0.0.1:3182')).json() as { result: { ok: boolean } }
      expect(open.result.ok).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a guard on any channel other than /api', async () => {
    const { ctx, connection } = await harness()
    try {
      expect(() => connection.rpc.guard('/rpc' as '/api', () => undefined)).toThrow('invalid shared RPC channel')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
