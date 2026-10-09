/** Source-plane fresh-process JSONL custody probe; only the supplied temporary root is used. */
import assert from 'node:assert/strict'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type GatedNotificationItem, type NotificationActivityGuard } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentLoop from '../src/index.ts'
import { ReactLoopInbox } from '../src/inbox.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const [root, mode] = process.argv.slice(2)
assert.ok(root)
const ctx = new Context()
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(AgentRegistry)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(JsonlPersistence, { root, compression: 'none' })
const adapter = new MockAdapter([textResponse('accepted once')])
ctx.llm.registerAdapter(['mock'], adapter)
const id = SessionId('gated-custody')
const options = { provider: 'mock', model: 'mock' }
const guard: NotificationActivityGuard = {
  version: 1, hostEpoch: 'old-host', bindingEpoch: 'old-browser', activityRevision: 3, controlRevision: 8,
}
const items = (): GatedNotificationItem[] => ['second', 'first', 'third'].map(sequence => ({
  admission: { origin: 'native:custody-test', sequence, activityGated: true },
  message: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: sequence }] }),
}))
const handle = mode === 'read' || mode === 'terminal-read' || mode === 'release-read' || mode === 'entered-read'
  ? await ctx.agents.resume({ resumeSessionId: id, agentOptions: options })
  : await ctx.agents.create({ sessionId: id, agentOptions: options })
const { agent } = handle
const inbox = agent.inbox.notifications!
assert.ok(inbox.stageActivityGated !== undefined)
if (mode === 'release-read' || mode === 'entered-read') {
  const state = ctx.sessionProjections.stateOf(agent.session, 'notifications')!
  const before = agent.session.seq
  const replay = inbox.stageActivityGated('next-step', items(), { ...guard, hostEpoch: 'new-host' })
  assert.equal(agent.session.seq, before)
  assert.deepEqual(replay.map(r => r.messageId), state.receipts.map(r => r.message.id))
  assert.ok(replay.every(r => r.duplicate))
  // Test-only activity provider: transport/authentication is covered by the HTTP/WS suite.
  // No recorded tuple supplies this fresh process-local authority.
  ctx.provide('notificationActivity', { inspect: subject => subject === agent
    && inbox.controls?.stop === 'clear' && !inbox.controls.focus ? 'fresh-test-observation' : undefined })
  assert.equal(await agent.releaseActivityGated?.(), false) // restored Stop is unknown
  inbox.resumeOperator!()
  assert.equal(await agent.releaseActivityGated?.(), mode === 'release-read')
  await agent.whenIdle()
  assert.equal(adapter.requests.length, mode === 'release-read' ? 1 : 0)
  assert.deepEqual(agent.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => e.data.id), replay.map(r => r.messageId))
  assert.equal(agent.inbox.nextStep.length, 0)
  assert.equal(await ctx.sessions.flush(agent.session), true)
  console.log('ENTERED_ONCE ' + JSON.stringify(replay))
  process.exit(0)
} else if (mode === 'read' || mode === 'terminal-read') {
  const state = ctx.sessionProjections.stateOf(agent.session, 'notifications')!
  assert.deepEqual(state.receipts.map(r => r.admission.sequence), ['second', 'first', 'third'])
  assert.deepEqual(state.receipts.map(r => r.activityGate), items().map(() => ({ sessionId: id, guard })))
  assert.deepEqual(agent.inbox.nextStep.map(m => m.id), mode === 'terminal-read' ? [] : state.receipts.map(r => r.message.id))
  if (mode === 'terminal-read') assert.equal(state.terminal.length, 3)
  const before = agent.session.seq
  const replay = inbox.stageActivityGated('next-step', items(), { ...guard, hostEpoch: 'new-host' })
  assert.equal(agent.session.seq, before)
  assert.deepEqual(replay.map(r => r.messageId), state.receipts.map(r => r.message.id))
  assert.ok(replay.every(r => r.duplicate))
  inbox.setFocus(false)
  inbox.resumeOperator!()
  assert.deepEqual(inbox.check('cannot-release-gated'), [])
  agent.wakeInbox?.()
  await agent.whenIdle()
  assert.equal(adapter.requests.length, 0)
  assert.ok(agent.inbox.nextStep.every(m => inbox.isHeld(m)))
  assert.equal(agent.session.snapshotEvents().some(e => e.type === 'user/message'), false)
  assert.equal(await ctx.sessions.flush(agent.session), true)
  console.log('RESTART_HELD ' + JSON.stringify(replay))
  // Do not dispose the agent: disposal deliberately settles receipts terminal.
  await ctx.fiber.dispose()
} else {
  const batch = items()
  let restoreSync: (() => void) | undefined
  if (mode === 'fsync-failure') {
    assert.equal(await ctx.sessions.flush(agent.session), true)
    const path = (await readdir(root, { recursive: true })).find(path => path.endsWith('.jsonl'))
    assert.ok(path)
    const probe = await open(join(root, path), 'r')
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> }
    await probe.close()
    const original = proto.sync
    let failed = false
    proto.sync = async function () {
      await original.call(this)
      if (!failed) { failed = true; throw new Error('uncertain fsync result') }
    }
    restoreSync = () => { proto.sync = original }
  }
  if (mode === 'custody-only') {
    // Simulate a process dying between the required event and the first pending splice.
    agent.session.append('agent/notification/activity-gated', { version: 1, sessionId: id, target: 'next-step', guard, items: batch })
  } else {
    const staged = inbox.stageActivityGated('next-step', batch, guard)
    assert.equal('accepted' in staged, false)
    assert.deepEqual(staged.map(r => r.messageId), batch.map(i => i.message.id))
  }
  if (mode === 'terminal-seed') {
    assert.ok(agent.inbox instanceof ReactLoopInbox)
    agent.inbox.clear(true)
  }
  if (mode === 'fsync-failure') {
    try { await assert.rejects(ctx.sessions.flush(agent.session), /uncertain fsync result/) }
    finally { restoreSync!() }
    console.log('FSYNC_REFUSED')
    const before = agent.session.seq
    assert.ok(inbox.stageActivityGated('next-step', items(), guard).every(r => r.duplicate))
    assert.equal(agent.session.seq, before)
  }
  if (mode === 'ambiguous-flush') {
    ctx.on('session/flush', () => { throw new Error('ambiguous custody checkpoint') })
    await assert.rejects(ctx.sessions.flush(agent.session), /ambiguous custody checkpoint/)
    console.log('CUSTODY_REFUSED')
    process.exit(0)
  }
  assert.equal(await ctx.sessions.flush(agent.session), true)
  console.log('CUSTODY_HELD ' + JSON.stringify(batch.map(i => i.message.id)))
  // Deliberately exit after the real fsync, without lifecycle disposal or a delivery ACK.
  process.exit(0)
}
