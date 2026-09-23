/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-command-compact`.
 * @module @deepseek-ai/dsh-command-compact/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-command-compact'

/** Cordis companion plugin name. */
export const name = 'command-compact-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the compaction seam owns balanced durable transactions and the command
 * registry owns command lifecycle. Optional hand-forward audit state is host-local, not a session
 * projection; checking tool metadata would not establish audit-to-inbox atomicity.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
