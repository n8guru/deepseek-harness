// TodoPanel: plan strip above the composer (the web counterpart of the TUI
// plan panel). Renders the standing todo/write whole-list snapshot (cleared on
// the next turn/start) — no data of its own, hidden while the list is empty.
// Mounted through the 'conversation.input.dock' slot (QueueDock posture): the
// dock adapter does the selecting, so the panel takes the plain list and stays
// framework-free. Visual: figma 772:51905 / 772:52972 / 772:53419.

import { useEffect, useId, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { resolveWorkspacePath, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// The domain's client-namespace pure-type outlet: one import edge delivers
// the `todos` projection-key merge (single source, no consumer-side restated
// declare) and the payload type. Type-only by construction — the outlet is
// free of host value imports, so no host Context merge enters this program.
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import { IconChecklistOutline14, IconChevronDownOutline14, IconChevronUpOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from '../locales.ts'
import css from './TodoPanel.module.css'

/** Static operator feed polled by {@link useNateTodos}; see apps/web/public/local/nate-todo.json. */
export const NATE_TODO_URL = '/local/nate-todo.json'

/** Operator item, including the file reference needed to inspect the premise. */
export interface NateTodoItem extends TodoItem {
  readonly id: string
  readonly explained_at: string
}

/**
 * Coerce the operator feed into plan items.
 * @param data - parsed JSON: `{ items: [...] }` or a bare array.
 * @returns well-formed items; anything unrecognized is dropped, not thrown.
 */
export function readNateTodos(data: unknown): readonly NateTodoItem[] {
  const raw = Array.isArray(data) ? data : (data as { items?: unknown } | null)?.items
  if (!Array.isArray(raw)) return []
  const items: NateTodoItem[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, question, explained_at, status } = entry as Record<string, unknown>
    if (status !== 'open' || typeof id !== 'string' || typeof question !== 'string'
      || typeof explained_at !== 'string' || question.length > 1000) continue
    items.push({ id, content: question, explained_at, status: 'pending' })
  }
  return items
}

/**
 * Nate's standing list, polled from a static JSON asset.
 * ponytail: polling a public file is the whole transport; move to a projection
 * key (like `todos`) once the host actually owns this list.
 * @param url - feed location.
 * @param intervalMs - poll period.
 * @returns the latest items ([] before the first response, and on any failure).
 */
export function useNateTodos(url: string = NATE_TODO_URL, intervalMs = 60_000): readonly NateTodoItem[] {
  const [items, setItems] = useState<readonly NateTodoItem[]>([])
  useEffect(() => {
    let alive = true
    const load = () => {
      void fetch(url, { cache: 'no-store' })
        .then(response => response.ok ? response.json() : null)
        .then((data) => { if (alive && data !== null) setItems(readNateTodos(data)) })
        .catch(() => { /* offline or no feed: the section simply stays empty */ })
    }
    load()
    const timer = setInterval(load, intervalMs)
    return () => { alive = false; clearInterval(timer) }
  }, [url, intervalMs])
  return items
}

export interface TodoPanelProps {
  /** The session's current plan (empty renders nothing) — selected by the dock adapter. */
  todos: readonly TodoItem[]
  /** Nate's standing list; rendered as its own labelled section above the session plan. */
  nate?: readonly NateTodoItem[] | undefined
  /** Open the item's explanation through the host workspace path service. */
  onOpenFile?: ((path: string) => void) | undefined
  /** The dock entry's locale seat, passed down as a plain prop. */
  t: TodoDockProps['t']
}

/** Local exhaustiveness helper — client packages do not depend on `dsh-llm`. */
/* v8 ignore next 3 -- closed-union backstop; only reached if status is forged */
function assertNever(value: never): never {
  throw new Error(`unreachable todo status: ${String(value)}`)
}

/** Status glyphs share the figma 14×14 artboard; the 16×16 `.glyph` cell centers them. */
function CompletedGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className={css.glyphCompleted}>
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M10.9631 5.71411L7.70154 8.97571C7.48011 9.19714 7.27736 9.40099 7.09229 9.54993C6.89742 9.70669 6.66314 9.85279 6.3634 9.90027C6.2049 9.92534 6.04339 9.92534 5.88489 9.90027C5.58515 9.85279 5.35087 9.70669 5.15601 9.54993C4.97093 9.40099 4.76818 9.19714 4.54675 8.97571L3.03516 7.46411L3.96313 6.53613L5.47473 8.04773C5.7169 8.28989 5.86196 8.43389 5.97888 8.52795C6.08597 8.61409 6.10875 8.60701 6.08997 8.604C6.11259 8.60758 6.13571 8.60758 6.15833 8.604C6.13954 8.60701 6.16232 8.61409 6.26941 8.52795C6.38633 8.43389 6.53139 8.28989 6.77356 8.04773L10.0352 4.78613L10.9631 5.71411Z"
        fill="currentColor"
      />
    </svg>
  )
}

/** In-progress: business-blue ring fading out; CSS spins the svg. */
function ProgressGlyph() {
  const gradientId = useId()
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className={css.glyphProgress}>
      <defs>
        <linearGradient id={gradientId} x1="2.5" y1="12" x2="10.5" y2="3.5" gradientUnits="userSpaceOnUse">
          <stop stopColor="currentColor" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <circle cx="7" cy="7" r="6.4" stroke={`url(#${gradientId})`} strokeWidth="1.2" />
    </svg>
  )
}

/** Pending: dashed unstarted ring (figma dash 2.4 2.4). */
function PendingGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className={css.glyphPending}>
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.4 2.4" />
    </svg>
  )
}

function StatusGlyph({ status }: { status: TodoItem['status'] }) {
  switch (status) {
    case 'completed': return <CompletedGlyph />
    case 'in_progress': return <ProgressGlyph />
    case 'pending': return <PendingGlyph />
    /* v8 ignore next -- closed TodoItem status union */
    default: return assertNever(status)
  }
}

/** Header summary: "·"-joined per-status counts; zero-count segments are omitted as noise (a non-empty list keeps at least one). */
function progressLabel(todos: readonly TodoItem[], t: TodoPanelProps['t']): string {
  const done = todos.filter(item => item.status === 'completed').length
  const active = todos.filter(item => item.status === 'in_progress').length
  const pending = todos.length - done - active
  // En spaces (U+2002): HTML collapses runs of ASCII spaces, so widening the
  // separator breathing room needs a literal wide space.
  return [
    ...done > 0 ? [t('todo.progress.done', { done })] : [],
    ...active > 0 ? [t('todo.progress.active', { active })] : [],
    ...pending > 0 ? [t('todo.progress.pending', { pending })] : [],
  ].join('\u2002·\u2002')
}

/** One labelled list section; the label is omitted while only the session plan exists. */
function TodoSection({ label, items, onOpenFile }: {
  label?: string | undefined
  items: readonly TodoItem[]
  onOpenFile?: ((path: string) => void) | undefined
}) {
  return (
    <>
      {label !== undefined && <p className={css.sectionLabel}>{label}</p>}
      {items.length === 0 && <p className={css.sectionLabel}>No open items</p>}
      <ul className={css.list}>
        {items.map(item => (
          <li key={item.content} className={css.item} data-status={item.status}>
            <span className={css.glyph} aria-hidden><StatusGlyph status={item.status} /></span>
            {'explained_at' in item && typeof item.explained_at === 'string'
              ? <button type="button" className={css.content} onClick={() => { onOpenFile?.(item.explained_at as string) }}>{item.content}</button>
              : <span className={css.content}>{item.content}</span>}
          </li>
        ))}
      </ul>
    </>
  )
}

export function TodoPanel({ todos, nate = [], onOpenFile, t }: TodoPanelProps) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <section className={css.root} data-testid="todo-panel" aria-label={t('todo.title')}>
      <div className={css.body}>
        <button
          type="button"
          className={css.header}
          aria-expanded={!collapsed}
          onClick={() => { setCollapsed(v => !v) }}
        >
          <span className={css.lead} aria-hidden><IconChecklistOutline14 /></span>
          <span className={css.title}>{t('todo.title')}</span>
          <span className={css.progress}>{progressLabel([...nate, ...todos], t)}</span>
          <span className={css.chevron} aria-hidden>
            {collapsed ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
          </span>
        </button>
        {!collapsed && (
          <div className={css.sections}>
            <TodoSection label={t('todo.section.nate')} items={nate} onOpenFile={onOpenFile} />
            <TodoSection label={t('todo.section.cadence')} items={todos} />
          </div>
        )}
      </div>
    </section>
  )
}

/** Full props of a dock entry: InputZone owner share + session standard kit + global seat + the locale seat. */
export type TodoDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'conversation'>
  & { openFile: (path: string) => void }

/** Dock adapter: host-computed 'todos' projection for Cadence + the polled operator feed for Nate. */
export function TodoDock({ useProjection, openFile, t }: TodoDockProps) {
  const todos = useProjection('todos')
  const nate = useNateTodos()
  return <TodoPanel todos={todos ?? []} nate={nate} onOpenFile={openFile} t={t} />
}

/**
 * The plan strip as a plain registrant plugin (QueueDock posture), following
 * the input-dock declaration across independent activation and reload.
 */
export const todoDockEntry = {
  name: 'conversation-todo-dock',
  inject: ['slots', 'sessions', 'workspaces'],
  /**
   * Register the plan strip before the goal and queue entries (order 0).
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.inject('conversation.input.dock', () =>
      ctx.slots.register({
        name: 'conversation.input.dock', id: 'todo', order: 0, locale: NS,
        inject: (sessionId: SessionId) => ({
          openFile: (path: string) => {
            const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
            void ctx.workspaces.openPath(resolveWorkspacePath(cwd, path.split('#', 1)[0] ?? path))
          },
        }),
      }, TodoDock))
  },
}
