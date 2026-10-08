/**
 * Keyless artifact-plane receiver/restart proof. Direct service calls are NOT
 * authenticated transport evidence; no server, credentials, or activation.
 */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const self = fileURLToPath(import.meta.url)
const load = path => import(pathToFileURL(join(root, path)))
const { boot } = await load('packages/boot/app-boot/lib/index.js')
const { SessionId } = await load('packages/core/session/lib/index.js')

if (process.argv[2] === '--child') {
  const [directory, phase] = process.argv.slice(3)
  // No automatic producers are mounted before boot() settles. This demonstrates
  // the receiver's replay barrier, not arbitrary plugin load-order safety.
  const rows = [
    ['maintenance', 'packages/core/agent-loop/lib/maintenance.js'],
    ['agents', 'packages/core/agent/lib/index.js', { admissionClosed: false }],
    ['persistence', 'packages/session/session-persistence-jsonl/lib/index.js', { root: join(directory, 'sessions') }],
    ['sessions', 'packages/core/session/lib/index.js'],
    ['llm', 'packages/llm/llm/lib/index.js'],
    ['prompt', 'packages/core/system-prompt/lib/index.js'],
    ['tools', 'packages/core/tools/lib/index.js'],
    ['loop', 'packages/core/agent-loop/lib/index.js', { agents: [] }],
  ].map(([id, path, config]) => ({ id, name: join(root, path), ...(config ? { config } : {}) }))
  const config = join(directory, 'receiver.json')
  await writeFile(config, JSON.stringify(rows))
  const ctx = await boot('old-maintenance-isolated', config, [])
  try {
    if (phase === 'close') {
      assert.equal(ctx.hostAdmission.open, true)
      const result = await ctx.hostMaintenance.receive('fixture-owner', { runId: 'fixture-run', action: 'close' })
      assert.equal(result.run.phase, 'closed')
    } else if (phase === 'release') {
      assert.equal(ctx.hostAdmission.open, false)
      assert.throws(() => ctx.agentLoop.create(SessionId('denied-after-restart')), /CLOSED/)
      await assert.rejects(ctx.hostMaintenance.receive('other-owner', { runId: 'fixture-run', action: 'release' }), /another owner/)
      await assert.rejects(ctx.hostMaintenance.receive('fixture-owner', { runId: 'fixture-run', action: 'status', owner: 'forged' }), /refused/)
      await ctx.hostMaintenance.receive('fixture-owner', { runId: 'fixture-run', action: 'release' })
      assert.equal(ctx.hostAdmission.open, false)
    } else {
      assert.equal(phase, 'released-boot')
      assert.equal(ctx.hostAdmission.open, true)
      await assert.rejects(ctx.hostMaintenance.receive('fixture-owner', { runId: 'fixture-run', action: 'close' }), /already released/)
    }
    console.log(JSON.stringify({ phase, open: ctx.hostAdmission.open, transportAuthentication: 'NOT_TESTED' }))
  } finally { await ctx.fiber.dispose() }
} else {
  const directory = await mkdtemp(join(tmpdir(), 'step73-old-maint-loader-'))
  try {
    for (const phase of ['close', 'release', 'released-boot']) {
      const child = spawnSync(process.execPath, [self, '--child', directory, phase], {
        encoding: 'utf8', timeout: 30000,
        env: { PATH: process.env.PATH, HOME: directory, DSH_HOME: directory },
      })
      process.stdout.write(child.stdout ?? '')
      process.stderr.write(child.stderr ?? '')
      assert.equal(child.status, 0, child.error?.message ?? `receiver child ${phase} failed`)
    }
    console.log('REBUILT_OLD_DURABLE_RECEIVER_THREE_FRESH_PROCESSES_NO_AUTHENTICATION_CLAIM')
  } finally { await rm(directory, { recursive: true, force: true }) }
}
