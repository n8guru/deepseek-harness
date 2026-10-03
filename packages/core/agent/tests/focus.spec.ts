import { describe, expect, it } from 'vitest'
import { Inbox } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const callbacks = { inserted: () => {}, discarded: () => {}, claimed: () => {} }
const message = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const notification = (sequence: string) => ({ origin: 'mock-notifier', sequence })

describe('durable native Focus', () => {
  it('holds only explicitly admitted background; human quotations and unknown coordinator input bypass', () => {
    const inbox = new Inbox(Session.create(SessionId('focus')), callbacks)
    inbox.setFocus(true)
    inbox.admit('next-step', message('NEW CARD worker report'), notification('1'))
    const human = message('I quote NEW CARD worker report')
    const coordinator = message('coordinator relay')
    inbox.append('next-turn', human)
    inbox.append('next-step', coordinator)
    expect(inbox.claim('next-turn', 1)).toEqual([coordinator, human])
    expect(inbox.focus).toEqual({ enabled: true, queued: 1 })
    expect(inbox.hasPending).toBe(false)
    expect(inbox.hasNextStep).toBe(false)
  })

  it('deduplicates origin plus sequence after reload, not task or identical text', () => {
    const session = Session.create(SessionId('dedup'))
    const inbox = new Inbox(session, callbacks)
    inbox.setFocus(true)
    const first = message('task a1720b8e update')
    expect(inbox.admit('next-step', first, notification('message_seq:10'))).toBe(true)
    expect(inbox.admit('next-step', message('same task new update'), notification('message_seq:11'))).toBe(true)
    const reloaded = new Inbox(session, callbacks)
    expect(reloaded.admit('next-step', message('retry'), notification('message_seq:10'))).toBe(false)
    expect(reloaded.receipt('mock-notifier', 'message_seq:10')).toEqual(first)
    expect(reloaded.admit('next-step', message('task a1720b8e update'), { origin: 'another', sequence: 'message_seq:10' })).toBe(true)
    expect(reloaded.focus.queued).toBe(3)
  })

  it('Check releases one bounded snapshot; repeated Check does not release later arrivals', () => {
    const session = Session.create(SessionId('snapshot'))
    const inbox = new Inbox(session, callbacks)
    inbox.setFocus(true)
    for (let n = 0; n < 12; n++) inbox.admit('next-step', message(String(n)), notification(String(n)))
    const snapshot = inbox.check('check-1')
    expect(snapshot).toHaveLength(10)
    inbox.admit('next-step', message('late'), notification('late'))
    expect(inbox.check('check-1')).toEqual(snapshot)
    const claimed = inbox.claim('next-step', 1)
    for (const m of claimed) session.append('user/message', m, { surfaceOp: 'append' })
    expect(claimed).toHaveLength(10)
    const reloaded = new Inbox(session, callbacks)
    expect(reloaded.check('check-1')).toEqual(snapshot)
    expect(reloaded.claim('next-step', 2)).toEqual([])
    expect(reloaded.focus.queued).toBe(3)
    expect(reloaded.check('check-2')).toHaveLength(3)
  })

  it('foreground human wins a race against released Check input', () => {
    const inbox = new Inbox(Session.create(SessionId('human-race')), callbacks)
    inbox.setFocus(true)
    const background = message('report')
    inbox.admit('next-step', background, notification('1'))
    inbox.check('snapshot')
    const human = message('Nate test first')
    inbox.append('next-turn', human)
    expect(inbox.claim('next-turn', 1)).toEqual([human])
    expect(inbox.claim('next-step', 1)).toEqual([background])
  })

  it('Stop, disposal and generic queue mutation cannot discard notification evidence', () => {
    const session = Session.create(SessionId('stop'))
    const inbox = new Inbox(session, callbacks)
    inbox.setFocus(true)
    const background = message('result, blocker, evidence ref')
    inbox.admit('next-step', background, notification('1'))
    inbox.append('next-turn', message('discardable input'))
    expect(inbox.remove(background.id)).toBe(false)
    expect(inbox.replace(background.id, message('edit'))).toBe(false)
    expect(() => inbox.splice('next-step', 0, 1, [])).toThrow('notification evidence')
    inbox.clear()
    expect(new Inbox(session, callbacks).focus.queued).toBe(1)
  })

  it('recovers an interrupted pre-step claim, but never replays model-visible results', () => {
    const session = Session.create(SessionId('claim-recovery'))
    const inbox = new Inbox(session, callbacks)
    inbox.setFocus(true)
    const background = message('important result')
    inbox.admit('next-step', background, notification('1'))
    inbox.check('snapshot')
    expect(inbox.claim('next-step', 1)).toEqual([background])
    const successor = new Inbox(session, callbacks)
    expect(successor.claim('next-step', 2)).toEqual([background])
    session.append('user/message', background, { surfaceOp: 'append' })
    expect(new Inbox(session, callbacks).nextStep).toEqual([])
  })

  it('truthful trusted urgent lane bypasses Focus; unclassified inputs remain foreground', () => {
    const inbox = new Inbox(Session.create(SessionId('urgent')), callbacks)
    inbox.setFocus(true)
    const urgent = message('credential exposure')
    inbox.admit('next-step', urgent, { ...notification('critical'), urgency: { kind: 'security', reason: 'credential exposure detected' } })
    expect(inbox.claim('next-step', 1)).toEqual([urgent])
    expect(inbox.focus.queued).toBe(0)
  })

  it('session isolation and fork seeds never inherit Focus or receipts', () => {
    const source = Session.create(SessionId('source'))
    const inbox = new Inbox(source, callbacks)
    inbox.setFocus(true)
    inbox.admit('next-step', message('report'), notification('1'))
    const child = Session.create(SessionId('child'), source.events, { ...source.header, id: SessionId('child'), seedLength: source.events.length })
    const childInbox = new Inbox(child, callbacks)
    expect(childInbox.focus).toEqual({ enabled: false, queued: 0 })
    expect(childInbox.receipt('mock-notifier', '1')).toBeUndefined()
    expect(new Inbox(Session.create(SessionId('isolated')), callbacks).focus.enabled).toBe(false)
  })
})
