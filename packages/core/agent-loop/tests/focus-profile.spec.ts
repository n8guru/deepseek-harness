/** Real shipped profile and real built package exports, no TS import resolver or provider keys. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

it('boots the shipped headless profile from built packages and returns Focus to static idle', async () => {
  const driver = fileURLToPath(new URL('./focus-profile-driver.ts', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'built Focus profile',
    tempDirPrefix: 'dsh-built-focus-',
    binScript: driver, libBinScript: driver, mode: 'lib',
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    configPath: 'focus.patch.yml',
    env: { DSH_TELEMETRY_DISABLED: '1' },
    prepare: async cwd => {
      await writeFile(join(cwd, 'focus.patch.yml'), `- id: headless-runner
  disabled: true
- id: headless-startup
  disabled: true
- id: llm-deepseek
  disabled: true
- id: session-title-llm
  disabled: true
- id: plugin-package-inventory-deepseek
  disabled: true
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('sessions')
    compression: none
`)
    },
  })
  const line = result.stdout.split('\n').find(line => line.startsWith('FOCUS_BUILT_SNAPSHOT '))
  expect(line).toBeDefined()
  expect(JSON.parse(line!.slice('FOCUS_BUILT_SNAPSHOT '.length))).toEqual({
    foregroundRequests: 1, checkRequests: 1, staticHoldRequests: 0, lateHeld: 1, goal: 'paused',
  })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it('runs an actual built dsh headless task with Focus-held notifications and goals', async () => {
  const plugin = fileURLToPath(new URL('./focus-cli-plugin.ts', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'actual built CLI Focus',
    tempDirPrefix: 'dsh-built-focus-cli-',
    binScript: fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url)),
    mode: 'lib',
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    configPath: 'cli-focus.patch.yml',
    binArgs: ['--profile', 'headless', '--patch', 'cli-focus.patch.yml', 'foreground obligation'],
    env: { DSH_TELEMETRY_DISABLED: '1' },
    prepare: async cwd => {
      await writeFile(join(cwd, 'cli-focus.patch.yml'), `- id: llm-deepseek
  disabled: true
- id: session-title-llm
  disabled: true
- id: plugin-package-inventory-deepseek
  disabled: true
- id: agent-default-model
  config:
    provider: keyless-cli-focus
    model: scripted
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('sessions')
    compression: none
- insert:
    - id: keyless-cli-focus
      name: ${JSON.stringify(plugin)}
`)
    },
  })
  expect(result.stdout).toContain('CLI foreground checkpoint')
  const line = result.stdout.split('\n').find(line => line.startsWith('FOCUS_CLI_SNAPSHOT '))
  expect(line).toBeDefined()
  expect(JSON.parse(line!.slice('FOCUS_CLI_SNAPSHOT '.length))).toEqual({ foregroundRequests: 1, staticHoldRequests: 0, held: 1 })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it('serves an actual Python caller over loopback HTTP from built packages under Focus, check, maintenance and Stop', async () => {
  const driver = fileURLToPath(new URL('./focus-python-caller-driver.ts', import.meta.url))
  const bearer = 'python-caller-producer-bearer-0123456789'
  const result = await runLoaderSmoke({
    label: 'built Focus Python caller',
    tempDirPrefix: 'dsh-built-focus-py-',
    binScript: driver, libBinScript: driver, mode: 'lib',
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    configPath: 'py-focus.patch.yml',
    binArgs: ['py-focus.patch.yml', bearer],
    env: { DSH_TELEMETRY_DISABLED: '1' },
    prepare: async cwd => {
      const grant = { origin: 'py:caller', bearerSha256: createHash('sha256').update(bearer).digest('hex'), sessionIds: ['py-focus'], urgency: ['safety'] }
      await writeFile(join(cwd, 'py-focus.patch.yml'), `- id: headless-runner
  disabled: true
- id: headless-startup
  disabled: true
- id: llm-deepseek
  disabled: true
- id: session-title-llm
  disabled: true
- id: plugin-package-inventory-deepseek
  disabled: true
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('sessions')
    compression: none
- insert:
    - id: py-webserver
      name: '@deepseek-ai/dsh-host-webserver'
      config:
        host: 127.0.0.1
        port: 0
    - id: py-host-maintenance
      name: '@deepseek-ai/dsh-agent-loop/maintenance'
      config:
        receiptGrants: ${JSON.stringify([{ owner: 'py:caller', kind: 'supervisor', target: { kind: 'agent', sessionId: 'py-focus' } }])}
    - id: py-connection
      name: '@deepseek-ai/dsh-client-connection'
      config:
        notificationProducers: ${JSON.stringify([grant])}
        maintenanceOwners: ["py:caller"]
`)
    },
  })
  const line = result.stdout.split('\n').find(line => line.startsWith('FOCUS_PY_CALLER_SNAPSHOT '))
  expect(line, result.stdout + result.stderr).toBeDefined()
  expect(JSON.parse(line!.slice('FOCUS_PY_CALLER_SNAPSHOT '.length))).toMatchObject({
    phases: ['admit', 'check', 'recheck', 'maintenance'],
    foregroundRequests: 1, checkRequests: 1, staticHoldRequests: 0, lateHeld: 1, heldAfterSupervisorReceipt: 2, goal: 'paused',
  })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
