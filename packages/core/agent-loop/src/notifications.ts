/** Durable authenticated notification projection for the default loop. */
import type { GatedNotificationBatch, NotificationState } from '@deepseek-ai/dsh-agent'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'

const guardSchema = z.object({
  version: z.literal(1),
  hostEpoch: z.string().min(1),
  bindingEpoch: z.string().min(1),
  activityRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  controlRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()

const admissionSchema = z.object({
  origin: z.string().min(1), sequence: z.string().min(1),
  urgency: z.object({ kind: z.enum(['safety', 'security', 'deadline']), reason: z.string().min(1) }).strict().optional(),
  activityGated: z.literal(true).optional(),
}).strict()

const messageSchema = z.custom<NotificationState['receipts'][number]['message']>(value => z.object({
  id: z.string().min(1), role: z.literal('user'),
  source: z.object({ kind: z.string().min(1) }).passthrough(),
  content: z.array(z.unknown()),
}).passthrough().safeParse(value).success)

/** Validate required custody metadata without treating recorded epochs as live authority. */
export const gatedNotificationBatchSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1).transform(SessionId),
  target: z.enum(['next-turn', 'next-step']),
  guard: guardSchema,
  items: z.array(z.object({
    message: messageSchema,
    admission: admissionSchema.extend({ activityGated: z.literal(true) }),
  }).strict()).min(1).max(10),
}).strict()

/** Retained receipts and Check identities; inherited gated receipts remain non-executable evidence. */
export const notificationProjectionDefinition = {
  key: 'notifications',
  stateVersion: 3,
  stateSchema: z.object({
    inheritedEventCount: z.number().int().nonnegative(),
    enabled: z.boolean(),
    receipts: z.array(z.object({
      target: z.enum(['next-turn', 'next-step']),
      message: z.custom<NotificationState['receipts'][number]['message']>(),
      admission: admissionSchema,
      activityGate: z.object({ sessionId: z.string().min(1).transform(SessionId), guard: guardSchema }).strict().optional(),
    }).superRefine((receipt, ctx) => {
      if ((receipt.admission.activityGated === true) !== (receipt.activityGate !== undefined)) {
        ctx.addIssue({ code: 'custom', message: 'gated receipt requires its complete activity tuple' })
      }
    })).readonly(),
    entered: z.array(z.string()).readonly(),
    terminal: z.array(z.object({ messageId: z.string(), reason: z.enum(['rejected', 'discarded', 'disposed']) })).readonly(),
    released: z.array(z.string()).readonly(),
    checks: z.array(z.object({ id: z.string().min(1), messageIds: z.array(z.string()).max(10).readonly() })).readonly(),
  }),
  init: (_header, inheritedEventCount): NotificationState => ({
    inheritedEventCount, enabled: false, receipts: [], entered: [], terminal: [], released: [], checks: [],
  }),
  apply(state: NotificationState, event) {
    if (event.type === 'agent/notification/activity-gated') {
      gatedNotificationBatchSchema.parse(event.data)
      if (event.ignorable === true) throw new Error('gated custody cannot be ignorable')
      const { target, guard, sessionId, items }: GatedNotificationBatch = event.data
      const receipts = [...state.receipts]
      for (const { message, admission } of items) {
        if (receipts.some(r => r.message.id === message.id
          || (r.admission.origin === admission.origin && r.admission.sequence === admission.sequence))) throw new Error('duplicate gated custody identity')
        receipts.push({ target, message, admission, activityGate: { sessionId, guard } })
      }
      return { ...state, receipts }
    }
    if (event.seq < state.inheritedEventCount) return state
    if (event.type === 'user/message' && state.receipts.some(r => r.message.id === event.data.id)) return { ...state, entered: [...state.entered, event.data.id] }
    if (event.type === 'agent/notification/terminal') {
      const { messageIds, reason } = event.data
      if (!['rejected', 'discarded', 'disposed'].includes(reason) || !Array.isArray(messageIds)
        || messageIds.some(id => typeof id !== 'string' || !state.receipts.some(r => r.message.id === id))) throw new Error('invalid notification disposition')
      const terminal = [...state.terminal]
      for (const messageId of messageIds) {
        if (!terminal.some(item => item.messageId === messageId)) terminal.push({ messageId, reason })
      }
      return { ...state, terminal }
    }
    if (event.type === 'agent/focus') {
      const { enabled, check } = event.data
      if (typeof enabled !== 'boolean' || (check !== undefined && (typeof check.id !== 'string' || !check.id || !Array.isArray(check.messageIds) || check.messageIds.length > 10 || check.messageIds.some(id => typeof id !== 'string')))) throw new Error('invalid persisted Focus control')
      const prior = check === undefined ? undefined : state.checks.find(c => c.id === check.id)
      if (prior !== undefined && JSON.stringify(prior.messageIds) !== JSON.stringify(check?.messageIds)) throw new Error('conflicting persisted Check')
      return { ...state, enabled,
        released: check === undefined ? (enabled ? [] : state.released) : [...state.released, ...check.messageIds],
        checks: check === undefined || prior !== undefined ? state.checks : [...state.checks, check] }
    }
    if (event.type !== 'agent/inbox/spliced' || event.data.notification === undefined) return state
    const { notification: admission, target, inserted } = event.data
    admissionSchema.parse(admission)
    const prior = state.receipts.find(r => r.admission.origin === admission.origin && r.admission.sequence === admission.sequence)
    if (admission.activityGated === true) {
      if (prior?.activityGate === undefined || prior.target !== target || inserted.length !== 1
        || JSON.stringify(prior.message) !== JSON.stringify(inserted[0])
        || JSON.stringify(prior.admission) !== JSON.stringify(admission)) throw new Error('gated splice lacks matching custody')
      return state
    }
    if (!admission.origin || !admission.sequence || inserted.length !== 1 || prior !== undefined) throw new Error('invalid persisted notification receipt')
    const message = inserted[0]
    if (message === undefined) throw new Error('notification requires a message')
    return { ...state, receipts: [...state.receipts, { target, message, admission }] }
  },
} satisfies ProjectionDefinition<'notifications', NotificationState>
