/**
 * Cadence successor follower: tabs, draft transfer, manual selection,
 * back-link no-bounce, replay/duplicate absorption, reload/reconnect
 * recovery, and failure staying on the old session.
 */
import { describe, expect, it } from 'vitest'
import {
  SuccessorFollower, tabLocalSet,
  type DraftContent, type SuccessorFact, type TabLocalSet,
} from '../src/client/successor/follow.ts'

const FACT: SuccessorFact = { successorSessionId: 'gen-11', successorGeneration: 11, handoffId: 'h-10-11' }

/** Host-side truth shared by every tab: durable projections and the listed sessions. */
class Host {
  successors = new Map<string, SuccessorFact>()
  listed = new Set<string>(['gen-10', 'gen-11', 'other'])
}

function memorySet(): TabLocalSet {
  const set = new Set<string>()
  return { has: v => set.has(v), add: (v) => { set.add(v) } }
}

/** One browser tab: its own selection, composers, one-shot sets and follower. */
class Tab {
  current: string | undefined
  drafts = new Map<string, DraftContent>()
  opened: string[] = []
  refuseInstall = false
  /** Whether this tab's list/projection mirror has caught up with the host. */
  synced = true
  handled = memorySet()
  dismissed = memorySet()
  follower: SuccessorFollower

  constructor(private readonly host: Host, current: string | undefined, handled?: TabLocalSet) {
    this.current = current
    if (handled) this.handled = handled
    this.follower = new SuccessorFollower({
      current: () => this.current,
      successorOf: id => (this.synced ? this.host.successors.get(id) ?? null : undefined),
      readDraft: id => (this.host.listed.has(id) ? this.drafts.get(id) ?? { draft: '', imageIds: [] } : undefined),
      installDraft: (id, content) => {
        if (this.refuseInstall) return false
        this.drafts.set(id, content)
        return true
      },
      clearDraft: (id) => { this.drafts.set(id, { draft: '', imageIds: [] }) },
      open: (id) => { this.opened.push(id); this.current = id },
      handled: this.handled,
      dismissed: this.dismissed,
    })
    this.follower.evaluate()
  }

  /** A user click in the sidebar. */
  select(id: string): void {
    this.current = id
    this.follower.evaluate()
  }
}

function record(host: Host, ...tabs: Tab[]): void {
  host.successors.set('gen-10', FACT)
  // The mux session/projection frame reaches every tab.
  for (const tab of tabs) tab.follower.evaluate()
}

describe('tabs', () => {
  it('every tab showing the old id auto-selects the successor; others are untouched', () => {
    const host = new Host()
    const a = new Tab(host, 'gen-10')
    const b = new Tab(host, 'gen-10')
    const c = new Tab(host, 'other')
    record(host, a, b, c)
    expect(a.current).toBe('gen-11')
    expect(b.current).toBe('gen-11')
    expect(c.current).toBe('other')
    expect(a.follower.getSnapshot()).toMatchObject({ kind: 'moved', generation: 11, fromId: 'gen-10', toId: 'gen-11' })
    expect(c.follower.getSnapshot()).toBeNull()
  })

  it('duplicate mux frames and replays navigate once', () => {
    const host = new Host()
    const a = new Tab(host, 'gen-10')
    record(host, a)
    a.follower.evaluate()
    a.follower.evaluate()
    expect(a.opened).toEqual(['gen-11'])
  })
})

describe('readiness is host-owned', () => {
  it('no projection, no move: a not-ready or failed handoff keeps the old session selected', () => {
    const host = new Host()
    const a = new Tab(host, 'gen-10')
    a.follower.evaluate()
    expect(a.current).toBe('gen-10')
    expect(a.opened).toEqual([])
    expect(a.follower.getSnapshot()).toBeNull()
  })

  it('waits (without navigating) until the successor is resolvable in this tab', () => {
    const host = new Host()
    host.listed.delete('gen-11')
    const a = new Tab(host, 'gen-10')
    record(host, a)
    expect(a.current).toBe('gen-10')
    host.listed.add('gen-11')
    a.follower.evaluate()
    expect(a.current).toBe('gen-11')
  })
})

describe('drafts', () => {
  it('moves mid-typing text and images to the successor, never submits, clears the source only after acceptance', () => {
    const host = new Host()
    const a = new Tab(host, 'gen-10')
    a.drafts.set('gen-10', { draft: 'half-typed @ref:baton.md', imageIds: ['img-1'] })
    record(host, a)
    expect(a.drafts.get('gen-11')).toEqual({ draft: 'half-typed @ref:baton.md', imageIds: ['img-1'] })
    expect(a.drafts.get('gen-10')).toEqual({ draft: '', imageIds: [] })
    expect(a.current).toBe('gen-11')
  })

  it('a refused transfer neither clears nor navigates, and retries on the next change', () => {
    const host = new Host()
    const a = new Tab(host, 'gen-10')
    a.drafts.set('gen-10', { draft: 'keep me', imageIds: [] })
    a.refuseInstall = true
    record(host, a)
    expect(a.current).toBe('gen-10')
    expect(a.drafts.get('gen-10')?.draft).toBe('keep me')
    expect(a.follower.getSnapshot()?.kind).toBe('failed')
    a.refuseInstall = false
    a.follower.evaluate()
    expect(a.current).toBe('gen-11')
    expect(a.drafts.get('gen-11')?.draft).toBe('keep me')
  })

  it('two tabs with distinct drafts: the second never overwrites the nonempty successor composer', () => {
    const host = new Host()
    const a = new Tab(host, 'gen-10')
    const b = new Tab(host, 'gen-10')
    a.drafts.set('gen-10', { draft: 'draft A', imageIds: [] })
    b.drafts.set('gen-10', { draft: 'draft B', imageIds: [] })
    // Tab B's successor composer already holds A's moved draft (per-session persistence shared across tabs).
    b.drafts.set('gen-11', { draft: 'draft A', imageIds: [] })
    record(host, a, b)
    expect(a.current).toBe('gen-11')
    expect(b.current).toBe('gen-10')
    expect(b.drafts.get('gen-10')?.draft).toBe('draft B')
    expect(b.drafts.get('gen-11')?.draft).toBe('draft A')
    expect(b.follower.getSnapshot()?.kind).toBe('conflict')
    // Explicit choice opens the successor and still overwrites nothing.
    b.follower.openSuccessor()
    expect(b.current).toBe('gen-11')
    expect(b.drafts.get('gen-10')?.draft).toBe('draft B')
    expect(b.drafts.get('gen-11')?.draft).toBe('draft A')
  })
})

describe('manual selection and back-link', () => {
  it('a projection that lands after a manual switch is ignored', () => {
    const host = new Host()
    const a = new Tab(host, 'gen-10')
    a.select('other')
    record(host, a)
    expect(a.current).toBe('other')
    expect(a.opened).toEqual([])
  })

  it('the back-link opens the archived old transcript without a redirect loop; "Go to current" returns', () => {
    const host = new Host()
    const a = new Tab(host, 'gen-10')
    record(host, a)
    a.follower.openPrevious()
    a.follower.evaluate()
    a.follower.evaluate()
    expect(a.current).toBe('gen-10')
    expect(a.opened).toEqual(['gen-11', 'gen-10'])
    expect(a.follower.getSnapshot()?.kind).toBe('superseded')
    a.follower.openSuccessor()
    expect(a.current).toBe('gen-11')
  })

  it('deliberately selecting an old session whose successor is known never redirects', () => {
    const host = new Host()
    host.successors.set('gen-10', FACT)
    const a = new Tab(host, 'other')
    a.select('gen-10')
    expect(a.current).toBe('gen-10')
    expect(a.follower.getSnapshot()?.kind).toBe('superseded')
  })

  it('dismiss hides the notice for this handoff only', () => {
    const host = new Host()
    const a = new Tab(host, 'gen-10')
    record(host, a)
    a.follower.dismiss()
    a.follower.evaluate()
    expect(a.follower.getSnapshot()).toBeNull()
  })
})

describe('reload / reconnect recovery', () => {
  it('a tab that missed the frame follows once its restored selection sees the fact', () => {
    const host = new Host()
    host.successors.set('gen-10', FACT)
    const a = new Tab(host, 'gen-10')
    expect(a.current).toBe('gen-11')
  })

  it('reconnect: fact arrives with the refreshed list after the tab was offline', () => {
    const host = new Host()
    const a = new Tab(host, 'gen-10')
    a.synced = false
    record(host, a)
    expect(a.current).toBe('gen-10')
    a.synced = true
    a.follower.evaluate()
    expect(a.current).toBe('gen-11')
  })

  it('after following, a reload restored onto the old id (back-link) does not bounce', () => {
    const host = new Host()
    const storage = new Map<string, string>()
    const fake = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v) },
    } as unknown as Storage
    const first = new Tab(host, 'gen-10', tabLocalSet('succ', fake))
    record(host, first)
    first.follower.openPrevious()
    const reloaded = new Tab(host, 'gen-10', tabLocalSet('succ', fake))
    expect(reloaded.current).toBe('gen-10')
    expect(reloaded.follower.getSnapshot()?.kind).toBe('superseded')
  })
})
