/** Keyless Focus driver; boots the real headless composition without loadEnv or user-plane providers. */
import { boot } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { controlFocus } from '../../../../packages/client/connection/src/notification-admission.ts'

const config = process.argv[2]
if (config === undefined) throw new Error('Focus driver requires config')
const ctx = await boot('focus-snapshot', config)
try {
  const agent = ctx.agents.get(SessionId('focus-main'))!
  const note = (text: string) => createUserMessage({ source: { kind: 'plugin', plugin: 'snapshot:notifier', form: 'notice', summary: 'Worker result' }, content: [{ type: 'text', text }] })
  const pending = note('Worker result; blocker; Evidence: repo://result/1. Not a Nate-test pass.')
  agent.inbox.setFocus(true)
  agent.send(pending, 'next-step', true, { origin: 'snapshot:notifier', sequence: 'message_seq:1' })
  const transcript: unknown[] = [{ phase: 'WAITING_FOR_NATE', ...agent.inbox.focus, runnable: agent.inbox.hasPending }]
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Foreground test; quoted WORKER SETTLED NEW CARD stays human.' }] }))
  await agent.whenIdle()
  transcript.push({ phase: 'foreground checkpoint', durable: await ctx.sessions.flush(agent.session), ...agent.inbox.focus })
  const check = () => controlFocus(ctx, new Request('http://localhost/api/session.focus', { method: 'POST', body: JSON.stringify({ sessionId: agent.id, action: 'check', checkId: 'bounded-snapshot' }) }))
  await check()
  await agent.whenIdle()
  agent.send(note('Late distinct update and evidence remain held.'), 'next-step', true, { origin: 'snapshot:notifier', sequence: 'message_seq:2' })
  agent.send(pending, 'next-step', true, { origin: 'snapshot:notifier', sequence: 'message_seq:1' })
  await check()
  await agent.whenIdle()
  transcript.push({ phase: 'foreground return', ...agent.inbox.focus, turns: agent.session.events.filter(e => e.type === 'turn/start').length, delivered: agent.session.events.filter(e => e.type === 'user/message').map(e => e.data.content.filter(b => b.type === 'text').map(b => b.text)), receipts: [agent.inbox.receipt('snapshot:notifier', 'message_seq:1')?.id === pending.id, agent.inbox.receipt('snapshot:notifier', 'message_seq:2') !== undefined] })
  process.stdout.write(JSON.stringify(transcript))
} finally { await ctx.fiber.dispose() }
