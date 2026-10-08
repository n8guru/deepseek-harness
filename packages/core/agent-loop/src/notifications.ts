/** Durable authenticated notification projection for the default loop. */
import type { NotificationState } from '@deepseek-ai/dsh-agent'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

/** Retained producer receipts and fixed Check identities, excluding inherited fork events. */
export const notificationProjectionDefinition = {
  key: 'notifications',
  stateVersion: 2,
  stateSchema: z.object({
    inheritedEventCount: z.number().int().nonnegative(),
    enabled: z.boolean(),
    receipts: z.array(z.object({
      target: z.enum(['next-turn', 'next-step']),
      message: z.custom<NotificationState['receipts'][number]['message']>(),
      admission: z.object({
        origin: z.string().min(1), sequence: z.string().min(1),
        urgency: z.object({ kind: z.enum(['safety', 'security', 'deadline']), reason: z.string().min(1) }).optional(),
      }),
    })).readonly(),
    entered: z.array(z.string()).readonly(),
    terminal: z.array(z.object({ messageId: z.string(), reason: z.enum(['rejected', 'discarded', 'disposed']) })).readonly(),
    released: z.array(z.string()).readonly(),
    checks: z.array(z.object({ id: z.string().min(1), messageIds: z.array(z.string()).max(10).readonly() })).readonly(),
  }),
  init: (_header, inheritedEventCount): NotificationState => ({ inheritedEventCount, enabled: false, receipts: [], entered: [], terminal: [], released: [], checks: [] }),
  apply(state: NotificationState, event) {
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
    if (!admission.origin || !admission.sequence || inserted.length !== 1 || state.receipts.some(r => r.admission.origin === admission.origin && r.admission.sequence === admission.sequence)) throw new Error('invalid persisted notification receipt')
    const message = inserted[0]
    if (message === undefined) throw new Error('notification requires a message')
    return { ...state, receipts: [...state.receipts, { target, message, admission }] }
  },
} satisfies ProjectionDefinition<'notifications', NotificationState>
