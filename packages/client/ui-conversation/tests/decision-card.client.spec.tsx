// @vitest-environment jsdom
/**
 * Decision-card acceptance: fenced-block parsing (including the malformed and
 * still-streaming fallbacks), the option/custom answer path through the
 * composer actions, and the lock derived from a tagged user message.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import {
  answerViaComposer, DecisionCard, findDecisionAnswer,
} from '../src/client/chat/DecisionCard.tsx'
import { splitDecisionCards } from '../src/client/chat/decision-card-parse.ts'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh, commonZh) as never

afterEach(cleanup)

const CARD_JSON = JSON.stringify({
  id: 'dock-shape',
  question: '停靠条用哪种形态？',
  options: [
    { label: '紧凑', detail: '只显示计数', recommended: true },
    { label: '完整' },
  ],
})
const TEXT = `before\n\n\`\`\`decision-card\n${CARD_JSON}\n\`\`\`\n\nafter`

function snapshotWith(text: string): ConversationSnapshot {
  return { nodes: [{ kind: 'user', seq: 1, time: 0, content: [{ type: 'text', text }], source: null }] } as unknown as ConversationSnapshot
}

describe('splitDecisionCards', () => {
  it('splits prose around a fenced card', () => {
    const segments = splitDecisionCards(TEXT)
    expect(segments.map(s => s.kind)).toEqual(['markdown', 'card', 'markdown'])
    expect(segments[1]).toMatchObject({ card: { id: 'dock-shape' } })
  })

  it('leaves malformed JSON and unterminated fences as plain markdown', () => {
    expect(splitDecisionCards('```decision-card\n{ nope\n```')).toEqual([{ kind: 'markdown', text: '```decision-card\n{ nope\n```' }])
    const streaming = `\`\`\`decision-card\n${CARD_JSON}`
    expect(splitDecisionCards(streaming)).toEqual([{ kind: 'markdown', text: streaming }])
  })

  it('drops cards with no usable option', () => {
    expect(splitDecisionCards('```decision-card\n{"id":"x","question":"q","options":[]}\n```')[0]?.kind).toBe('markdown')
  })
})

describe('DecisionCard', () => {
  const card = splitDecisionCards(TEXT)[1] as { kind: 'card'; card: never }

  it('marks the recommended option and answers by label', () => {
    const onAnswer = vi.fn()
    render(<DecisionCard card={card.card} onAnswer={onAnswer} t={t} />)
    const recommended = screen.getByRole('button', { name: /紧凑/ })
    expect(recommended.dataset.recommended).toBe('true')
    expect(screen.getByText('推荐')).toBeTruthy()
    fireEvent.click(recommended)
    expect(onAnswer).toHaveBeenCalledWith('紧凑')
  })

  it('sends custom text and locks once answered', () => {
    const onAnswer = vi.fn()
    const { rerender } = render(<DecisionCard card={card.card} onAnswer={onAnswer} t={t} />)
    const input = screen.getByLabelText('其他答案…')
    fireEvent.change(input, { target: { value: '两列布局' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(onAnswer).toHaveBeenCalledWith('两列布局')

    rerender(<DecisionCard card={card.card} answer="紧凑" onAnswer={onAnswer} t={t} />)
    expect(screen.getByText('已回答：紧凑')).toBeTruthy()
    expect(screen.queryByLabelText('其他答案…')).toBeNull()
    const chosen = screen.getByRole('button', { name: /紧凑/ })
    expect(chosen.dataset.chosen).toBe('true')
    fireEvent.click(chosen)
    expect(onAnswer).toHaveBeenCalledTimes(1) // only the custom send; the locked click did not fire
  })

  it('renders read-only without the session kit', () => {
    render(<DecisionCard card={card.card} t={t} />)
    expect(screen.getByRole('button', { name: /紧凑/ }).hasAttribute('disabled')).toBe(true)
  })
})

describe('answer delivery', () => {
  it('drafts the tagged message and submits it', () => {
    const actions = { setDraft: vi.fn(), submit: vi.fn(), addImages: vi.fn(), removeImage: vi.fn(), pruneImages: vi.fn() }
    answerViaComposer(actions, 'dock-shape', '紧凑')
    expect(actions.setDraft).toHaveBeenCalledWith('[decision-card dock-shape] 紧凑')
    expect(actions.submit).toHaveBeenCalled()
  })

  it('locks the card from the matching tagged user message only', () => {
    expect(findDecisionAnswer(snapshotWith('[decision-card dock-shape] 紧凑'), 'dock-shape')).toBe('紧凑')
    expect(findDecisionAnswer(snapshotWith('[decision-card other] 紧凑'), 'dock-shape')).toBeUndefined()
  })
})
