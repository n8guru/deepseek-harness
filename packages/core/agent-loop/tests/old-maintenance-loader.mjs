/** Keyless fresh-process proof through the rebuilt old Loader and its existing HTTP bridge. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
// PUBLIC FIXTURE ONLY. Never read deployment credentials or contact a live server.
const bearer = 'PUBLIC-OLD-MAINTENANCE-FIXTURE-BEARER-142320'
const otherBearer = 'PUBLIC-OLD-MAINTENANCE-OTHER-BEARER-142320'
const grant = (origin, token) => ({
  origin, bearerSha256: createHash('sha256').update(token).digest('hex'),
  sessionIds: ['fixture-unused'], urgency: [],
})

if (process.argv[2] === '--child') {
  const [directory, phase] = process.argv.slice(3)
  const rows = [
    // Deliberately register native producers before the receiver; the registry
    // barrier, not configuration row ordering, prevents premature admission.
    ['agents', 'packages/core/agent/lib/index.js', { maintenanceReplay: true }],
    ['sessions', 'packages/core/session/lib/index.js'],
    ['llm', 'packages/llm/llm/lib/index.js'],
    ['prompt', 'packages/core/system-prompt/lib/index.js'],
    ['tools', 'packages/core/tools/lib/index.js'],
    ['loop', 'packages/core/agent-loop/lib/index.js', { agents: [] }],
    ['web', 'packages/host/webserver/lib/index.js', { host: '127.0.0.1', port: 0 }],
    ['connection', 'packages/client/connection/lib/index.js', {
      notificationProducers: [grant('fixture-owner', bearer), grant('ungranted-owner', otherBearer)],
      maintenanceOwners: ['fixture-owner'],
    }],
    ['persistence', 'packages/session/session-persistence-jsonl/lib/index.js', { root: join(directory, 'sessions') }],
    ['maintenance', 'packages/core/agent-loop/lib/maintenance.js'],
  ].map(([id, path, config]) => ({ id, name: join(root, path), ...(config ? { config } : {}) }))
  const config = join(directory, 'receiver.json')
  await writeFile(config, JSON.stringify(rows))
  const ctx = await boot('old-maintenance-isolated', config, [])
  try {
    const url = `http://127.0.0.1:${ctx.webServer.port}/api/maintenance.receive`
    const call = (body, token = bearer, headers = {}) => fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: JSON.stringify(body),
    })
    const command = action => ({ runId: 'fixture-run', action })
    assert.equal((await call(command('close'), null, { cookie: `dsh_session=${bearer}` })).status, 403)
    assert.equal((await call(command('close'), 'invalid')).status, 403)
    assert.equal((await call(command('close'), otherBearer)).status, 403)
    assert.equal((await call({ ...command('close'), owner: 'forged' })).status, 409)
    assert.equal((await call(command('close'), bearer, { origin: 'https://attacker.invalid' })).status, 403)
    assert.equal((await call(command('close'), bearer, { 'content-type': 'text/plain' })).status, 415)
    assert.equal((await fetch(url, { headers: { authorization: `Bearer ${bearer}` } })).status, 405)
    if (phase === 'close') {
      assert.equal(ctx.hostAdmission.open, true)
      const result = await call(command('close'))
      assert.equal(result.status, 200)
      const state = await result.json()
      assert.equal(state.run.owner, 'fixture-owner')
      assert.equal(state.run.phase, 'closed')
      assert.equal((await call(command('close'))).status, 200)
      assert.equal((await ctx.sessionPersistence.inspect(SessionId('old-host-maintenance-control'))).events.length, 1)
    } else if (phase === 'release') {
      assert.equal(ctx.hostAdmission.open, false)
      assert.throws(() => ctx.agentLoop.create(SessionId('denied-after-restart')), /CLOSED/)
      assert.equal((await call(command('status'))).status, 200)
      assert.equal((await call(command('release'))).status, 200)
      assert.equal((await call(command('release'))).status, 200)
      assert.equal((await ctx.sessionPersistence.inspect(SessionId('old-host-maintenance-control'))).events.length, 2)
      assert.equal(ctx.hostAdmission.open, false)
    } else {
      assert.equal(phase, 'released-boot')
      assert.equal(ctx.hostAdmission.open, true)
      assert.equal((await call(command('close'))).status, 409)
    }
    console.log(JSON.stringify({ phase, open: ctx.hostAdmission.open, transportAuthentication: 'CONFIGURED_SHA256_BEARER_PUBLIC_FIXTURE' }))
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
    console.log('REBUILT_OLD_AUTHENTICATED_RECEIVER_THREE_FRESH_PROCESSES')
  } finally { await rm(directory, { recursive: true, force: true }) }
}
