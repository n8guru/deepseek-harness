import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { BrowserAuth } from '../src/browser-auth.ts'
import { HostConnectionService } from '../src/rpc-host.ts'
import type { ConnectionRpcGuardRequest } from '../src/rpc.ts'

async function harness(): Promise<{ ctx: Context; connection: HostConnectionService; handled: string[] }> {
  const ctx = new Context()
  await ctx.plugin((owner) => { new HostConnectionService(owner, [], {} as BrowserAuth) }).await()
  const connection = ctx.get('connection') as HostConnectionService
  const handled: string[] = []
  connection.rpc.intercept('/api', () => true, async (endpoint) => {
    handled.push(endpoint)
    return { ok: true, value: { handled: endpoint } }
  })
  return { ctx, connection, handled }
}

function call(connection: HostConnectionService, endpoint: string, host: string): Promise<Response> {
  return connection.createSharedFetchHandler('/api').fetch(new Request(`http://${host}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: endpoint, payload: { args: { request: { sessionId: 's1' } } } }),
  }))
}

describe('Connection rpc.guard', () => {
  it('hands the guard the endpoint, decoded payload and Host authority, and a refusal never reaches the handler', async () => {
    const { ctx, connection, handled } = await harness()
    try {
      const seen: ConnectionRpcGuardRequest[] = []
      connection.rpc.guard('/api', (request) => {
        seen.push(request)
        return request.authority === '100.64.0.1:3182'
          ? { code: 'fixture/refused', message: 'no', details: { why: 'remote' } }
          : undefined
      })
      const refused = await (await call(connection, 'session/prompt', '100.64.0.1:3182')).json() as { rpcId: string; result: unknown }
      expect(refused).toEqual({
        type: 'server-response', rpcId: 'r1',
        result: { ok: false, error: { code: 'fixture/refused', message: 'no', details: { why: 'remote' } } },
      })
      expect(handled).toEqual([])
      const allowed = await (await call(connection, 'session/prompt', '127.0.0.1:3182')).json() as { result: unknown }
      expect(allowed.result).toEqual({ ok: true, value: { handled: 'session/prompt' } })
      expect(handled).toEqual(['session/prompt'])
      expect(seen.map(request => [request.endpoint, request.authority])).toEqual([
        ['session/prompt', '100.64.0.1:3182'],
        ['session/prompt', '127.0.0.1:3182'],
      ])
      expect(seen[0]!.payload).toEqual({ args: { request: { sessionId: 's1' } } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails closed when a guard throws, and stops guarding once its owner disposes', async () => {
    const { ctx, connection, handled } = await harness()
    try {
      const remove = connection.rpc.guard('/api', () => { throw new Error('boom') })
      const crashed = await call(connection, 'session/prompt', '127.0.0.1:3182')
      expect(crashed.status).toBe(500)
      expect(handled).toEqual([])
      await remove()
      const open = await (await call(connection, 'session/prompt', '127.0.0.1:3182')).json() as { result: { ok: boolean } }
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
