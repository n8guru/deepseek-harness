import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '../src/index.ts'
import { SessionCommandController } from '../../../api/session-controller/src/commands.ts'
import { pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'

// The Codex app-server adapter is an out-of-tree native artifact (DGPisces
// dsh-openai-oauth). Point DSH_CODEX_ADAPTER_LIB at its compiled lib/index.js
// to run this proof; without it the spec is skipped instead of failing to
// resolve a host-specific absolute path.
const adapterLib = process.env.DSH_CODEX_ADAPTER_LIB
const { CodexAppServerAdapter } = adapterLib
  ? await import(pathToFileURL(adapterLib).href)
  : { CodexAppServerAdapter: undefined as never }

/** Real controller -> native loop/tool/inbox -> compiled staged adapter.
 * Only the remote Codex model endpoint is keyless/scripted; no live session.
 */
it.skipIf(!adapterLib).each(['steer', 'queue'] as const)('preserves two ordered controller replies with %s delivery during toolwork', async mode => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const events: any[] = []
  const order: any[] = []
  const server = {
    account: async () => ({ type: 'chatgpt' }),
    models: async () => [{ id: 'fixture', model: 'fixture', inputModalities: ['text'] }],
    startThread: async () => 'thread-fixture',
    startTurn: async (_thread: string, input: any) => {
      order.push(['start', input.input])
      const startCount = order.filter(entry => entry[0] === 'start').length
      if (startCount > 1) {
        const nextTurn = 'next-turn-' + startCount
        events.push(
          { method: 'item/agentMessage/delta', params: { threadId: 'thread-fixture', turnId: nextTurn, itemId: 'next-answer', delta: 'next-turn reply' } },
          { method: 'item/completed', params: { threadId: 'thread-fixture', turnId: nextTurn, item: { id: 'next-answer', type: 'agentMessage' } } },
          { method: 'turn/completed', params: { threadId: 'thread-fixture', turnId: nextTurn, turn: { id: nextTurn, status: 'completed' } } },
        )
        return nextTurn
      }
      events.push({ method: 'item/tool/call', requestId: 1, params: {
        threadId: 'thread-fixture', turnId: 'turn-fixture', callId: 'call-fixture', tool: 'blocked', arguments: {},
      } })
      return 'turn-fixture'
    },
    nextTurnEvent: async (_thread: string, _turn: string, signal: AbortSignal) => {
      if (events.length) return events.shift()
      return new Promise((_resolve, reject) => {
        const abort = () => reject(signal.reason)
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    },
    steerTurn: async (thread: string, turn: string, input: any) => { order.push(['steer', thread, turn, input]) },
    respond: () => {
      order.push(['result'])
      events.push(
        { method: 'item/agentMessage/delta', params: { threadId: 'thread-fixture', turnId: 'turn-fixture', itemId: 'answer', delta: 'received both' } },
        { method: 'item/completed', params: { threadId: 'thread-fixture', turnId: 'turn-fixture', item: { id: 'answer', type: 'agentMessage' } } },
        { method: 'turn/completed', params: { threadId: 'thread-fixture', turnId: 'turn-fixture', turn: { id: 'turn-fixture', status: 'completed' } } },
      )
    },
  }
  ctx.llm.registerAdapter(['openai-codex'], new CodexAppServerAdapter(server as never))
  let entered!: () => void
  let release!: () => void
  const inTool = new Promise<void>(resolve => { entered = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  onTestFinished(() => release())
  ctx.tools.register(defineContentToolFixture({
    name: 'blocked', description: 'blocked fixture', parameters: {},
    execute: async () => { entered(); await released; return [{ type: 'text', text: 'tool done' }] },
  }))
  const agent = await ctx.agentLoop.create(SessionId('midturn-fixture'), { provider: 'openai-codex', model: 'fixture' })
  // Only unrelated attachment storage / resolver are fixture plumbing.
  ctx.provide('attachments', { admitPromptContent: async (content: any) => content } as never)
  ctx.provide('fileUploads', {
    resolve: () => undefined,
    bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }),
  } as never)
  const commands = new SessionCommandController(ctx, { resolveAgent: async () => ({ agent }) } as never, '/tmp')
  const prompt = (text: string, requestId: string, mode: 'queue' | 'steer') => commands.prompt({
    sessionId: agent.id, requestId, mode, content: [{ type: 'text', text }],
  } as never)
  await prompt('begin toolwork', 'initial', 'queue')
  await inTool
  const replies = ['I heard that - but it is wrong voice.', 'I heard ... via compter voice only.']
  for (const [index, text] of replies.entries()) {
    expect(await prompt(text, 'human-' + index, mode)).toEqual({ accepted: true })
  }
  // Duplicate controller request must not double admit.
  await prompt(replies[0]!, 'human-0', mode)
  expect(mode === 'steer' ? agent.inbox.nextStep : agent.inbox.nextTurn).toHaveLength(2)
  expect(order.map(entry => entry[0])).toEqual(['start'])
  release()
  await agent.whenIdle()
  if (mode === 'steer') {
    expect(order.map(entry => entry[0])).toEqual(['start', 'steer', 'result'])
    expect(order[1].slice(1, 3)).toEqual(['thread-fixture', 'turn-fixture'])
    expect(order[1][3]).toEqual(replies.map(text => ({ type: 'text', text })))
  } else {
    // Accepted queue-mode inputs are deliberately invisible before this final.
    expect(order.map(entry => entry[0])).toEqual(['start', 'result', 'start', 'start'])
    expect(order.slice(2).map(entry => entry[1])).toEqual(replies.map(text => [{ type: 'text', text }]))
  }
  expect(agent.inbox.nextStep).toHaveLength(0)
  expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(mode === 'steer' ? 1 : 3)
})
