/**
 * Atomic host audit snapshot, fenced by a kernel-backed SQLite writer reservation.
 * The database is only a mutex; session storage and replay are unchanged.
 * @module @deepseek-ai/dsh-command-compact/baton-audit
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

interface RecordEntry {
  generation: number
  status: string
  [key: string]: unknown
}
interface State {
  version: 2
  owner_epoch: number
  records: RecordEntry[]
  pending: { token: string; since: number; owner_epoch: number } | null
}

/**
 * Publish complete audit bytes. Production callers must hold the audit mutex throughout.
 * @param path - destination in the audit directory.
 * @param state - complete journal, owner epoch and pending state.
 */
export async function atomicState(path: string, state: State): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp'
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(state) + '\n')
    await file.sync()
  } finally { await file.close() }
  try {
    await rename(temporary, path)
    const directory = await open(dirname(path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally {
    try { await unlink(temporary) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

function parseState(raw: string): State {
  const parsed = JSON.parse(raw) as Partial<State> & { version?: number }
  if (Number(parsed.version) !== 2 || !Number.isSafeInteger(parsed.owner_epoch) || Number(parsed.owner_epoch) < 0
    || !Array.isArray(parsed.records)
    || parsed.records.some(record => !Number.isSafeInteger(record.generation) || record.generation < 1)
    || (parsed.pending !== null && (typeof parsed.pending?.token !== 'string'
      || !Number.isFinite(parsed.pending.since) || parsed.pending.owner_epoch !== parsed.owner_epoch))) {
    throw new Error('invalid baton audit snapshot (expected fenced version 2)')
  }
  return parsed as State
}

/**
 * Reserve the audit resource until release. A delayed live owner is never age-displaced.
 * @param directory - deployment-owned session audit directory on a local filesystem.
 * @param staleMs - minimum age before abandoned pending work may be cleared.
 * @param compromised - cancels the owner on a persisted epoch mismatch.
 * @returns journal operations that compare the persisted epoch while holding the same writer reservation.
 */
export async function openAudit(directory: string, staleMs: number, compromised: (error: Error) => void) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'baton-state.json')
  const mutex = new DatabaseSync(join(directory, 'baton-mutex.sqlite'))
  let closed = false
  let closing = false
  try {
    // BEGIN IMMEDIATE holds an OS-backed writer reservation even while JS is paused.
    // No timer may steal it; a dead process releases it through the kernel.
    mutex.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE')
  } catch (cause) {
    mutex.close()
    throw Object.assign(new Error('hand_forward audit owner is live or ambiguous', { cause }), { code: 'ELOCKED' })
  }
  let operations = Promise.resolve()
  let released: Promise<void> | undefined
  const release = (): Promise<void> => {
    if (released) return released
    closing = true
    released = operations.then(() => {
      closed = true
      try { mutex.exec('ROLLBACK') } finally { mutex.close() }
    })
    return released
  }
  try {
    let state: State = { version: 2, owner_epoch: 0, records: [], pending: null }
    try { state = parseState(await readFile(path, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (state.pending !== null) {
      const age = Date.now() - state.pending.since
      if (age < staleMs) throw new Error('hand_forward pending recovery age not reached')
      const generation = state.records.at(-1)?.generation
      if (generation === undefined) throw new Error('pending audit has no generation')
      state = {
        ...state, pending: null,
        records: [...state.records, {
          generation, status: 'recovered', time: new Date().toISOString(),
          reason: 'abandoned pending recovered under kernel writer reservation; not replayed',
          previous_token: state.pending.token, previous_epoch: state.owner_epoch, age_ms: age,
        }],
      }
    }
    const epoch = state.owner_epoch + 1
    if (!Number.isSafeInteger(epoch)) throw new Error('baton owner epoch exhausted')
    state = { ...state, owner_epoch: epoch }
    await atomicState(path, state)
    const assertOwner = (): void => {
      if (closed || closing) throw new Error('stale baton owner: audit reservation released')
      const current = parseState(readFileSync(path, 'utf8'))
      if (current.owner_epoch !== epoch) {
        const error = new Error('stale baton owner epoch')
        compromised(error)
        throw error
      }
    }
    const generation = state.records.reduce((max, record) => Math.max(max, record.generation), 0) + 1
    const token = randomUUID()
    return {
      generation,
      epoch,
      assertOwner,
      record(record: RecordEntry, pending: boolean): Promise<void> {
        const operation = operations.then(async () => {
          assertOwner()
          // Re-read under the reservation: never publish a cached prior owner's history.
          const current = parseState(readFileSync(path, 'utf8'))
          if (record.generation !== generation) throw new Error('stale baton generation')
          const next: State = {
            version: 2, owner_epoch: epoch,
            records: [...current.records, { ...record, owner_epoch: epoch }],
            pending: pending ? { token, since: current.pending?.since ?? Date.now(), owner_epoch: epoch } : null,
          }
          await atomicState(path, next)
        })
        // Release drains both successful and failed publications before unlocking.
        operations = operation.then(() => {}, () => {})
        return operation
      },
      release,
    }
  } catch (error) {
    await release()
    throw error
  }
}
