/** Authenticated notification ingress. Provisioning is operator-owned; no credentials are minted or read here. */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { z } from 'zod'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    notification: { kind: 'notification'; origin: string } & ContextFormed
  }
}

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
  /** Explicit read grant; notification and maintenance authority do not imply it. */
  activityRead?: boolean
  /** Mandatory release gating; unsupported native implementations refuse, never fall back. */
  activityGated?: boolean
}

/** Source config schema; empty grants fail closed and provisioning never happens automatically. */
export const notificationProducerSchema = Schema.object({
  origin: Schema.string().min(1).max(128).required(),
  bearerSha256: Schema.string().pattern(/^[a-f0-9]{64}$/).required(),
  sessionIds: Schema.array(Schema.string().min(1).required()).min(1).required(),
  urgency: Schema.array(Schema.union(['safety', 'security', 'deadline'])).default([]),
  activityRead: Schema.boolean().default(false),
  activityGated: Schema.boolean().default(false),
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

const activityGuardSchema = z.object({
  version: z.literal(1),
  hostEpoch: z.string().min(1).max(256),
  bindingEpoch: z.string().min(1).max(256),
  activityRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  controlRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict()

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

/** Authenticated owner/run native receiver; request bodies never confer owner authority. */
export async function receiveMaintenance(
  ctx: Context, request: Request, producers: readonly NotificationProducer[], owners: readonly string[],
): Promise<Response> {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return new Response('application/json required', { status: 415 })
  const producer = authenticateNotification(request, producers)
  if (producer === undefined || !owners.includes(producer.origin)) return new Response('maintenance owner unauthorized', { status: 403 })
  const receiver = ctx.get('maintenanceReceiver')
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

/**
 * Validate all items before mutation; durable per-item receipts survive lost ACKs and retry.
 * @param ctx - existing host services and live session registry.
 * @param request - authenticated JSON admission request.
 * @param producers - validated operator grants.
 * @returns durable receipts or a refusal response; storage/abort failures may reject without ACK.
 */
export async function admitNotifications(ctx: Context, request: Request, producers: readonly NotificationProducer[]): Promise<Response> {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return new Response('application/json required', { status: 415 })
  const authenticated = authenticateNotification(request, producers)
  if (authenticated === undefined) return new Response('notification producer unauthorized', { status: 403 })
  // Do not retain mutable grant arrays across request-body or persistence awaits.
  const producer = structuredClone(authenticated)
  const authorized = () => JSON.stringify(authenticateNotification(request, producers)) === JSON.stringify(producer)
  let raw: unknown
  try { raw = await request.json() } catch { return new Response('invalid notification JSON', { status: 400 }) }
  request.signal.throwIfAborted()
  if (!authorized()) return new Response('notification grant changed', { status: 403 })
  if (typeof raw === 'object' && raw !== null && 'action' in raw) {
    if (producer.activityRead !== true) return new Response('activity read grant denied', { status: 403 })
    try {
      assertKeys(raw, ['version', 'action', 'sessionId'])
      if (!('version' in raw) || raw.version !== 1 || raw.action !== 'activity'
        || !('sessionId' in raw) || typeof raw.sessionId !== 'string' || !raw.sessionId || raw.sessionId.length > 256) throw new Error('invalid activity request')
      if (!producer.sessionIds.includes(raw.sessionId)) return new Response('activity read grant denied', { status: 403 })
    } catch { return new Response('invalid activity request', { status: 400 }) }
    try {
      const snapshot = ctx.get('connection')?.operatorActivity.snapshot((raw as { sessionId: string }).sessionId)
      if (snapshot === undefined) return new Response('operator activity unavailable', { status: 409 })
      return Response.json(snapshot, { headers: { 'cache-control': 'no-store' } })
    } catch { return new Response('operator activity unavailable', { status: 409 }) }
  }
  let guard: z.infer<typeof activityGuardSchema> | undefined
  let parsed: ReturnType<typeof requestSchema>
  try {
    parsed = requestSchema(raw as never)
    assertKeys(raw as object, ['sessionId', 'items', 'activityGuard'])
    if (typeof raw === 'object' && raw !== null && 'activityGuard' in raw) guard = activityGuardSchema.parse(raw.activityGuard)
    for (const item of (raw as { items: object[] }).items) {
      assertKeys(item, ['sequence', 'text', 'evidenceRefs', 'urgency'])
      const urgency = (item as { urgency?: object }).urgency
      if (urgency !== undefined) assertKeys(urgency, ['kind', 'reason'])
    }
    for (const item of parsed.items) {
      assertKeys(item, ['sequence', 'text', 'evidenceRefs', 'urgency'])
      if (item.urgency !== undefined) assertKeys(item.urgency, ['kind', 'reason'])
    }
  } catch { return new Response('invalid notification request', { status: 400 }) }
  const { sessionId, items } = parsed
  if (guard !== undefined && (producer.activityGated !== true || producer.activityRead !== true)) return new Response('activity gated grant denied', { status: 403 })
  if (producer.activityGated === true) {
    if (producer.activityRead !== true) return new Response('activity read grant denied', { status: 403 })
    if (guard === undefined) return new Response('activity guard required', { status: 409 })
  }
  if (!producer.sessionIds.includes(sessionId) || items.some(i => i.urgency !== undefined && !producer.urgency.includes(i.urgency.kind))) return new Response('notification grant denied', { status: 403 })
  const agent = ctx.get('agents')?.get(SessionId(sessionId))
  // A cold session must be resumed through its existing owner before retry; this ingress cannot create an executor.
  if (agent === undefined || agent.wakeInbox === undefined) return new Response('notification session unavailable', { status: 409 })
  const inbox = agent.inbox.notifications
  if (inbox === undefined) return new Response('notification driver unavailable', { status: 409 })
  const messages = items.map(item => ({
    item,
    message: createUserMessage({
      source: { kind: 'notification', origin: producer.origin, form: 'notice', summary: 'Authenticated background notification' },
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
    if (guard === undefined && inbox.isActivityGatedReceipt?.(producer.origin, item.sequence)) return new Response('gated receipt requires gated handling', { status: 409 })
    const previous = inbox.receipt(producer.origin, item.sequence)
    if (previous !== undefined && JSON.stringify(previous.content) !== JSON.stringify(message.content)) return new Response('notification sequence content conflict', { status: 409 })
  }
  request.signal.throwIfAborted()
  if (guard !== undefined) {
    const accepting = () => inbox.accepting === true
    if (inbox.stageActivityGated === undefined || inbox.isActivityGatedReceipt === undefined || !accepting()) return new Response('native activity-gated custody unavailable', { status: 409 })
    try {
      const snapshot = ctx.get('connection')?.operatorActivity.snapshot(sessionId)
      if (snapshot === undefined || ctx.get('agents')?.get(agent.id) !== agent) return new Response('operator activity unavailable', { status: 409 })
      const replay = messages.every(({ item }) => inbox.isActivityGatedReceipt?.(producer.origin, item.sequence) === true
        && inbox.receipt(producer.origin, item.sequence) !== undefined)
      // Exact receipt-only replay needs no live release permission. The native
      // staging operation checks all payload/target collisions before mutation.
      if (!replay && (snapshot.sessionId !== sessionId || snapshot.hostEpoch !== guard.hostEpoch
        || snapshot.binding?.bindingEpoch !== guard.bindingEpoch
        || snapshot.activityRevision !== guard.activityRevision || snapshot.controlRevision !== guard.controlRevision
        || snapshot.holdReasons.length !== 0)) return new Response('stale or held activity guard', { status: 409 })
      const receipts = inbox.stageActivityGated('next-step', messages.map(({ item, message }) => ({
        message,
        admission: { origin: producer.origin, sequence: item.sequence,
          ...item.urgency === undefined ? {} : { urgency: item.urgency }, activityGated: true },
      })), guard)
      if (!await ctx.get('sessions')?.flush(agent.session)) return new Response('notification durability unavailable', { status: 503 })
      request.signal.throwIfAborted()
      if (!authorized()) return new Response('notification grant changed', { status: 403 })
      if (ctx.get('agents')?.get(agent.id) !== agent || agent.inbox.notifications !== inbox || !accepting()) return new Response('notification owner changed', { status: 409 })
      const current = ctx.get('connection')?.operatorActivity.snapshot(sessionId)
      if (current === undefined) return new Response('operator activity unavailable', { status: 409 })
      // Recompute binding/age/holds and revisions after persistence. Our own
      // insertion advances Session.seq/controlRevision too: neither matching
      // nor changed tuples authorize release until native step-79 enforcement.
      return Response.json({ accepted: true, delivery: 'held', origin: producer.origin, receipts, focus: inbox.focus, activity: current },
        { headers: { 'cache-control': 'no-store' } })
    } catch {
      // Retained receipts remain retryable; failed staging/flush is never ACKed.
      return new Response('activity-gated custody unavailable; no accepted ACK', { status: 409 })
    }
  }
  const receipts = messages.map(({ item, message }) => {
    const inserted = inbox.admit('next-step', message, { origin: producer.origin, sequence: item.sequence, ...item.urgency === undefined ? {} : { urgency: item.urgency } })
    const accepted = inbox.receipt(producer.origin, item.sequence)
    if (accepted === undefined) throw new Error('notification admission lost its receipt')
    return { sequence: item.sequence, messageId: accepted.id, duplicate: !inserted }
  })
  // ACK is not accepted until a real persistence participant confirms the original admission.
  if (!await ctx.get('sessions')?.flush(agent.session)) return new Response('notification durability unavailable', { status: 503 })
  if (ctx.get('agents')?.get(agent.id) !== agent) return new Response('notification owner changed', { status: 409 })
  request.signal.throwIfAborted()
  if (!authorized()) return new Response('notification grant changed', { status: 403 })
  if (receipts.some(r => inbox.isPendingReceipt(producer.origin, r.sequence))) agent.wakeInbox()
  return Response.json({ accepted: true, origin: producer.origin, receipts, focus: inbox.focus })
}

/**
 * Native operator controls never classify prompt text; Check grants one bounded snapshot.
 * @param ctx - existing host services and live session registry.
 * @param request - browser-fenced JSON operator request.
 * @returns Focus state or a refusal; storage/abort failures may reject without ACK.
 */
export async function controlFocus(ctx: Context, request: Request): Promise<Response> {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return new Response('application/json required', { status: 415 })
  const schema = Schema.object({
    sessionId: Schema.string().min(1).required(),
    action: Schema.union(['inspect', 'set', 'check', 'resume']).required(),
    enabled: Schema.union([Schema.const(undefined), Schema.boolean()]),
    checkId: Schema.union([Schema.const(undefined), Schema.string().min(1).max(256)]),
  })
  let raw: unknown
  try { raw = await request.json() } catch { return new Response('invalid Focus JSON', { status: 400 }) }
  let input: ReturnType<typeof schema>
  try { input = schema(raw as never); assertKeys(raw as object, ['sessionId', 'action', 'enabled', 'checkId']) }
  catch { return new Response('invalid Focus control', { status: 400 }) }
  const agent = ctx.get('agents')?.get(SessionId(input.sessionId))
  if (agent === undefined || agent.wakeInbox === undefined) return new Response('Focus session unavailable', { status: 409 })
  const inbox = agent.inbox.notifications
  if (inbox === undefined) return new Response('Focus driver unavailable', { status: 409 })
  if (input.action === 'inspect') return Response.json(inbox.focus)
  request.signal.throwIfAborted()
  if (input.action === 'resume') {
    if (input.enabled !== undefined || input.checkId !== undefined) return new Response('invalid resume control', { status: 400 })
    if (inbox.resumeOperator === undefined) return new Response('native Stop control unavailable', { status: 409 })
    inbox.resumeOperator()
    return Response.json(inbox.controls)
  }
  if (input.action === 'set') {
    if (input.enabled === undefined) return new Response('enabled required', { status: 400 })
    inbox.setFocus(input.enabled)
    if (!await ctx.get('sessions')?.flush(agent.session)) return new Response('Focus durability unavailable', { status: 503 })
    return Response.json(inbox.focus)
  }
  const checkId = input.checkId
  const wake = agent.wakeInbox.bind(agent)
  if (checkId === undefined) return new Response('checkId required', { status: 400 })
  // Claim the existing maintenance fence atomically; human arrivals and Stop remain immediate and abort this fence.
  if (agent.status !== 'idle') return new Response('Check requires a safe idle boundary', { status: 409 })
  let pending: Promise<Response>
  try {
    pending = agent.runMaintenance(async (signal) => {
      let accepted = false
      try {
        if (!await ctx.get('sessions')?.flush(agent.session)) return new Response('checkpoint durability unavailable', { status: 503 })
        signal.throwIfAborted()
        request.signal.throwIfAborted()
        if (ctx.get('agents')?.get(agent.id) !== agent) return new Response('Focus owner changed', { status: 409 })
        if (inbox.hasForeground) return new Response('foreground input arrived; Check deferred', { status: 409 })
        const messageIds = inbox.check(checkId)
        if (!await ctx.get('sessions')?.flush(agent.session)) return new Response('Check durability unavailable', { status: 503 })
        signal.throwIfAborted()
        request.signal.throwIfAborted()
        accepted = true
        // The snapshot is explicit operator input. No routine held arrival receives a wake.
        if (messageIds.some(id => [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(m => m.id === id && !inbox.isHeld(m)))) wake()
        return Response.json({ ...inbox.focus, messageIds })
      } finally {
        if ((!accepted || signal.aborted || request.signal.aborted || inbox.hasForeground) && inbox.focus.enabled) inbox.setFocus(true)
      }
    })
  } catch {
    // runMaintenance only throws synchronously when another activity owns the idle phase.
    // Async storage/abort errors retain their rejected promise and never receive an accepted ACK.
    return new Response('Check boundary already owned', { status: 409 })
  }
  return pending
}
