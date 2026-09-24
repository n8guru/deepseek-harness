/** Snapshot store for the Client-side poll of dshHostDirectory/list. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DshHostDirectorySnapshot } from '@deepseek-ai/dsh-host-directory/types'

/** Live poll state of this Host's own dshHostDirectory Remote. */
export interface DshPeerSessionsState {
  /** Last successfully read snapshot; undefined before the first poll settles. */
  snapshot: DshHostDirectorySnapshot | undefined
  /**
   * Whether the most recent poll attempt failed (network/RPC error, not a
   * peer-level failure — those live inside `snapshot.peers[].status`).
   */
  lastPollFailed: boolean
}

const INITIAL: DshPeerSessionsState = { snapshot: undefined, lastPollFailed: false }

/**
 * Create one poll-state store. Call once per Client plugin instance; do not
 * create a module-level singleton (de-facto singletons are forbidden by the
 * client stack's store-sharing rule — share by passing this handle).
 * @returns the store.
 */
export function createDshPeerSessionsStore(): SnapshotStore<DshPeerSessionsState> {
  return createSnapshotStore(INITIAL, { flush: 'sync' })
}
