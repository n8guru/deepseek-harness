/** Actual Loader/profile dependencies, persisted CLOSED control, configured agent and job initializer. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
it('replays CLOSED before configured agent and job admissions through the actual built Loader', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-maintenance-loader-'))
  const driver = fileURLToPath(new URL('./maintenance-boot-driver.ts', import.meta.url))
  const producer = fileURLToPath(new URL('./maintenance-boot-producer.ts', import.meta.url))
  const patch = join(cwd, 'boot.patch.yml')
  await writeFile(patch, `- id: llm-deepseek
  disabled: true
- id: session-title-llm
  disabled: true
- id: plugin-package-inventory-deepseek
  disabled: true
- id: headless-startup
  disabled: true
- id: headless-runner
  disabled: true
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('sessions')
    compression: none
- id: agent-loop
  config:
    agents: !!js "process.env.DSH_BOOT_PROBE === 'closed' ? [{id:'boot-probe',sessionId:'configured-boot-agent'}] : []"
- insert:
    - id: boot-job-producer
      name: ${JSON.stringify(producer)}
      inject: [hostMaintenanceReady, jobs, agentLoop]
`)
  try {
    const options = { label: 'maintenance staged boot', cwd, binScript: driver, libBinScript: driver, mode: 'lib' as const, configPath: patch, tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)) }
    const seeded = await runLoaderSmoke({ ...options, env: { DSH_BOOT_PROBE: 'seed', DSH_TELEMETRY_DISABLED: '1' } })
    expect(seeded.stdout).toContain('CLOSED_SEEDED')
    const resumed = await runLoaderSmoke({ ...options, env: { DSH_BOOT_PROBE: 'closed', DSH_TELEMETRY_DISABLED: '1' } })
    expect(resumed.stdout).toContain('JOB_BOOT_REFUSED')
    expect(resumed.stdout).toContain('BOOT_CLOSED_NO_AGENT')
  } finally { await rm(cwd, { recursive: true, force: true }) }
}, LOADER_SMOKE_TEST_TIMEOUT_MS * 2)
