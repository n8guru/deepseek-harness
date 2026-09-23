import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { openAudit, atomicState } from '../src/baton-audit.ts'

const faults = vi.hoisted(() => ({ failRename: false }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, rename: async (...args: Parameters<typeof fs.rename>) => {
    if (faults.failRename) throw new Error('fixture crash before rename')
    return fs.rename(...args)
  } }
})

const directories: string[] = []
afterEach(async () => {
  faults.failRename = false
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'baton-audit-'))
  directories.push(path)
  return path
}

it('keeps the prior complete snapshot when replacement fails, then persists journal and pending together', async () => {
  const dir = await directory()
  const journal = await openAudit(dir, 5000, (error) => { throw error })
  try {
    await journal.record({ generation: 1, status: 'scheduled' }, true)
    const path = join(dir, 'baton-state.json')
    const before = await readFile(path, 'utf8')
    faults.failRename = true
    await expect(journal.record({ generation: 1, status: 'bootstrap-queued' }, false)).rejects.toThrow('before rename')
    expect(await readFile(path, 'utf8')).toBe(before)
    faults.failRename = false
    await journal.record({ generation: 1, status: 'bootstrap-queued' }, false)
    expect(JSON.parse(await readFile(path, 'utf8')) as unknown).toMatchObject({
      owner_epoch: 1, pending: null, records: [{ status: 'scheduled' }, { status: 'bootstrap-queued' }],
    })
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
  } finally { await journal.release() }
})

it('recovers abandoned pending state only after acquiring the kernel writer reservation', async () => {
  const dir = await directory()
  const path = join(dir, 'baton-state.json')
  await atomicState(path, {
    version: 2, owner_epoch: 7, records: [{ generation: 7, status: 'scheduled' }],
    pending: { token: 'crashed-owner', since: Date.now() - 20000, owner_epoch: 7 },
  })
  const journal = await openAudit(dir, 5000, (error) => { throw error })
  try {
    expect(journal.generation).toBe(8)
    expect(journal.epoch).toBe(8)
    const state = JSON.parse(await readFile(path, 'utf8')) as { pending: unknown; records: { status: string; reason: string }[] }
    expect(state.pending).toBeNull()
    expect(state.records.at(-1)?.status).toBe('recovered')
    expect(state.records.at(-1)?.reason).toContain('not replayed')
    await expect(openAudit(dir, 5000, (error) => { throw error })).rejects.toMatchObject({ code: 'ELOCKED' })
  } finally { await journal.release() }
})

it('refuses recent interrupted pending state even after the owner is gone', async () => {
  const dir = await directory()
  await atomicState(join(dir, 'baton-state.json'), {
    version: 2, owner_epoch: 1, records: [{ generation: 1, status: 'scheduled' }],
    pending: { token: 'recent', since: Date.now(), owner_epoch: 1 },
  })
  await expect(openAudit(dir, 5000, (error) => { throw error })).rejects.toThrow('recovery age')
})

it('delayed-heartbeat regression: a paused live owner cannot be displaced; retired A cannot erase generation 2', async () => {
  const dir = await directory()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const a = await openAudit(dir, 5000, (error) => { throw error })
  let b: Awaited<ReturnType<typeof openAudit>> | undefined
  try {
    await a.record({ generation: 1, status: 'scheduled' }, true)
    // Advance wall time without servicing a single heartbeat callback.
    vi.setSystemTime(Date.now() + 20000)
    await expect(openAudit(dir, 5000, (error) => { throw error })).rejects.toMatchObject({ code: 'ELOCKED' })
    a.assertOwner()
    await a.release()
    b = await openAudit(dir, 5000, (error) => { throw error })
    await b.record({ generation: 2, status: 'scheduled' }, true)
    const before = await readFile(join(dir, 'baton-state.json'), 'utf8')
    expect(b.epoch).toBe(2)
    expect(() => { a.assertOwner() }).toThrow('stale baton owner')
    await expect(a.record({ generation: 1, status: 'bootstrap-queued' }, false)).rejects.toThrow('stale baton owner')
    expect(await readFile(join(dir, 'baton-state.json'), 'utf8')).toBe(before)
    expect(JSON.parse(before) as unknown).toMatchObject({ owner_epoch: 2, pending: { owner_epoch: 2 } })
  } finally { await a.release(); await b?.release() }
})

it('holds the resource against another process and recovers after kernel-confirmed process death', async () => {
  const dir = await directory()
  const moduleUrl = new URL('../src/baton-audit.ts', import.meta.url).href
  const script = `
    import { openAudit } from ${JSON.stringify(moduleUrl)};
    const audit = await openAudit(process.argv[1], 5000, e => { throw e });
    const now = Date.now(); Date.now = () => now - 20000;
    await audit.record({ generation: 1, status: 'scheduled' }, true);
    process.stdin.resume(); process.stdout.write('ready');
  `
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, dir], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  let b: Awaited<ReturnType<typeof openAudit>> | undefined
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      exited.then(() => { throw new Error('audit fixture process exited before acquiring ownership') }),
    ])
    await expect(openAudit(dir, 5000, (error) => { throw error })).rejects.toMatchObject({ code: 'ELOCKED' })
    child.kill('SIGKILL')
    await exited
    b = await openAudit(dir, 5000, (error) => { throw error })
    expect(b.epoch).toBe(2)
    expect(b.generation).toBe(2)
    await b.record({ generation: 2, status: 'scheduled' }, true)
    expect(await readFile(join(dir, 'baton-state.json'), 'utf8')).toContain('not replayed')
  } finally {
    child.kill('SIGKILL')
    await exited
    await b?.release()
  }
})

it('re-reads persisted epoch before every write even without local compromise notification', async () => {
  const dir = await directory()
  const onCompromised = vi.fn()
  const a = await openAudit(dir, 5000, onCompromised)
  try {
    await a.record({ generation: 1, status: 'scheduled' }, true)
    // Force the reviewer's post-takeover snapshot independently of the new mutex.
    // Ordinary B cannot do this while A is live (proved in the preceding test).
    await atomicState(join(dir, 'baton-state.json'), {
      version: 2, owner_epoch: 2,
      records: [{ generation: 1, status: 'recovered' }, { generation: 2, status: 'scheduled' }],
      pending: { token: 'B', since: Date.now(), owner_epoch: 2 },
    })
    const before = await readFile(join(dir, 'baton-state.json'), 'utf8')
    expect(onCompromised).not.toHaveBeenCalled()
    expect(() => { a.assertOwner() }).toThrow('stale baton owner epoch')
    await expect(a.record({ generation: 1, status: 'bootstrap-queued' }, false)).rejects.toThrow('stale baton owner epoch')
    expect(await readFile(join(dir, 'baton-state.json'), 'utf8')).toBe(before)
  } finally { await a.release() }
})
