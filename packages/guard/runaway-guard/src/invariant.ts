/** Package-owned invariant companion. @module @deepseek-ai/dsh-runaway-guard/invariant */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-runaway-guard'
export const name = 'runaway-guard-invariant'
export const inject = ['invariants']
// No runtime invariant: behavior is proved at the agent-loop boundary.
const install: InvariantInstaller = () => {}
/** Register package ownership; behavior is proven at the real agent-loop boundary. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
