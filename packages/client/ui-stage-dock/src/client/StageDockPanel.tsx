/**
 * The Stage dock: a frame-wide overlay panel pinned to the right edge, holding
 * an iframe of the Forage Stage page for the conversation this session is bound
 * to.
 *
 * It lives in `shell.overlay` rather than in a conversation column because the
 * stage must be unaffected by transcript scroll — the overlay layer sits above
 * every column and outside their scroll containers, so that property is
 * structural rather than a styling accident.
 *
 * The panel is deliberately thin. Everything on the board — cards, links, drag,
 * the highlight pulse, the ordered event feed — is the Stage page's own work
 * behind a URL. The dock contributes the binding, the visibility, and nothing
 * else.
 */

import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-layout SlotMap merge (the 'shell.overlay' declaration).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { StageDockInjected } from './slots.ts'
import { entryOf } from './store.ts'
import { NS } from './locales.ts'
import css from './StageDock.module.css'

/**
 * Origin of the Stage page. The charter keeps the stage independent of its
 * host, so the dock is a viewer of the live Forage deployment rather than
 * something this repository serves.
 * ponytail: one const, not configuration — a second deployment makes it a
 * `process.env.DSH_CLIENT_*` build value.
 */
const STAGE_ORIGIN = 'https://forage.ink'

/** Full props for the stage dock panel. */
export type StageDockPanelProps =
  PropsRuntime<'shell.overlay'> & PropsLocale<typeof NS> & InjectFace<StageDockInjected>

/**
 * Render the stage dock for the current session.
 * @param props - the global runtime seat, the dock snapshot hook, and the dock verbs.
 * @returns the pinned panel, or null while no session has its dock showing.
 */
export function StageDockPanel({ useSessions, useStageDock, toggle, attach, t }: StageDockPanelProps) {
  const sessionId = useSessions(state => state.current)
  // Two primitive selectors rather than one object selector: the bound hook
  // compares with Object.is, so a freshly built entry would re-render on every
  // unrelated store write.
  const open = useStageDock(state => entryOf(state, sessionId).open)
  const conversationId = useStageDock(state => entryOf(state, sessionId).conversationId)
  const [draft, setDraft] = useState('')

  if (sessionId === undefined || !open) return null

  const submit = (): void => {
    attach(sessionId, draft)
    setDraft('')
  }

  return (
    <aside className={css.panel} aria-label={t('panel.aria')}>
      <div className={css.head}>
        <span className={css.title}>{t('panel.title')}</span>
        <span className={css.bound}>
          {conversationId === null ? t('panel.unbound') : t('panel.bound', { id: conversationId })}
        </span>
        <input
          className={css.field}
          type="text"
          inputMode="numeric"
          value={draft}
          aria-label={t('field.aria')}
          placeholder={t('field.placeholder')}
          onChange={(event) => { setDraft(event.currentTarget.value) }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            submit()
          }}
        />
        <button type="button" className={css.action} onClick={submit}>{t('attach')}</button>
        <button
          type="button"
          className={css.action}
          aria-label={t('toggle.close')}
          onClick={() => { toggle(sessionId) }}
        >
          ×
        </button>
      </div>
      {conversationId === null
        ? <p className={css.empty}>{t('empty')}</p>
        : (
          <iframe
            className={css.frame}
            src={`${STAGE_ORIGIN}/stage/${conversationId}`}
            title={t('frame.title', { id: conversationId })}
            // The Stage page runs its own script and reads its own SSE feed, so
            // it keeps its script capability and its own origin. Nothing more:
            // no popups, no top-level navigation, no form submission.
            sandbox="allow-scripts allow-same-origin"
          />
        )}
    </aside>
  )
}
