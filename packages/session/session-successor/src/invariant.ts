/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-session-successor`.
 * @module @deepseek-ai/dsh-session-successor/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-successor'

/** Cordis companion plugin name. */
export const name = 'session-successor-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Durable lineage invariant, whichever writer produced the event: a session
 * log carries at most one `session/successor` event, and it never names the
 * session itself.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  // internal/dispatch interception rejects the append before publication.
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'session/successor') return
    if (event.data.successorSessionId === session.id) {
      fail(`session/successor event ${String(event.seq)} names its own session "${session.id}"`)
    }
    const prior = session.events.find(other => other.type === 'session/successor' && other.seq !== event.seq)
    if (prior !== undefined) {
      fail(`session/successor event ${String(event.seq)} would be a second successor (first at seq ${String(prior.seq)})`)
    }
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
