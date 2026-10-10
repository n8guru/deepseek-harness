/**
 * ui-stage-dock plugin halves: the browser entry's dictionary and its two slot
 * registrations against the real SlotRegistry (with fiber teardown proving
 * removal — HMR safety), the inert node entry, and the invariant companion's
 * ownership reservation.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import type { StageDockInjected } from '../src/client/slots.ts'
import { entryOf } from '../src/client/store.ts'
import { apply as applyNode } from '../src/index.ts'
import * as StageDockInvariant from '../src/invariant.ts'
import { en, NS, zh } from '../src/client/locales.ts'

/** The face an entry's inject factory produces, as the ledger hands it back. */
type InjectedFace = StageDockInjected

/** Entry ids currently registered in one slot. */
function entryIds(ctx: Context, slot: string): (string | undefined)[] {
  return ctx.slots.entries(slot as never).map(entry => entry.options.id)
}

/** Boot the browser half over a real slot tree declaring both target slots. */
async function bench(): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']> }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'shell.overlay': { kind: 'list', scope: 'root' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
  ctx.provide('sessions', {})
  // The locale plugin binds a settings scope, which reads the connection handle
  // and the forwarded-event port.
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  // These specs assert the shipped Chinese copy. There is no jsdom `window` in
  // this lane, so browser-language detection never runs and the locale comes
  // from FALLBACK_LOCALE (en): state the asserted locale explicitly.
  ctx.locale.setLocale('zh')
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber }
}

describe('ui-stage-dock browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('seats the dock in the frame overlay, not in a conversation column', async () => {
    // The scroll-independence claim is this registration, not a stylesheet: an
    // entry in `shell.overlay` renders above every column and outside their
    // scroll containers.
    const { ctx, fiber } = await bench()
    expect(entryIds(ctx, 'shell.overlay')).toContain('stage-dock')
    await fiber.dispose()
    expect(entryIds(ctx, 'shell.overlay')).not.toContain('stage-dock')
  })

  it('registers the header toggle, and fiber teardown removes it (HMR safety)', async () => {
    const { ctx, fiber } = await bench()
    expect(entryIds(ctx, 'conversation.session.header.actions')).toContain('stage-dock')
    await fiber.dispose()
    expect(entryIds(ctx, 'conversation.session.header.actions')).not.toContain('stage-dock')
  })

  it('hands both entries one controller, so the toggle and the panel share a binding', async () => {
    const { ctx, fiber } = await bench()
    const faces = ['shell.overlay', 'conversation.session.header.actions'].map((slot) => {
      const entry = ctx.slots.entries(slot as never).find(candidate => candidate.options.id === 'stage-dock')
      if (entry === undefined) throw new Error(`no stage-dock entry in ${slot}`)
      return (entry.inject as unknown as () => InjectedFace)()
    })
    const [panel, toggle] = faces
    if (panel === undefined || toggle === undefined) throw new Error('both entries must inject a face')
    expect(panel.hooks.stageDock).toBe(toggle.hooks.stageDock)

    // One store, two entries: what the toggle moves is what the panel reads.
    toggle.toggle('s1')
    expect(entryOf(panel.hooks.stageDock.getSnapshot(), 's1').open).toBe(true)
    panel.attach('s1', '7')
    expect(entryOf(toggle.hooks.stageDock.getSnapshot(), 's1').conversationId).toBe(7)
    await fiber.dispose()
  })

  it('registers both dictionaries under its own namespace and releases them with the fiber', async () => {
    const { ctx, fiber } = await bench()
    const translate = ctx.locale.bind(NS)
    expect(translate('panel.aria')).toBe(zh['panel.aria'])
    ctx.locale.setLocale('en')
    expect(translate('panel.aria')).toBe(en['panel.aria'])

    // Withdrawn dictionaries leave the key unresolved rather than translated.
    await fiber.dispose()
    expect(translate('panel.aria')).not.toBe(en['panel.aria'])
  })

  it('keeps the English dictionary key-identical to the Chinese source of truth', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('ui-stage-dock node half', () => {
  it('contributes no host behavior', () => {
    // The node half exists only so the plugin appears in the Loader tree.
    expect(applyNode).not.toThrow()
  })
})

describe('ui-stage-dock invariant companion', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(StageDockInvariant)
    await fiber.await()
    expect(StageDockInvariant.name).toBe('client-ui-stage-dock-invariant')
    expect(StageDockInvariant.inject).toEqual(['invariants'])
    // Emitting an unrelated event proves the companion installed no audit.
    expect(() => { (ctx.emit as (event: string) => void)('slots/changed') }).not.toThrow()
    await fiber.dispose()
  })
})
