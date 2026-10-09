/** Keyless built-artifact driver over the shipped headless profile, isolated by loader-smoke. */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bootProductionProfile } from '../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

class FixtureAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = this.requests.length === 1 ? 'foreground checkpoint' : 'receipt checkpoint'
    if (this.requests.length > 3) throw new Error('unexpected static model turn')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const overlay = process.argv[2]
if (overlay === undefined) throw new Error('expected isolated profile overlay')
const ctx = await bootProductionProfile({ binName: 'focus-built-proof', profile: 'headless', overlayPaths: [resolve(overlay)] })
let handle
let gatedHandle
try {
  const adapter = new FixtureAdapter()
  ctx.llm.registerAdapter(['keyless-focus'], adapter)
  handle = await ctx.agents.create({ sessionId: SessionId('built-focus'), meta: { cwd: process.cwd() }, agentOptions: { provider: 'keyless-focus', model: 'scripted' } })
  const agent = handle.agent
  const inbox = agent.inbox.notifications
  assert.ok(inbox, 'built native capability required')
  const note = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  inbox.setFocus(true)
  inbox.admit('next-step', note('held urgent worker evidence'), { origin: 'native:fixture', sequence: 'initial', urgency: { kind: 'safety', reason: 'fixture authority' } })
  agent.wakeInbox?.()
  ctx.goals.create(agent, { objective: 'must remain static under Focus' })
  await agent.whenIdle()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(adapter.requests.length, 0)
  agent.followup(note('foreground obligation'))
  await agent.whenIdle()
  assert.equal(adapter.requests.length, 1)
  assert.ok(!JSON.stringify(adapter.requests[0]?.messages).includes('held urgent worker evidence'))
  const ids = inbox.check('fixed-check')
  agent.wakeInbox?.()
  await agent.whenIdle()
  assert.equal(adapter.requests.length, 2)
  inbox.admit('next-step', note('late worker evidence'), { origin: 'native:fixture', sequence: 'late' })
  assert.deepEqual(inbox.check('fixed-check'), ids)
  agent.wakeInbox?.()
  await agent.whenIdle()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(adapter.requests.length, 2)
  assert.equal(inbox.focus.queued, 1)
  agent.cancel({ kind: 'user' })
  assert.equal(ctx.goals.get(agent)?.phase, 'paused')
  await ctx.sessions.flush(agent.session)
  console.log('FOCUS_BUILT_SNAPSHOT ' + JSON.stringify({ foregroundRequests: 1, checkRequests: 1, staticHoldRequests: adapter.requests.length - 2, lateHeld: inbox.focus.queued, goal: ctx.goals.get(agent)?.phase }))
  // The shipped Loader/driver/persistence path consumes a test-only live activity owner.
  // Real authenticated socket/control integration belongs to the Connection host suite.
  gatedHandle = await ctx.agents.create({ sessionId: SessionId('built-gated'), meta: { cwd: process.cwd() },
    agentOptions: { provider: 'keyless-focus', model: 'scripted' } })
  const gated = gatedHandle.agent
  const notifications = gated.inbox.notifications!
  ctx.provide('notificationActivity', { inspect: subject => subject === gated
    && notifications.controls?.stop === 'clear' && !notifications.controls.focus ? 'live-built-fixture' : undefined })
  const guard = { version: 1 as const, hostEpoch: 'old-diagnostic', bindingEpoch: 'old-binding', activityRevision: 0, controlRevision: 0 }
  const items = ['first gated notice', 'second gated notice'].map((text, index) => ({
    message: note(text), admission: { origin: 'native:built-gated', sequence: String(index), activityGated: true as const },
  }))
  const receipts = notifications.stageActivityGated!('next-step', items, guard)
  assert.equal(await ctx.sessions.flush(gated.session), true)
  gated.wakeInbox?.()
  await gated.whenIdle()
  assert.equal(adapter.requests.length, 2)
  assert.equal(await gated.releaseActivityGated?.(), true)
  await gated.whenIdle()
  assert.equal(adapter.requests.length, 3)
  const accepted = gated.session.snapshotEvents().filter(event => event.type === 'user/message')
    .filter(event => receipts.some(receipt => receipt.messageId === event.data.id))
  assert.deepEqual(accepted.map(event => event.data.id), receipts.map(receipt => receipt.messageId))
  assert.ok(notifications.stageActivityGated!('next-step', items, guard).every(receipt => receipt.duplicate))
  assert.equal(await gated.releaseActivityGated?.(), false)
  gated.wakeInbox?.()
  await gated.whenIdle()
  assert.equal(adapter.requests.length, 3)
  assert.equal(await ctx.sessions.flush(gated.session), true)
  console.log('GATED_BUILT_SNAPSHOT ' + JSON.stringify({ starts: 1, nativeAccepted: accepted.length, duplicateWake: 0 }))
} finally {
  await gatedHandle?.dispose()
  await handle?.dispose()
  await ctx.fiber.dispose()
}
