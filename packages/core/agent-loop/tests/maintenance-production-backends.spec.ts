/** Production route mirror: supported subset drains; the full mirror must refuse the actual unsupported Codex adapter. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

const inventory = JSON.parse(readFileSync(new URL('./fixtures/forge-backend-inventory.json', import.meta.url), 'utf8')) as {
  adapters: { implementation: string; providers: string[]; disposition: string; refusal?: string }[]
}

for (const mode of ['supported-subset', 'full-mirror'] as const) {
  it.skipIf(!process.env.DSH_FAO_LIB || (mode === 'full-mirror' && !process.env.DSH_TEST_CODEX_ENTRY))(
    `production backends: ${mode}`, async () => {
      const driver = fileURLToPath(new URL('./maintenance-adapter-driver.ts', import.meta.url))
      const bearer = 'fao-maintenance-owner-bearer-0123456789abcdef'
      const supported = inventory.adapters.filter(adapter => adapter.disposition === 'backendStatus')
      const pi = supported.find(adapter => adapter.implementation === 'PiAiAdapter')!
      // Same provider routes and real adapter class, inert loopback endpoints and no production keys.
      const providers = Object.fromEntries(pi.providers.map(provider => [provider, {
        api: 'openai-completions', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'STEP99_NO_KEY',
        models: [{ id: 'idle-proof', contextWindow: 4096, maxTokens: 128 }],
      }]))
      const result = await runLoaderSmoke({
        label: `production backend ${mode}`, tempDirPrefix: 'dsh-production-backends-',
        binScript: driver, libBinScript: driver, mode: 'lib',
        tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
        configPath: 'mirror.patch.yml', binArgs: ['mirror.patch.yml', bearer],
        env: {
          DSH_TELEMETRY_DISABLED: '1', DSH_FAO_LIB: process.env.DSH_FAO_LIB!, DSH_TEST_FORGE_MIRROR: mode,
          DSH_TEST_CODEX_ENTRY: mode === 'full-mirror' ? process.env.DSH_TEST_CODEX_ENTRY! : undefined,
        },
        prepare: async (cwd) => {
          const grant = { origin: 'fao:owner', bearerSha256: createHash('sha256').update(bearer).digest('hex'), sessionIds: ['caller-agent'], urgency: [] }
          await writeFile(join(cwd, 'mirror.patch.yml'), `- id: headless-runner
  disabled: true
- id: headless-startup
  disabled: true
# This older checkpoint ships an account adapter absent from the observed production profile.
- id: llm-deepseek-account
  disabled: true
- id: llm-pi-ai
  config:
    providers: ${JSON.stringify(providers)}
- id: session-persistence-jsonl
  config:
    root: !!js dshHomePath('sessions')
    compression: none
- insert:
    - id: maint-webserver
      name: '@deepseek-ai/dsh-host-webserver'
      config: { host: 127.0.0.1, port: 0 }
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
      console.log('PRODUCTION_BACKENDS_SNAPSHOT ' + JSON.stringify({ mode, ...snapshot }))
      const expected = (mode === 'full-mirror' ? inventory.adapters : supported).flatMap(adapter => adapter.providers).sort()
      expect(snapshot.registeredProviders).toEqual(expected)
      expect(snapshot).toMatchObject({ closedWhileCallerActive: true, callerCompleted: true, reopenedAfterRelease: true, modelTurns: 1 })
      for (const provider of supported.flatMap(adapter => adapter.providers)) {
        expect(snapshot.coverageAt.settled.find((p: { providers: string[] }) => p.providers.includes(provider)), provider)
          .toMatchObject({ refusal: null, reason: null, joined: 'JOINED' })
      }
      if (mode === 'supported-subset') {
        expect(snapshot.phases.drain).toMatchObject({ result: 'drained', record: 'native_drained' })
      } else {
        const codex = snapshot.coverageAt.settled.find((p: { providers: string[] }) => p.providers.includes('openai-codex'))
        expect(codex).toMatchObject({ refusal: 'unsupported', reason: 'backend settlement unsupported', joined: null })
        expect(snapshot.phases.drain).toMatchObject({ result: 'refused', record: 'native_closed', last: { verdict: 'unknown', unknown: ['provider-backends'] } })
        // The HTTP status must carry the same named, typed refusal, not just a generic unknown gate.
        expect(snapshot.wireStatus.activity.providerBackends).toMatchObject({ state: 'UNKNOWN' })
        expect(snapshot.wireStatus.activity.providerBackends.participants.find((p: { providers: string[] }) => p.providers.includes('openai-codex')))
          .toMatchObject({ refusal: 'unsupported', providers: ['openai-codex'] })
        expect(JSON.stringify(snapshot.phases.drain.last)).toContain('openai-codex')
        expect(JSON.stringify(snapshot.phases.drain.last)).toContain('unsupported')
        expect(snapshot.phases.claim).toBeUndefined()
        expect(snapshot.phases.start).toBeUndefined()
      }
      expect(snapshot.phases['early-external-release'].refused).toBe('ExternalAdmissionRefused')
      expect(snapshot.phases['rollback-release']).toMatchObject({ record: 'external_released', released_for: 'rollback' })
    }, LOADER_SMOKE_TEST_TIMEOUT_MS,
  )
}
