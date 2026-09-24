/**
 * R2 client half (dsh-mesh-session-view project 1479605, step 2): polls this
 * Host's own `dshHostDirectory/list` Typert Remote over the EXISTING
 * `ctx.connection.rpc` / `ctx.remote` mount (no new wire protocol) and keeps
 * a store fed with the latest snapshot. Registers no slot and renders
 * nothing — grouping peer sessions into `sidebar.workspaces` is step 4's
 * scope (deep-link open-on-click), not this row's. A later plugin reads
 * `createDshPeerSessionsStore`'s handle through ordinary store sharing.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the dshHostDirectory namespace into the ctx.remote merge.
import type {} from '@deepseek-ai/dsh-host-directory/remote'
import { createDshPeerSessionsStore, type DshPeerSessionsState } from './store.ts'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'

export type { DshPeerSessionsState } from './store.ts'
export { createDshPeerSessionsStore } from './store.ts'
export type { DshHostDirectorySnapshot, DshHostPeerStatus, DshHostPeerView, DshHostRemoteSession } from '@deepseek-ai/dsh-host-directory/types'

/** Poll interval floor for the Client-side read; the Host's own poll interval governs actual freshness. */
const POLL_INTERVAL_MS = 5000

/** Services required by the Remote mount this plugin polls. */
export const inject = ['remote']

/**
 * Start the poll loop against this Host's own directory Remote.
 * @param ctx - Client root Context with the mounted Remote.
 * @param options - test seams: an existing store to update, and an interval override.
 * @returns the created store (for a later plugin/test to read) plus a disposer.
 */
export function startDshPeerSessionsPoll(
  ctx: ClientContext,
  options: { store?: SnapshotStore<DshPeerSessionsState>; pollIntervalMs?: number } = {},
): { store: SnapshotStore<DshPeerSessionsState>; dispose: () => void } {
  const store = options.store ?? createDshPeerSessionsStore()
  const controller = new AbortController()
  const tick = async (): Promise<void> => {
    if (controller.signal.aborted) return
    const result = await ctx.remote.dshHostDirectory.list()
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispose() can abort during the await.
    if (controller.signal.aborted) return
    if (result.ok) {
      store.set({ snapshot: result.value, lastPollFailed: false })
    } else {
      store.update((draft) => { draft.lastPollFailed = true })
    }
  }
  void tick()
  const timer = setInterval(() => { void tick() }, options.pollIntervalMs ?? POLL_INTERVAL_MS)
  return { store, dispose: () => { controller.abort(); clearInterval(timer) } }
}

/**
 * Mount the poll loop as a Client plugin effect.
 * @param ctx - Client root Context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const { dispose } = startDshPeerSessionsPoll(ctx)
    return dispose
  }, 'ui-peer-sessions: dshHostDirectory poll loop')
}
