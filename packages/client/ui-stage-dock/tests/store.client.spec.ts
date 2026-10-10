// @vitest-environment jsdom
/**
 * Stage-dock controller: the per-session binding, its normalization of
 * untrusted values, and the localStorage round trip that makes a dock survive
 * a reload.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  conversationIdOf, entryOf, STAGE_DOCK_PERSIST_KEY, StageDockController, type StageDockState,
} from '../src/client/store.ts'

beforeEach(() => { localStorage.clear() })
afterEach(() => { localStorage.clear() })

/** The persisted record as it stands on disk. */
function persisted(): StageDockState {
  const raw = localStorage.getItem(STAGE_DOCK_PERSIST_KEY)
  if (raw === null) throw new Error('nothing persisted')
  return JSON.parse(raw) as StageDockState
}

describe('conversationIdOf', () => {
  it('accepts a positive integer, as a number or as typed text', () => {
    expect(conversationIdOf(42)).toBe(42)
    expect(conversationIdOf('42')).toBe(42)
    expect(conversationIdOf('  42  ')).toBe(42)
  })

  it('rejects everything that does not denote a conversation', () => {
    // Blank input, a word, and a decimal are the operator's mistakes; null,
    // a boolean, and an unsafe integer are what a rehydrated or hand-edited
    // localStorage row can carry.
    expect(conversationIdOf('')).toBeNull()
    expect(conversationIdOf('abc')).toBeNull()
    expect(conversationIdOf('4.5')).toBeNull()
    expect(conversationIdOf(0)).toBeNull()
    expect(conversationIdOf(-3)).toBeNull()
    expect(conversationIdOf(Number.MAX_SAFE_INTEGER + 2)).toBeNull()
    expect(conversationIdOf(null)).toBeNull()
    expect(conversationIdOf(true)).toBeNull()
  })
})

describe('entryOf', () => {
  it('reads an absent session, and an absent current session, as closed', () => {
    const state: StageDockState = { bySession: {} }
    expect(entryOf(state, 's1')).toEqual({ open: false, conversationId: null })
    expect(entryOf(state, undefined)).toEqual({ open: false, conversationId: null })
  })

  it('normalizes a row whose stored shape no longer matches', () => {
    // Persistence rehydrates without validation, so the reader is the only
    // place a hand-edited or older row is made safe.
    const state = { bySession: { s1: { open: 'yes', conversationId: 'nope' } } } as unknown as StageDockState
    expect(entryOf(state, 's1')).toEqual({ open: false, conversationId: null })
  })
})

describe('StageDockController', () => {
  it('toggles one session independently and leaves the other alone', () => {
    const controller = new StageDockController()
    controller.toggle('s1')
    expect(entryOf(controller.store.getSnapshot(), 's1').open).toBe(true)
    expect(entryOf(controller.store.getSnapshot(), 's2').open).toBe(false)
    controller.toggle('s1')
    expect(entryOf(controller.store.getSnapshot(), 's1').open).toBe(false)
  })

  it('attaches a typed id and shows the dock in the same step', () => {
    const controller = new StageDockController()
    controller.attach('s1', '7')
    expect(entryOf(controller.store.getSnapshot(), 's1')).toEqual({ open: true, conversationId: 7 })
  })

  it('re-attaching replaces the binding: that is how the operator edits it', () => {
    const controller = new StageDockController()
    controller.attach('s1', '7')
    controller.attach('s1', '9')
    expect(entryOf(controller.store.getSnapshot(), 's1').conversationId).toBe(9)
  })

  it('ignores a value that denotes no conversation, keeping the current binding', () => {
    const controller = new StageDockController()
    controller.attach('s1', '7')
    controller.attach('s1', '')
    expect(entryOf(controller.store.getSnapshot(), 's1').conversationId).toBe(7)
  })

  it('keeps the binding while the dock is hidden, so reopening does not re-ask', () => {
    const controller = new StageDockController()
    controller.attach('s1', '7')
    controller.toggle('s1')
    expect(entryOf(controller.store.getSnapshot(), 's1')).toEqual({ open: false, conversationId: 7 })
  })

  it('persists, and a fresh controller rehydrates the same dock state (a page reload)', () => {
    const first = new StageDockController()
    first.attach('s1', '7')
    expect(persisted().bySession.s1).toEqual({ open: true, conversationId: 7 })

    const reloaded = new StageDockController()
    expect(entryOf(reloaded.store.getSnapshot(), 's1')).toEqual({ open: true, conversationId: 7 })
  })
})
