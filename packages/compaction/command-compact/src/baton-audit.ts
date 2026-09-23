/**
 * Atomic host audit snapshot: history and pending state share one rename.
 * @module @deepseek-ai/dsh-command-compact/baton-audit
 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import lockfile from 'proper-lockfile'

interface RecordEntry {
  generation: number
  status: string
  [key: string]: unknown
}
interface State {
  version: 1
  records: RecordEntry[]
  pending: { token: string; since: number } | null
}

/**
 * Replace a snapshot only after its complete bytes reach disk; then sync the directory.
 * @param path - destination in the audit directory.
 * @param state - complete journal and pending state.
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

/**
 * Acquire a renewable lease and open the audit; expired leases self-heal on the next caller.
 * @param directory - deployment-owned session audit directory.
 * @param staleMs - minimum five seconds; heartbeat keeps live owners from expiring.
 * @param compromised - cancels the owner if lease ownership is lost.
 * @returns exclusively owned journal operations and release.
 */
export async function openAudit(directory: string, staleMs: number, compromised: (error: Error) => void) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'baton-state.json')
  let expiredLease = false
  try {
    expiredLease = Date.now() - (await stat(path + '.lock')).mtimeMs > staleMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let lost: Error | undefined
  const release = await lockfile.lock(path, {
    realpath: false, stale: staleMs, update: Math.max(1000, Math.floor(staleMs / 3)), retries: 0,
    onCompromised(error) { lost = error; compromised(error) },
  })
  const assertOwner = (): void => { if (lost) throw lost }
  let state: State = { version: 1, records: [], pending: null }
  try {
    let raw: string | undefined
    try { raw = await readFile(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (raw !== undefined) {
      const parsed = JSON.parse(raw) as Partial<State> & { version?: number }
      if (Number(parsed.version) !== 1 || !Array.isArray(parsed.records)
        || parsed.records.some(record => !Number.isSafeInteger(record.generation) || record.generation < 1)
        || (parsed.pending !== null && (typeof parsed.pending?.token !== 'string' || !Number.isFinite(parsed.pending.since)))) {
        throw new Error('invalid baton audit snapshot')
      }
      state = parsed as State
    }
    if (state.pending !== null) {
      const age = Date.now() - state.pending.since
      if (age < staleMs) throw new Error('hand_forward pending recovery age not reached')
      const previousGeneration = state.records.at(-1)?.generation
      if (previousGeneration === undefined) throw new Error('pending audit has no generation')
      state = {
        ...state, pending: null,
        records: [...state.records, {
          generation: previousGeneration, status: 'recovered', time: new Date().toISOString(),
          reason: 'expired pending operation recovered after exclusive lease acquisition; not replayed',
          previous_token: state.pending.token, age_ms: age,
        }],
      }
      assertOwner()
      await atomicState(path, state)
    }
    if (expiredLease && state.records.at(-1)?.status !== 'recovered') {
      state = {
        ...state,
        records: [...state.records, {
          generation: Math.max(1, ...state.records.map(record => record.generation)),
          status: 'recovered', time: new Date().toISOString(),
          reason: 'expired lease observed before exclusive acquisition; no pending operation to replay',
        }],
      }
      assertOwner()
      await atomicState(path, state)
    }
    const generation = state.records.reduce((max, record) => Math.max(max, record.generation), 0) + 1
    const token = randomUUID()
    return {
      generation,
      assertOwner,
      async record(record: RecordEntry, pending: boolean): Promise<void> {
        assertOwner()
        const next: State = {
          version: 1, records: [...state.records, record],
          pending: pending ? { token, since: state.pending?.since ?? Date.now() } : null,
        }
        await atomicState(path, next)
        assertOwner()
        state = next
      },
      release,
    }
  } catch (error) {
    await release()
    throw error
  }
}
