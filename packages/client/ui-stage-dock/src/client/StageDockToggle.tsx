/**
 * Session-header control that shows or hides this session's stage dock.
 *
 * It sits in the header rather than behind a settings page because the dock is
 * a per-session viewing choice the operator makes while reading the thread, and
 * it renders unconditionally: a session with no binding yet is exactly the
 * session that needs the way in.
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the header actions list).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { StageDockInjected } from './slots.ts'
import { entryOf } from './store.ts'
import { NS } from './locales.ts'
import css from './StageDock.module.css'

/** Full props for the session-header stage-dock toggle. */
export type StageDockToggleProps =
  PropsRuntime<'conversation.session.header.actions'> & PropsLocale<typeof NS> & InjectFace<StageDockInjected>

/**
 * Render the stage-dock toggle.
 * @param props - the session runtime seat, the dock snapshot hook, and the dock verbs.
 * @returns the toggle button.
 */
export function StageDockToggle({ sessionId, useStageDock, toggle, t }: StageDockToggleProps) {
  const open = useStageDock(state => entryOf(state, sessionId).open)

  return (
    <button
      type="button"
      className={open ? `${css.toggle} ${css.toggleOn}` : css.toggle}
      aria-pressed={open}
      aria-label={open ? t('toggle.close') : t('toggle.open')}
      onClick={() => { toggle(sessionId) }}
    >
      {t('toggle.label')}
    </button>
  )
}
