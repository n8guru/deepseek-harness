/** A real Loader initializer attempting a job after its declared replay dependency. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../../jobs/jobs/src/index.ts'
import type {} from '../src/maintenance.ts'
export const inject = ['hostMaintenanceReady', 'jobs', 'agentLoop']
export function apply(ctx: Context): void {
  if (process.env.DSH_BOOT_PROBE !== 'closed') return
  assert.equal(ctx.hostMaintenanceReady.open, false)
  let effects = 0
  assert.throws(() => ctx.jobs.start({ kind: 'bash', label: 'must not start', run: () => {
    effects += 1
    return { done: Promise.resolve({ status: 'completed', result: '' }), cancel: () => {} }
  } }), /admission closed/)
  assert.equal(effects, 0)
  console.log('JOB_BOOT_REFUSED')
}
