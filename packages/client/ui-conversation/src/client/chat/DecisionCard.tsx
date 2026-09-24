// DecisionCard: an assistant-authored question rendered as a form inside the
// message body. The answer travels the ordinary composer path — setDraft then
// submit — so it lands as a normal user message, is persisted by the session
// like any other, and needs no new transport. The message carries the
// `[decision-card <id>]` tag, which is also how the card locks: a card whose tag
// already appears in a user message renders its chosen answer read-only.

import { useState } from 'react'
import type { ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeViewProps, ChatViewSlotProps } from '../contract/slots.ts'
import type { InputActions } from '../input/contract.ts'
import type { DecisionCardSpec } from './decision-card-parse.ts'
import { decisionTag, optionId } from './decision-card-parse.ts'
import css from './DecisionCard.module.css'

export interface DecisionCardProps {
  card: DecisionCardSpec
  /** Text the user already sent for this card; present = locked. */
  answer?: string | undefined
  /** Send one answer through the composer; absent = read-only (no session kit). */
  onAnswer?: ((text: string) => void) | undefined
  t: ChatViewSlotProps['t']
}

/**
 * Newest user message answering this card.
 * @param snapshot - the live conversation snapshot.
 * @param id - decision id to match.
 * @returns the answer text after the tag, or undefined while unanswered.
 */
export function findDecisionAnswer(snapshot: ConversationSnapshot, id: string): string | undefined {
  const tag = decisionTag(id)
  for (let i = snapshot.nodes.length - 1; i >= 0; i--) {
    const node = snapshot.nodes[i]
    if (node === undefined || node.kind !== 'user') continue
    for (const block of node.content) {
      // Structural read: any content block exposing string `text` counts, so
      // the lock does not depend on the block union's current shape.
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text.includes(tag)) {
        return text.slice(text.indexOf(tag) + tag.length).trim()
      }
    }
  }
  return undefined
}

/** Deliver one answer as a tagged user message through the existing input machine. */
export function answerViaComposer(actions: InputActions, id: string, answer: string): void {
  actions.setDraft(`${decisionTag(id)} ${answer}`)
  actions.submit()
}

export function DecisionCard({ card, answer, onAnswer, t }: DecisionCardProps) {
  const [custom, setCustom] = useState('')
  const locked = answer !== undefined || onAnswer === undefined
  const allowCustom = card.allowCustom !== false

  return (
    <section className={css.root} data-testid="decision-card" data-decision={card.id} aria-label={card.question}>
      <p className={css.question}>{card.question}</p>
      <div className={css.options}>
        {card.options.map(option => (
          <button
            key={optionId(option)}
            type="button"
            className={css.option}
            data-recommended={option.recommended === true}
            data-chosen={answer === option.label}
            disabled={locked}
            onClick={() => { onAnswer?.(option.label) }}
          >
            <span className={css.label}>{option.label}</span>
            {option.detail !== undefined && <span className={css.detail}>{option.detail}</span>}
            {option.recommended === true && <span className={css.badge}>{t('decision.recommended')}</span>}
          </button>
        ))}
      </div>
      {allowCustom && !locked && (
        <div className={css.custom}>
          <input
            className={css.customInput}
            value={custom}
            placeholder={t('decision.customPlaceholder')}
            aria-label={t('decision.customPlaceholder')}
            onChange={(event) => { setCustom(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || custom.trim() === '') return
              event.preventDefault()
              onAnswer?.(custom.trim())
            }}
          />
          <button
            type="button"
            className={css.send}
            disabled={custom.trim() === ''}
            onClick={() => { onAnswer?.(custom.trim()) }}
          >
            {t('decision.send')}
          </button>
        </div>
      )}
      {answer !== undefined && <p className={css.answered}>{t('decision.answered', { answer })}</p>}
    </section>
  )
}

export interface DecisionCardBlockProps {
  card: DecisionCardSpec
  /** Session snapshot reader: the lock is derived, never stored in the card. */
  useSession: ChatNodeViewProps['useSession']
  /** The session's composer actions — the one delivery route for an answer. */
  inputActions: ChatNodeViewProps['inputActions']
  t: ChatViewSlotProps['t']
}

/** Live card: reads its lock off the transcript and answers through the composer. */
export function DecisionCardBlock({ card, useSession, inputActions, t }: DecisionCardBlockProps) {
  const answer = useSession(snapshot => findDecisionAnswer(snapshot, card.id))
  return (
    <DecisionCard
      card={card}
      answer={answer}
      onAnswer={(text) => { answerViaComposer(inputActions, card.id, text) }}
      t={t}
    />
  )
}
