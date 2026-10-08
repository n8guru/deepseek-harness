/** Assembled: built native Host + real forge-agent-os maintenance adapter (step70). Skips without DSH_FAO_LIB. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

it.skipIf(!process.env.DSH_FAO_LIB)('closes the built Host via the real adapter without cancelling the active caller, one successor claim, rollback release', async () => {
  const driver = fileURLToPath(new URL('./maintenance-adapter-driver.ts', import.meta.url))
  const bearer = 'fao-maintenance-owner-bearer-0123456789abcdef'
  const result = await runLoaderSmoke({
    label: 'built maintenance adapter',
    tempDirPrefix: 'dsh-built-maint-adapter-',
    binScript: driver, libBinScript: driver, mode: 'lib',
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    configPath: 'maint.patch.yml',
    binArgs: ['maint.patch.yml', bearer],
    env: { DSH_TELEMETRY_DISABLED: '1', DSH_FAO_LIB: process.env.DSH_FAO_LIB! },
    prepare: async (cwd) => {
      const grant = { origin: 'fao:owner', bearerSha256: createHash('sha256').update(bearer).digest('hex'), sessionIds: ['caller-agent'], urgency: [] }
      await writeFile(join(cwd, 'maint.patch.yml'), `- id: headless-runner
  disabled: true
- id: headless-startup
  disabled: true
- id: llm-deepseek
  disabled: true
- id: session-title-llm
  disabled: true
- id: llm-deepseek-account
  disabled: true
- id: plugin-package-inventory-deepseek
  disabled: true
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('sessions')
    compression: none
- id: host-maintenance
  config:
    successor: { owner: 'fao:owner', agentPreset: 'default', provider: 'keyless-maint', model: 'scripted', cwd: '/tmp' }
- insert:
    - id: maint-webserver
      name: '@deepseek-ai/dsh-host-webserver'
      config:
        host: 127.0.0.1
        port: 0
    - id: maint-connection
      name: '@deepseek-ai/dsh-client-connection'
      config:
        notificationProducers: ${JSON.stringify([grant])}
        maintenanceOwners: ["fao:owner"]
`)
    },
  })
  const line = result.stdout.split('\n').find(entry => entry.startsWith('MAINT_ADAPTER_SNAPSHOT '))
  expect(line, result.stdout + result.stderr).toBeDefined()
  const snapshot = JSON.parse(line!.slice('MAINT_ADAPTER_SNAPSHOT '.length))
  console.log('MAINT_ADAPTER_SNAPSHOT ' + JSON.stringify(snapshot))
  expect(snapshot).toMatchObject({ closedWhileCallerActive: true, callerCompleted: true, reopenedAfterRelease: true, modelTurns: 1 })
  expect(snapshot.phases.close.drain.verdict).not.toBe('idle')
  expect(snapshot.phases.close.record).toBe('native_closed')
  expect(snapshot.phases.probe.drain).toMatchObject({ verdict: 'unknown', unknown: ['provider-backends'] })
  expect(snapshot.phases.drain).toMatchObject({ result: 'drained', record: 'native_drained' })
  expect(snapshot.phases.claim).toMatchObject({ same: true, record: 'successor_claimed' })
  expect(snapshot.phases.claim.session).toMatch(/^successor-[a-f0-9]{64}$/)
  // Shipped profile provides no maintenanceSuccessorSetup composer: durable intent only, never a started ACK.
  expect(snapshot.phases.start).toMatchObject({ result: 'refused', record: 'successor_claimed' })
  expect(snapshot.phases.start.successor.status).toBe('accepted-intent')
  expect(snapshot.phases['early-external-release'].refused).toBe('ExternalAdmissionRefused')
  expect(snapshot.phases['rollback-release']).toMatchObject({ record: 'external_released', released_for: 'rollback',
    prior_pauses: { registry: true, notifier: false, 'mesh-pump': true } })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
