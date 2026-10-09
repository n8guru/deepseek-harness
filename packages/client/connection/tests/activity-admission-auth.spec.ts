/** Producer grant changes during body parsing must precede all native reads or writes. */
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { admitNotifications, type NotificationProducer } from '../src/notification-admission.ts'

for (const change of ['remove-producer', 'revoke-read', 'revoke-gating', 'remove-session'] as const) {
  it(`refuses a producer grant changed during body parsing: ${change}`, async () => {
    const ctx = new Context()
    const bearer = 'activity-admission-auth-12345678901234567890'
    const producer: NotificationProducer = {
      origin: 'test:auth', bearerSha256: createHash('sha256').update(bearer).digest('hex'),
      sessionIds: ['auth-session'], urgency: [], activityRead: true, activityGated: true,
    }
    const producers = [producer]
    const body = Promise.withResolvers<unknown>()
    const request = new Request('http://localhost/api/notifications.admit', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    })
    vi.spyOn(request, 'json').mockImplementation(() => body.promise)
    const get = vi.spyOn(ctx, 'get')
    try {
      const pending = admitNotifications(ctx, request, producers)
      if (change === 'remove-producer') producers.splice(0)
      if (change === 'revoke-read') producer.activityRead = false
      if (change === 'revoke-gating') producer.activityGated = false
      if (change === 'remove-session') producer.sessionIds.splice(0)
      body.resolve({
        sessionId: 'auth-session',
        activityGuard: { version: 1, hostEpoch: 'host', bindingEpoch: 'binding', activityRevision: 0, controlRevision: 0 },
        items: [{ sequence: 'one', text: 'background evidence' }],
      })
      const response = await pending
      expect(response.status).toBe(403)
      expect(await response.text()).toBe('notification grant changed')
      expect(get).not.toHaveBeenCalled()
    } finally {
      get.mockRestore()
      await ctx.fiber.dispose()
    }
  })
}
