/** Keyless provider/control fixture; the actual built CLI and headless runner own the task. */
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
export const inject = ['llm', 'agents', 'goals']
export function apply(ctx: Context): void {
  class Adapter extends LlmAdapter {
    requests = 0
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.requests += 1
      assert.equal(this.requests, 1, 'static hold must spend no additional model call')
      assert.ok(!JSON.stringify(options.messages).includes('held CLI worker evidence'))
      const text = 'CLI foreground checkpoint'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['keyless-cli-focus'], adapter)
  ctx.on('agent/created', ({ agent }) => {
    const inbox = agent.inbox.notifications
    assert.ok(inbox, 'actual CLI must expose native Focus')
    inbox.setFocus(true)
    inbox.admit('next-step', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'held CLI worker evidence' }] }), { origin: 'native:cli-fixture', sequence: 'held' })
    ctx.goals.create(agent, { objective: 'must not auto continue under Focus' })
  })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    assert.equal(adapter.requests, 1)
    assert.equal(agent.inbox.notifications?.focus.queued, 1)
    console.log('FOCUS_CLI_SNAPSHOT ' + JSON.stringify({ foregroundRequests: adapter.requests, staticHoldRequests: 0, held: agent.inbox.notifications.focus.queued }))
  })
}
