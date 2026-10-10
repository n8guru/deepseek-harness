/**
 * The registration-side business face both stage-dock entries receive. One
 * face for both because the toggle and the panel move the same two facts: the
 * panel needs `toggle` for its own close control, and the toggle reads the
 * same snapshot to show whether the dock is showing.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { StageDockState } from './store.ts'

/** Injected face of the stage-dock entries. */
export interface StageDockInjected {
  hooks: {
    /** Dock snapshot bound by the renderer as `useStageDock`. */
    stageDock: SnapshotStore<StageDockState>
  }
  /**
   * Show or hide one session's dock.
   * @param sessionId - the session whose dock was clicked.
   */
  toggle: (sessionId: string) => void
  /**
   * Bind one session to a Forage conversation and show its dock.
   * @param sessionId - the session to bind.
   * @param value - conversation id as typed.
   */
  attach: (sessionId: string, value: string) => void
}
