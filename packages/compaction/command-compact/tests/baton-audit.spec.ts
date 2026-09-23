import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, mkdir, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
      pending: null, records: [{ status: 'scheduled' }, { status: 'bootstrap-queued' }],
    })
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
  } finally { await journal.release() }
})

it('reclaims an aged crashed lease and records recovery without replaying the interrupted generation', async () => {
  const dir = await directory()
  const path = join(dir, 'baton-state.json')
  await atomicState(path, {
    version: 1, records: [{ generation: 7, status: 'scheduled' }],
    pending: { token: 'crashed-owner', since: Date.now() - 20000 },
  })
  await mkdir(path + '.lock')
  const old = new Date(Date.now() - 20000)
  await utimes(path + '.lock', old, old)
  const journal = await openAudit(dir, 5000, (error) => { throw error })
  try {
    expect(journal.generation).toBe(8)
    const state = JSON.parse(await readFile(path, 'utf8')) as { pending: unknown; records: { status: string; reason: string }[] }
    expect(state.pending).toBeNull()
    expect(state.records.at(-1)?.status).toBe('recovered')
    expect(state.records.at(-1)?.reason).toContain('not replayed')
    await expect(openAudit(dir, 5000, (error) => { throw error })).rejects.toMatchObject({ code: 'ELOCKED' })
  } finally { await journal.release() }
})

it('does not steal a recent interrupted pending state merely because its lease directory is absent', async () => {
  const dir = await directory()
  await atomicState(join(dir, 'baton-state.json'), {
    version: 1, records: [{ generation: 1, status: 'scheduled' }],
    pending: { token: 'recent', since: Date.now() },
  })
  await expect(openAudit(dir, 5000, (error) => { throw error })).rejects.toThrow('recovery age')
})

it('logs expiry even when the crashed owner never published pending state', async () => {
  const dir = await directory()
  const path = join(dir, 'baton-state.json')
  await mkdir(path + '.lock')
  const old = new Date(Date.now() - 20000)
  await utimes(path + '.lock', old, old)
  const journal = await openAudit(dir, 5000, (error) => { throw error })
  try {
    const state = JSON.parse(await readFile(path, 'utf8')) as { records: { reason: string }[] }
    expect(state.records.at(-1)?.reason).toContain('no pending operation to replay')
  } finally { await journal.release() }
})

it('refuses a live renewable lease and never changes its pending owner', async () => {
  const dir = await directory()
  const journal = await openAudit(dir, 5000, (error) => { throw error })
  try {
    await journal.record({ generation: 1, status: 'scheduled' }, true)
    const before = await readFile(join(dir, 'baton-state.json'), 'utf8')
    await expect(openAudit(dir, 5000, (error) => { throw error })).rejects.toMatchObject({ code: 'ELOCKED' })
    expect(await readFile(join(dir, 'baton-state.json'), 'utf8')).toBe(before)
  } finally { await journal.release() }
})
