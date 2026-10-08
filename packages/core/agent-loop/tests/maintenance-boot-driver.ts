/** Plain-Node built Loader restart probe, no source aliases or real providers. */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bootProductionProfile } from '../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'
const overlay = process.argv[2]
if (overlay === undefined) throw new Error('expected staged overlay')
const ctx = await bootProductionProfile({ binName: 'maintenance-boot', profile: 'headless', overlayPaths: [
  resolve(new URL('../maintenance.staged.patch.yml', import.meta.url).pathname),
  resolve(overlay),
] })
try {
  if (process.env.DSH_BOOT_PROBE === 'seed') {
    await ctx.hostMaintenance.receive('boot-owner', { action: 'close', runId: 'boot-run' })
    const status = await ctx.hostMaintenance.receive('boot-owner', { action: 'status', runId: 'boot-run' })
    for (const group of ['jobs-global', 'delegates-global', 'workflows-global', 'preclose-publications']) {
      assert.equal(status.activity.unknownParticipants.includes(group), false, 'Loader coverage missing: ' + group)
    }
    console.log('CLOSED_SEEDED')
  } else {
    assert.equal(ctx.hostMaintenanceReady.open, false)
    const run = await ctx.hostMaintenance.receive('boot-owner', { action: 'status', runId: 'boot-run' })
    assert.equal(run.phase, 'closed')
    assert.equal(ctx.agents.get(SessionId('configured-boot-agent')), undefined)
    assert.equal(ctx.sessions.get(SessionId('configured-boot-agent')), undefined)
    console.log('BOOT_CLOSED_NO_AGENT')
  }
} finally { await ctx.fiber.dispose() }
