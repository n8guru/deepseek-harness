import { describe, expect, it } from 'vitest'
import type { ContentBlock, ModelMessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { AssistantOutputFold, finalAssistantOutput, finalAssistantSource } from '../src/assistant-output.ts'

function message(content: ContentBlock[], source?: Partial<ModelMessageSource>): SessionEvent {
  return {
    type: 'assistant/message',
    data: {
      stream: [],
      message: { content, source: { kind: 'model', provider: 'mock', model: 'mock', ...source } },
    },
  } as unknown as SessionEvent
}

function textDelta(text: string): SessionEvent {
  return {
    type: 'assistant/attempt',
    data: { stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [], texts: [text] }] },
  } as unknown as SessionEvent
}

function reasoningDelta(text: string): SessionEvent {
  return {
    type: 'assistant/attempt',
    data: { stream: [{ type: 'reasoning-chunks', time0: 0, index: 0, dt: [], texts: [text] }] },
  } as unknown as SessionEvent
}

function toolResult(text: string): SessionEvent {
  return {
    type: 'tool/result',
    data: {
      message: {
        role: 'tool',
        toolCallId: 'call-1',
        content: [{ type: 'text', text }],
        isError: false,
      },
    },
  } as unknown as SessionEvent
}

describe('finalAssistantOutput', () => {
  it('selects the last non-empty message past a later empty usage-only message', () => {
    const events = [
      message([{ type: 'text', text: 'step one' }]),
      message([{ type: 'text', text: 'step two' }]),
      message([]),
    ]
    expect(finalAssistantOutput(events)).toEqual([{ type: 'text', text: 'step two' }])
  })

  it('prefers a non-empty message over text streamed before and after it', () => {
    const events = [
      textDelta('earlier partial'),
      message([{ type: 'text', text: 'complete answer' }]),
      textDelta('later partial'),
      message([]),
    ]
    expect(finalAssistantOutput(events)).toEqual([{ type: 'text', text: 'complete answer' }])
  })

  it('treats textless assistant content as a non-empty message', () => {
    const content: ContentBlock[] = [{ type: 'reasoning', text: 'complete reasoning' }]
    expect(finalAssistantOutput([
      textDelta('streamed text'),
      message(content),
      textDelta('later partial'),
    ])).toEqual(content)
  })

  it('falls back to text deltas without including reasoning or tool-result content', () => {
    const events = [
      reasoningDelta('thinking'),
      textDelta('partial '),
      toolResult('tool output'),
      textDelta('answer'),
      message([]),
    ]
    expect(finalAssistantOutput(events)).toEqual([{ type: 'text', text: 'partial answer' }])
  })

  it('returns undefined when the child produced neither messages nor text', () => {
    expect(finalAssistantOutput([])).toBeUndefined()
    expect(finalAssistantOutput([reasoningDelta('thinking'), message([])])).toBeUndefined()
  })
})

describe('AssistantOutputFold', () => {
  it('folds raw text pieces into the same streamed fallback (ACP chunk transport)', () => {
    const fold = new AssistantOutputFold()
    fold.pushText('partial ')
    fold.pushText('')
    fold.pushText('answer')
    expect(fold.collect()).toEqual([{ type: 'text', text: 'partial answer' }])
  })

  it('collects undefined until any output is folded', () => {
    expect(new AssistantOutputFold().collect()).toBeUndefined()
  })
})

describe('finalAssistantSource', () => {
  it('reads the actual provider/model that produced the selected final message', () => {
    const events = [
      message([{ type: 'text', text: 'first' }], { provider: 'anthropic', model: 'claude-opus-5-5' }),
      message([{ type: 'text', text: 'second' }], { provider: 'openai-codex', model: 'gpt-6-sol' }),
    ]
    // The actual route follows the SAME last-non-empty-message selection rule
    // as finalAssistantOutput — a requested route and an actual route can
    // differ (mesh-dsh-merge step 55's core observability gap).
    expect(finalAssistantSource(events)).toEqual({
      kind: 'model',
      provider: 'openai-codex',
      model: 'gpt-6-sol',
    })
  })

  it('is undefined when the child produced no non-empty assistant message', () => {
    expect(finalAssistantSource([])).toBeUndefined()
    expect(finalAssistantSource([textDelta('streamed only'), message([])])).toBeUndefined()
  })

  it('ignores an empty trailing message and keeps the earlier route', () => {
    const events = [
      message([{ type: 'text', text: 'answer' }], { provider: 'anthropic', model: 'claude-sonnet-5' }),
      message([]),
    ]
    expect(finalAssistantSource(events)).toEqual({
      kind: 'model',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    })
  })
})
