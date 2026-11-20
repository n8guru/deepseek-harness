/**
 * Stage dock plugin, browser half: one overlay panel that iframes a Forage
 * Stage page, plus the session-header toggle that shows it. Both entries share
 * one controller, so the toggle and the panel read and move the same
 * per-session binding.
 *
 * The plugin issues no RPC: a Forage conversation id is not derivable from a
 * DSH session, so the binding is operator-supplied state this package owns and
 * persists browser-side. The stage's own content never passes through here —
 * it is entirely the iframed page's.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { StageDockPanel } from './StageDockPanel.tsx'
import { StageDockToggle } from './StageDockToggle.tsx'
import { StageDockController } from './store.ts'
import type { StageDockInjected } from './slots.ts'
import { en, NS, zh, type StageDockKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Stage dock copy. */
    'stageDock': StageDockKey
  }
}

export type { StageDockPanelProps } from './StageDockPanel.tsx'
export type { StageDockToggleProps } from './StageDockToggle.tsx'
export type { StageDockInjected } from './slots.ts'
export type { StageDockEntry, StageDockState } from './store.ts'

/** Required services for locale registration and the two slot contributions. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the dictionaries, the overlay panel, and the
 * header toggle.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const controller = new StageDockController()
  const injected = (): StageDockInjected => ({
    hooks: { stageDock: controller.store },
    toggle: (sessionId: string) => { controller.toggle(sessionId) },
    attach: (sessionId: string, value: string) => { controller.attach(sessionId, value) },
  })

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-stage-dock: dictionaries')

  ctx.slots.inject(
    'shell.overlay',
    () => ctx.slots.register({
      name: 'shell.overlay',
      id: 'stage-dock',
      // Behind transient surfaces (the command popup at 1): a persistent dock
      // must not paint over a shell the operator just opened.
      order: 100,
      locale: NS,
      inject: injected,
    }, StageDockPanel),
  )

  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'stage-dock',
      // After the background-job list: process work reads before view controls.
      order: 30,
      locale: NS,
      inject: injected,
    }, StageDockToggle),
  )
}
