/** Assembled: built native Host + real forge-agent-os maintenance adapter (step70). Skips without DSH_FAO_LIB. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

it.skipIf(!process.env.DSH_FAO_LIB)('closes the built Host via the real adapter without cancelling the active caller, starts exactly one successor through the shipped composer, survives Host restart, releases', async () => {
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
  // One caller turn + one successor turn; the successor is never re-prompted on retry or restart.
  expect(snapshot).toMatchObject({ closedWhileCallerActive: true, callerCompleted: true, reopenedAfterRelease: true, modelTurns: 2 })
  expect(snapshot.phases.close.drain.verdict).not.toBe('idle')
  expect(snapshot.phases.close.record).toBe('native_closed')
  expect(snapshot.phases.probe.drain).toMatchObject({ verdict: 'unknown', unknown: ['provider-backends'] })
  expect(snapshot.phases.drain).toMatchObject({ result: 'drained', record: 'native_drained' })
  expect(snapshot.phases.claim).toMatchObject({ same: true, record: 'successor_claimed' })
  expect(snapshot.phases.claim.session).toMatch(/^successor-[a-f0-9]{64}$/)
  // Shipped maintenance.staged.patch.yml composes maintenanceSuccessorSetup: a started ACK, not accepted-intent.
  const id = snapshot.phases.claim.session
  expect(snapshot.phases.start).toMatchObject({ result: 'started', record: 'successor_started', session: id })
  expect(['started', 'complete']).toContain(snapshot.phases.start.successor.status)
  expect(snapshot.phases['start-retry']).toMatchObject({ result: 'started', record: 'successor_started', session: id })
  expect(snapshot.successor).toMatchObject({
    id, liveAfterStart: true, closedAfterRestart: true, sameAfterRestart: true,
    restartModelTurns: 0, successorModelTurns: 1, sessionFiles: 1, sessionLogs: 1, batonMessages: 1, bindings: 1,
    binding: { owner: 'fao:owner', runId: 'step70-assembled', launch: { agentPreset: 'default', provider: 'keyless-maint', model: 'scripted', cwd: '/tmp' } },
  })
  // The fresh successor carries project, release, ledger cursor, evidence refs, obligations and lineage.
  expect(snapshot.successor.baton).toMatchObject({
    project: 'mesh-dsh-merge', cursor: '71', release: { target: '0.2.0-rc.2' },
    evidence_refs: ['docs/evidence/mesh-dsh-step70-142247.md'], obligations: expect.arrayContaining([expect.any(String)]),
    lineage: { run_id: 'step70-assembled', predecessor_session: 'caller-agent' },
  })
  expect(snapshot.successor.binding.batonDigest).toBe(snapshot.phases.claim.digest)
  expect(snapshot.phases['early-external-release'].refused).toBe('ExternalAdmissionRefused')
  expect(snapshot.phases.release).toMatchObject({ record: 'external_released', released_for: 'successor',
    prior_pauses: { registry: true, notifier: false, 'mesh-pump': true } })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
