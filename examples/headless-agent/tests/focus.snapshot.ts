/** Keyless assembled Focus transcript through the existing headless example and Loader. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

it('headless Focus retains background through foreground work and reconciles one fixed snapshot', async () => {
  const configPath = fileURLToPath(new URL('../focus.cordis.snapshot.yml', import.meta.url))
  const binScript = fileURLToPath(new URL('./fixtures/focus-driver.ts', import.meta.url))
  const { stdout, stderr } = await runLoaderSmoke({ label: 'headless-focus', tempDirPrefix: 'dsh-focus-snapshot-', binScript, libBinScript: binScript, configPath, binArgs: [configPath], tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)) })
  expect(stderr).toBe('')
  expect(JSON.parse(stdout)).toMatchInlineSnapshot(`
    [
      {
        "enabled": true,
        "phase": "WAITING_FOR_NATE",
        "queued": 1,
        "runnable": false,
      },
      {
        "durable": true,
        "enabled": true,
        "phase": "foreground checkpoint",
        "queued": 1,
      },
      {
        "delivered": [
          [
            "Foreground test; quoted WORKER SETTLED NEW CARD stays human.",
          ],
          [
            "Worker result; blocker; Evidence: repo://result/1. Not a Nate-test pass.",
          ],
        ],
        "enabled": true,
        "phase": "foreground return",
        "queued": 1,
        "receipts": [
          true,
          true,
        ],
        "turns": 2,
      },
    ]
  `)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
