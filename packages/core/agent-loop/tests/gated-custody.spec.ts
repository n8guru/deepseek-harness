/** Persistence-boundary checks: separate Node owners share only an isolated JSONL directory. */
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const driver = fileURLToPath(new URL('./gated-custody-driver.ts', import.meta.url))
const tsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
async function run(root: string, mode: string) {
  return exec(process.execPath, ['--import', 'tsx/esm', driver, root, mode], {
    env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig },
    timeout: 30_000,
  })
}

async function logFile(root: string) {
  const files = (await readdir(root, { recursive: true })).filter(path => path.endsWith('.jsonl'))
  expect(files).toHaveLength(1)
  return join(root, files[0]!)
}

it('recovers a torn final splice from the original required ordered custody event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gated-torn-'))
  try {
    await run(root, 'seed')
    const path = await logFile(root)
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    const tail = lines.pop()!
    await writeFile(path, lines.join('\n') + '\n' + tail.slice(0, Math.floor(tail.length / 2)))
    expect((await run(root, 'read')).stdout).toContain('RESTART_HELD')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60_000)

it.each([
  ['unknown-event', /SessionFormatUnsupportedError:.*activity-gated-future.*unknown to this harness and not marked ignorable/],
  ['unknown-version', /"path":\s*\[\s*"version"\s*\]/],
  ['missing-binding', /"path":\s*\[\s*"guard"\s*\]/],
  ['missing-custody', /gated splice lacks matching custody/],
  ['missing-receipt', /pending notification lacks its receipt/],
  ['ignorable-custody', /gated custody cannot be ignorable/],
] as const)('refuses incompatible persisted gated state: %s', async (mode, diagnostic) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gated-corrupt-'))
  try {
    await run(root, 'seed')
    const path = await logFile(root)
    const rows: { type?: string; seq?: number; ignorable?: boolean; data: Record<string, unknown> }[] = (await readFile(path, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
    const index = rows.findIndex(row => row.type === 'agent/notification/activity-gated')
    const row = rows[index]!
    if (mode === 'unknown-event') row.type = 'agent/notification/activity-gated-future'
    if (mode === 'unknown-version') row.data['version'] = 2
    if (mode === 'missing-binding') delete row.data['guard']
    if (mode === 'ignorable-custody') row.ignorable = true
    if (mode === 'missing-custody' || mode === 'missing-receipt') {
      rows.splice(index, 1)
      for (const later of rows.slice(index)) if (later.seq !== undefined) later.seq--
    }
    if (mode === 'missing-receipt') {
      for (const event of rows) {
        if (event.type !== 'agent/inbox/spliced') continue
        delete event.data['notification']
        const inserted = event.data['inserted']
        if (!Array.isArray(inserted)) continue
        for (const message of inserted) {
          message.source = { kind: 'notification', origin: 'native:custody-test', form: 'notice', summary: 'Receipt removed' }
        }
      }
    }
    await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    const failure: unknown = await run(root, 'read').then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    // Launch failures, timeouts and signals are not evidence of fail-closed replay.
    expect(failure).toMatchObject({ code: 1, killed: false, signal: null, stderr: expect.stringMatching(diagnostic) })
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60_000)

it('does not acknowledge an ambiguous flush even when JSONL has retained custody', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gated-ambiguous-'))
  try {
    const { stdout } = await run(root, 'ambiguous-flush')
    expect(stdout).toContain('CUSTODY_REFUSED')
    expect(stdout).not.toContain('CUSTODY_HELD')
    expect((await run(root, 'read')).stdout).toContain('RESTART_HELD')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60_000)

it('reloads terminal receipts as evidence only, never delivery or executable replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gated-terminal-'))
  try {
    await run(root, 'terminal-seed')
    expect((await run(root, 'terminal-read')).stdout).toContain('RESTART_HELD')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60_000)

it.each(['seed', 'custody-only', 'fsync-failure'])('retains exact ordered gated custody across a fresh process: %s', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gated-custody-'))
  try {
    expect((await run(root, mode)).stdout).toContain('CUSTODY_HELD')
    expect((await run(root, 'read')).stdout).toContain('RESTART_HELD')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60_000)
