/** Authenticated notification ingress. Provisioning is operator-owned; no credentials are minted or read here. */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Explicit host grants, not a request's self-asserted origin or urgency. */
export interface NotificationProducer {
  /** Host-derived stable producer namespace; native: is reserved. */
  origin: string
  /** SHA256 of an operator-provisioned bearer, lowercase hexadecimal. */
  bearerSha256: string
  /** Exact existing session ids this principal may notify. */
  sessionIds: string[]
  /** Critical kinds this principal may truthfully assert with a reason. */
  urgency: ('safety' | 'security' | 'deadline')[]
}

/** Source config schema; empty grants fail closed and provisioning never happens automatically. */
export const notificationProducerSchema = Schema.object({
  origin: Schema.string().min(1).max(128).required(),
  bearerSha256: Schema.string().pattern(/^[a-f0-9]{64}$/).required(),
  sessionIds: Schema.array(Schema.string().min(1).required()).min(1).required(),
  urgency: Schema.array(Schema.union(['safety', 'security', 'deadline'])).default([]),
})

const requestSchema = Schema.object({
  sessionId: Schema.string().min(1).required(),
  items: Schema.array(Schema.object({
    sequence: Schema.string().min(1).max(256).required(),
    text: Schema.string().min(1).max(200_000).required(),
    evidenceRefs: Schema.array(Schema.string().min(1).max(4096).required()).max(100).default([]),
    urgency: Schema.union([Schema.const(undefined), Schema.object({
      kind: Schema.union(['safety', 'security', 'deadline']).required(),
      reason: Schema.string().min(1).max(1024).required(),
    })]),
  }).required()).min(1).max(10).required(),
})

function assertKeys(value: object, keys: readonly string[]): void {
  if (Object.entries(value).some(([key, item]) => !keys.includes(key) || item === null)) throw new Error('invalid notification fields')
}

/**
 * Match a presented bearer to configured hashes; Host and Origin confer no producer identity.
 * @param request - incoming request carrying Authorization.
 * @param producers - validated operator grants.
 * @returns the authenticated grant, or undefined when unauthorized.
 */
export function authenticateNotification(request: Request, producers: readonly NotificationProducer[]): NotificationProducer | undefined {
  const authorization = request.headers.get('authorization')
  if (authorization === null || !/^Bearer [^\s]{32,1024}$/.test(authorization)) return undefined
  const hash = createHash('sha256').update(authorization.slice(7)).digest()
  return producers.find(p => timingSafeEqual(hash, Buffer.from(p.bearerSha256, 'hex')))
}

/**
 * Validate all items before mutation; durable per-item receipts survive lost ACKs and retry.
 * @param ctx - existing host services and live session registry.
 * @param request - authenticated JSON admission request.
 * @param producers - validated operator grants.
 * @returns durable receipts or a refusal response; storage/abort failures may reject without ACK.
 */
export async function admitNotifications(ctx: Context, request: Request, producers: readonly NotificationProducer[]): Promise<Response> {
  const producer = authenticateNotification(request, producers)
  if (producer === undefined) return new Response('notification producer unauthorized', { status: 403 })
  let raw: unknown
  try { raw = await request.json() } catch { return new Response('invalid notification JSON', { status: 400 }) }
  let parsed: ReturnType<typeof requestSchema>
  try {
    parsed = requestSchema(raw as never)
    assertKeys(parsed, ['sessionId', 'items'])
    for (const item of parsed.items) {
      assertKeys(item, ['sequence', 'text', 'evidenceRefs', 'urgency'])
      if (item.urgency !== undefined) assertKeys(item.urgency, ['kind', 'reason'])
    }
  } catch { return new Response('invalid notification request', { status: 400 }) }
  const { sessionId, items } = parsed
  if (!producer.sessionIds.includes(sessionId) || items.some(i => i.urgency !== undefined && !producer.urgency.includes(i.urgency.kind))) return new Response('notification grant denied', { status: 403 })
  const agent = ctx.get('agents')?.get(SessionId(sessionId))
  // A cold session must be resumed through its existing owner before retry; this ingress cannot create an executor.
  if (agent === undefined || agent.wakeInbox === undefined) return new Response('notification session unavailable', { status: 409 })
  const messages = items.map(item => ({
    item,
    message: createUserMessage({
      source: { kind: 'plugin', plugin: producer.origin, form: 'notice', summary: 'Authenticated background notification' },
      content: [{ type: 'text', text: item.text },
        ...item.evidenceRefs.map(ref => ({ type: 'text' as const, text: `Evidence: ${ref}` })),
        ...item.urgency === undefined ? [] : [{ type: 'text' as const, text: `Urgency (${item.urgency.kind}): ${item.urgency.reason}` }],
      ],
    }),
  }))
  const sequences = new Set<string>()
  for (const { item, message } of messages) {
    if (sequences.has(item.sequence)) return new Response('duplicate sequence in batch', { status: 400 })
    sequences.add(item.sequence)
    const previous = agent.inbox.receipt(producer.origin, item.sequence)
    if (previous !== undefined && JSON.stringify(previous.content) !== JSON.stringify(message.content)) return new Response('notification sequence content conflict', { status: 409 })
  }
  request.signal.throwIfAborted()
  const receipts = messages.map(({ item, message }) => {
    const inserted = agent.inbox.admit('next-step', message, { origin: producer.origin, sequence: item.sequence, ...item.urgency === undefined ? {} : { urgency: item.urgency } })
    const accepted = agent.inbox.receipt(producer.origin, item.sequence)
    if (accepted === undefined) throw new Error('notification admission lost its receipt')
    return { sequence: item.sequence, messageId: accepted.id, duplicate: !inserted }
  })
  // ACK is not accepted until a real persistence participant confirms the original admission.
  if (!await ctx.sessions.flush(agent.session)) return new Response('notification durability unavailable', { status: 503 })
  if (ctx.agents.get(agent.id) !== agent) return new Response('notification owner changed', { status: 409 })
  request.signal.throwIfAborted()
  if (receipts.some(r => agent.inbox.isPendingReceipt(producer.origin, r.sequence))) agent.wakeInbox()
  return Response.json({ accepted: true, origin: producer.origin, receipts, focus: agent.inbox.focus })
}

/**
 * Native operator controls never classify prompt text; Check grants one bounded snapshot.
 * @param ctx - existing host services and live session registry.
 * @param request - browser-fenced JSON operator request.
 * @returns Focus state or a refusal; storage/abort failures may reject without ACK.
 */
export async function controlFocus(ctx: Context, request: Request): Promise<Response> {
  const schema = Schema.object({
    sessionId: Schema.string().min(1).required(),
    action: Schema.union(['inspect', 'set', 'check']).required(),
    enabled: Schema.union([Schema.const(undefined), Schema.boolean()]),
    checkId: Schema.union([Schema.const(undefined), Schema.string().min(1).max(256)]),
  })
  let raw: unknown
  try { raw = await request.json() } catch { return new Response('invalid Focus JSON', { status: 400 }) }
  let input: ReturnType<typeof schema>
  try { input = schema(raw as never); assertKeys(input, ['sessionId', 'action', 'enabled', 'checkId']) }
  catch { return new Response('invalid Focus control', { status: 400 }) }
  const agent = ctx.get('agents')?.get(SessionId(input.sessionId))
  if (agent === undefined || agent.wakeInbox === undefined) return new Response('Focus session unavailable', { status: 409 })
  if (input.action === 'inspect') return Response.json(agent.inbox.focus)
  request.signal.throwIfAborted()
  if (input.action === 'set') {
    if (input.enabled === undefined) return new Response('enabled required', { status: 400 })
    agent.inbox.setFocus(input.enabled)
    if (!await ctx.sessions.flush(agent.session)) return new Response('Focus durability unavailable', { status: 503 })
    return Response.json(agent.inbox.focus)
  }
  const checkId = input.checkId
  const wake = agent.wakeInbox.bind(agent)
  if (checkId === undefined) return new Response('checkId required', { status: 400 })
  // Claim the existing maintenance fence atomically; human arrivals and Stop remain immediate and abort this fence.
  if (agent.status !== 'idle') return new Response('Check requires a safe idle boundary', { status: 409 })
  try {
    return agent.runMaintenance(async (signal) => {
      if (!await ctx.sessions.flush(agent.session)) return new Response('checkpoint durability unavailable', { status: 503 })
      signal.throwIfAborted()
      request.signal.throwIfAborted()
      if (ctx.agents.get(agent.id) !== agent) return new Response('Focus owner changed', { status: 409 })
      if (agent.inbox.hasForeground) return new Response('foreground input arrived; Check deferred', { status: 409 })
      const messageIds = agent.inbox.check(checkId)
      if (!await ctx.sessions.flush(agent.session)) return new Response('Check durability unavailable', { status: 503 })
      signal.throwIfAborted()
      request.signal.throwIfAborted()
      // The snapshot is explicit operator input. No routine held arrival receives a wake.
      if (messageIds.length > 0) wake()
      return Response.json({ ...agent.inbox.focus, messageIds })
    })
  } catch {
    // runMaintenance only throws synchronously when another activity owns the idle phase.
    // Async storage/abort errors retain their rejected promise and never receive an accepted ACK.
    return new Response('Check boundary already owned', { status: 409 })
  }
}
