/** Client-side poll loop against a scripted ctx.remote.dshHostDirectory fake. */
import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { DshHostDirectorySnapshot } from '@deepseek-ai/dsh-host-directory/types'
import { startDshPeerSessionsPoll } from '../src/client/index.ts'

const EMPTY_SNAPSHOT: DshHostDirectorySnapshot = { self: 'this-host', sessions: [], peers: [] }
const FAST_POLL_MS = 20

type ListResult =
  | { ok: true; value: DshHostDirectorySnapshot }
  | { ok: false; error: { code: string; message: string } }

/** A minimal ClientContext exposing only the one Remote method this plugin calls. */
function fakeCtx(list: () => Promise<ListResult>): ClientContext {
  return { remote: { dshHostDirectory: { list } } } as unknown as ClientContext
}

describe('startDshPeerSessionsPoll', () => {
  it('polls immediately and stores the first successful snapshot', async () => {
    const list = vi.fn(async (): Promise<ListResult> => ({ ok: true, value: EMPTY_SNAPSHOT }))
    const { store, dispose } = startDshPeerSessionsPoll(fakeCtx(list), { pollIntervalMs: FAST_POLL_MS })
    await vi.waitFor(() => { expect(list).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => { expect(store.getSnapshot().snapshot).toEqual(EMPTY_SNAPSHOT) })
    expect(store.getSnapshot().lastPollFailed).toBe(false)
    dispose()
  })

  it('marks lastPollFailed once a later poll fails, and clears it once a poll succeeds again', async () => {
    let outcome: 'ok' | 'error' = 'ok'
    const list = vi.fn(async (): Promise<ListResult> => (outcome === 'ok'
      ? { ok: true, value: EMPTY_SNAPSHOT }
      : { ok: false, error: { code: 'gateway/internal', message: 'boom' } }))
    const { store, dispose } = startDshPeerSessionsPoll(fakeCtx(list), { pollIntervalMs: FAST_POLL_MS })
    await vi.waitFor(() => { expect(store.getSnapshot().snapshot).toEqual(EMPTY_SNAPSHOT) })
    expect(store.getSnapshot().lastPollFailed).toBe(false)

    outcome = 'error'
    await vi.waitFor(() => { expect(store.getSnapshot().lastPollFailed).toBe(true) }, { timeout: 2000, interval: 10 })
    // The failed poll never wiped the last good snapshot: a transient miss must not blank the directory.
    expect(store.getSnapshot().snapshot).toEqual(EMPTY_SNAPSHOT)

    outcome = 'ok'
    await vi.waitFor(() => { expect(store.getSnapshot().lastPollFailed).toBe(false) }, { timeout: 2000, interval: 10 })
    dispose()
  })

  it('stops polling after dispose', async () => {
    const list = vi.fn(async (): Promise<ListResult> => ({ ok: true, value: EMPTY_SNAPSHOT }))
    const { dispose } = startDshPeerSessionsPoll(fakeCtx(list), { pollIntervalMs: FAST_POLL_MS })
    await vi.waitFor(() => { expect(list.mock.calls.length).toBeGreaterThanOrEqual(1) })
    dispose()
    const callsAtDispose = list.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, FAST_POLL_MS * 5))
    expect(list.mock.calls.length).toBe(callsAtDispose)
  })
})
