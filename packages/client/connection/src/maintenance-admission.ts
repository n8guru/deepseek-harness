/** Maintenance-only backport of rc2 configured producer authentication. No credentials are minted. */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent-loop/maintenance'

/** Explicit operator grant; bodies and browser cookies confer no authority. */
export interface NotificationProducer {
  origin: string
  bearerSha256: string
  sessionIds: string[]
  urgency: ('safety' | 'security' | 'deadline')[]
}

/** Preserve rc2 provisioning shape without enabling notification ingress on old source. */
export const notificationProducerSchema = Schema.object({
  origin: Schema.string().min(1).max(128).required(),
  bearerSha256: Schema.string().pattern(/^[a-f0-9]{64}$/).required(),
  sessionIds: Schema.array(Schema.string().min(1).required()).min(1).required(),
  urgency: Schema.array(Schema.union(['safety', 'security', 'deadline'])).default([]),
})

/**
 * Dispatch only an authenticated maintenance owner to the durable native receiver.
 * @param ctx - existing host context.
 * @param request - JSON request on the existing API bridge.
 * @param producers - validated configured bearer hashes.
 * @param owners - configured origins allowed to own maintenance.
 * @returns a durable result or refusal; never an inferred ACK.
 */
export async function receiveMaintenance(
  ctx: Context,
  request: Request,
  producers: readonly NotificationProducer[],
  owners: readonly string[],
): Promise<Response> {
  if (request.method !== 'POST') return new Response('POST required', { status: 405 })
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return new Response('application/json required', { status: 415 })
  const authorization = request.headers.get('authorization')
  if (authorization === null || !/^Bearer [^\s]{32,1024}$/.test(authorization)) return new Response('maintenance owner unauthorized', { status: 403 })
  const hash = createHash('sha256').update(authorization.slice(7)).digest()
  const producer = producers.find(p => timingSafeEqual(hash, Buffer.from(p.bearerSha256, 'hex')))
  if (producer === undefined || !owners.includes(producer.origin)) return new Response('maintenance owner unauthorized', { status: 403 })
  const receiver = ctx.get('hostMaintenance')
  if (receiver === undefined) return new Response('native maintenance receiver unavailable', { status: 409 })
  let raw: unknown
  try { raw = await request.json() } catch { return new Response('invalid maintenance JSON', { status: 400 }) }
  request.signal.throwIfAborted()
  try {
    const state = await receiver.receive(producer.origin, raw)
    request.signal.throwIfAborted()
    return Response.json(state)
  } catch {
    return new Response('native maintenance request refused; no accepted ACK', { status: 409 })
  }
}
