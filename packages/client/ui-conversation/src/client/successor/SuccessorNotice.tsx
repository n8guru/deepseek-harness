// SuccessorNotice: the one dismissible "Cadence moved to generation N+1" line.
// Mounted in the conversation.input.dock strip; reads the tab's
// SuccessorFollower (no data of its own) and renders nothing without a notice.

import { useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from '../locales.ts'
import type { SuccessorFollower, SuccessorNotice as Notice } from './follow.ts'
import css from './SuccessorNotice.module.css'

/** Full props of the dock entry: the runtime share plus the locale seat. */
export type SuccessorDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'conversation'>

/** Framework-free view props. */
export interface SuccessorNoticeViewProps {
  notice: Notice | null
  t: SuccessorDockProps['t']
  onPrevious: () => void
  onSuccessor: () => void
  onDismiss: () => void
}

/** The notice line itself (pure). */
export function SuccessorNoticeView({ notice, t, onPrevious, onSuccessor, onDismiss }: SuccessorNoticeViewProps) {
  if (notice === null) return null
  const vars = { generation: notice.generation }
  return (
    <div className={css.root} role="status" data-testid="successor-notice" data-kind={notice.kind}>
      <span className={css.text}>{t(`successor.${notice.kind}`, vars)}</span>
      {notice.kind === 'moved' && (
        <button type="button" className={css.link} onClick={onPrevious}>{t('successor.previous')}</button>
      )}
      {notice.kind === 'superseded' && (
        <button type="button" className={css.link} onClick={onSuccessor}>{t('successor.goCurrent')}</button>
      )}
      {(notice.kind === 'conflict' || notice.kind === 'failed') && (
        <button type="button" className={css.link} onClick={onSuccessor}>{t('successor.openNext', vars)}</button>
      )}
      <button type="button" className={css.dismiss} onClick={onDismiss} aria-label={t('successor.dismiss')}>
        <IconCloseOutline16 size={14} />
      </button>
    </div>
  )
}

/**
 * The dock entry as a registrant plugin bound to one tab follower.
 * @param follower - this tab's follower.
 * @returns a Cordis plugin object.
 */
export function successorDockEntry(follower: SuccessorFollower) {
  function SuccessorDock({ t }: SuccessorDockProps) {
    const notice = useSyncExternalStore(follower.subscribe, follower.getSnapshot)
    return (
      <SuccessorNoticeView
        notice={notice}
        t={t}
        onPrevious={() => { follower.openPrevious() }}
        onSuccessor={() => { follower.openSuccessor() }}
        onDismiss={() => { follower.dismiss() }}
      />
    )
  }
  return {
    name: 'conversation-successor-dock',
    inject: ['slots'],
    apply(ctx: Context): void {
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({ name: 'conversation.input.dock', id: 'successor', order: -10, locale: NS }, SuccessorDock))
    },
  }
}
