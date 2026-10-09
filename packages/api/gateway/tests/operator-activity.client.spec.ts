// @vitest-environment jsdom
/** Synthetic DOM and lifecycle coverage; trusted positives live in the Chromium/native test. */
import { afterEach, expect, it, vi } from 'vitest'
import { GuiOperatorActivity } from '../src/client/operator-activity.ts'
import { RemoteStreamMuxClient } from '../src/client/stream-client.ts'
import type { ConnectionGeneration } from '@deepseek-ai/dsh-client-connection/client'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

it('drops pre-handshake/synthetic events and withdraws every mounted view on disposal', async () => {
  const root = document.createElement('div')
  root.dataset.conversationSession = 'one'
  const input = document.createElement('input')
  root.append(input)
  document.body.append(root)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(root, 'getClientRects').mockReturnValue(Object.assign([new DOMRect()], { item: () => new DOMRect() }))
  const streams = new RemoteStreamMuxClient()
  const send = vi.fn(() => true)
  let signal: AbortSignal | undefined
  let resolveFrame: ((value: IteratorResult<unknown>) => void) | undefined
  const opened = vi.spyOn(streams, 'open').mockImplementation((_endpoint, _payload, lifetime, _uplink, writable) => {
    signal = lifetime
    writable?.(send)
    return {
      [Symbol.asyncIterator]() { return this },
      next: () => new Promise((resolve) => {
        resolveFrame = resolve
        lifetime.addEventListener('abort', () => { resolve({ done: true, value: undefined }) }, { once: true })
      }),
      return: async () => ({ done: true, value: undefined }),
      throw: async (error) => { throw error },
      [Symbol.asyncDispose]: async () => {},
    }
  })
  let generation: ConnectionGeneration | undefined = { id: 1, host: { home: '/' } }
  const watchers = new Set<() => void>()
  const activity = new GuiOperatorActivity(streams, {
    getSnapshot: () => generation,
    subscribe: (listener) => { watchers.add(listener); return () => { watchers.delete(listener) } },
  })
  const dispose = activity.mount('one', root)
  expect(opened).toHaveBeenCalledOnce()
  input.dispatchEvent(new Event('input', { bubbles: true }))
  expect(send).not.toHaveBeenCalled()
  resolveFrame?.({ done: false, value: { version: 1, bindingEpoch: 'epoch-one' } })
  await Promise.resolve()
  await Promise.resolve()
  for (const type of ['input', 'keydown', 'pointerdown', 'click']) {
    const event = new Event(type, { bubbles: true })
    input.addEventListener(type, () => activity.record('one', event, 'submit'), { once: true })
    input.dispatchEvent(event)
    activity.record('one', event, 'stop')
  }
  expect(send).not.toHaveBeenCalled()
  window.dispatchEvent(new Event('blur'))
  expect(send).toHaveBeenCalledExactlyOnceWith({ version: 1, bindingEpoch: 'epoch-one', sequence: 1, interaction: 'leave' })
  expect(signal?.aborted).toBe(true)
  window.dispatchEvent(new Event('focus'))
  expect(opened).toHaveBeenCalledTimes(2)
  generation = undefined
  for (const watcher of watchers) watcher()
  expect(signal?.aborted).toBe(true)
  expect(opened).toHaveBeenCalledTimes(2)
  activity.dispose()
  dispose()
  activity.mount('one', root)()
  expect(watchers.size).toBe(0)
  window.dispatchEvent(new Event('focus'))
  expect(opened).toHaveBeenCalledTimes(2)
})

it('does not open hidden, background, detached or wrong-session occurrences', () => {
  const streams = new RemoteStreamMuxClient()
  const opened = vi.spyOn(streams, 'open')
  const activity = new GuiOperatorActivity(streams, {
    getSnapshot: () => ({ id: 1, host: { home: '/' } }),
    subscribe: () => () => {},
  })
  const root = document.createElement('div')
  root.dataset.conversationSession = 'one'
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(root, 'getClientRects').mockReturnValue(Object.assign([new DOMRect()], { item: () => new DOMRect() }))
  activity.mount('one', root) // detached
  document.body.append(root)
  activity.mount('wrong', root)
  root.hidden = true
  activity.mount('one', root)
  root.hidden = false
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  activity.mount('one', root)
  expect(opened).not.toHaveBeenCalled()
  activity.dispose()
})
