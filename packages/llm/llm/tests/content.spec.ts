import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CallId, createAssistantMessage, createUserMessage, OFFLOADED_IMAGE_TEXT, offloadRequestImages } from '../src/index.ts'
import type { ContentBlock, Message } from '../src/index.ts'

const source = { kind: 'plugin' as const, plugin: 'test' }

function image(bytes: number): ContentBlock {
  return {
    type: 'image',
    attachment: {
      attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
      mediaType: 'image/png',
      bytes,
      width: 1,
      height: 1,
    },
  }
}

describe('offloadRequestImages', () => {
  it('preserves the original request when its base64 payload fits exactly', () => {
    const messages = [createUserMessage({ content: [image(3), image(3)], source })]
    expect(offloadRequestImages(messages, 8)).toBe(messages)
  })

  it('keeps five 3 MiB images at 20 MiB and offloads the oldest after one more raw byte', () => {
    const rawImageBytes = 3 * 1024 * 1024
    const maxRequestImageBytes = 20 * 1024 * 1024
    const exact = [createUserMessage({
      content: Array.from({ length: 5 }, () => image(rawImageBytes)),
      source,
    })]
    expect(offloadRequestImages(exact, maxRequestImageBytes)).toBe(exact)

    const over = [createUserMessage({
      content: [image(rawImageBytes + 1), ...Array.from({ length: 4 }, () => image(rawImageBytes))],
      source,
    })]
    expect(offloadRequestImages(over, maxRequestImageBytes)[0]?.content).toEqual([
      { type: 'text', text: OFFLOADED_IMAGE_TEXT },
      ...Array.from({ length: 4 }, () => image(rawImageBytes)),
    ])
  })

  it('replaces the oldest nested occurrences without mutating durable messages', () => {
    const shared = image(3)
    const messages = [
      createUserMessage({
        content: [{
          type: 'tool-result',
          toolCallId: CallId('shot'),
          content: [shared],
        }],
        source,
      }),
      createUserMessage({ content: [shared, image(3)], source }),
    ]

    const fitted = offloadRequestImages(messages, 8)
    expect(fitted).not.toBe(messages)
    expect(fitted[0]?.content).toEqual([{
      type: 'tool-result',
      toolCallId: CallId('shot'),
      content: [{ type: 'text', text: OFFLOADED_IMAGE_TEXT }],
    }])
    expect(fitted[1]?.content).toEqual([shared, image(3)])
    expect(messages[0]?.content[0]).toMatchObject({ type: 'tool-result', content: [shared] })
  })

  it('replaces a single image that cannot fit', () => {
    const messages = [createUserMessage({ content: [image(300)], source })]
    expect(offloadRequestImages(messages, 8)[0]?.content)
      .toEqual([{ type: 'text', text: OFFLOADED_IMAGE_TEXT }])
  })

  it('keeps unchanged nested content while replacing a later image', () => {
    const nested = {
      type: 'tool-result' as const,
      toolCallId: CallId('text-only'),
      content: [{ type: 'text' as const, text: 'kept' }],
    }
    const messages = [createUserMessage({ content: [nested, image(3)], source })]
    expect(offloadRequestImages(messages, 1)[0]?.content).toEqual([
      nested,
      { type: 'text', text: OFFLOADED_IMAGE_TEXT },
    ])
  })

  describe('prompt-cache stability across steps', () => {
    const raw = 3 * 1024 * 1024 // 4 MiB base64 each
    const max = 20 * 1024 * 1024 // five images fit
    const assistant = () => createAssistantMessage({ content: [{ type: 'text', text: 'ok' }], source: { provider: 'p', model: 'm' } })

    /** Grow a history one single-image step at a time, returning each step's request. */
    function growth(steps: number, ratio?: number): readonly (readonly string[])[] {
      const history: Message[] = [createUserMessage({ content: [{ type: 'text', text: 'review' }], source })]
      const requests: string[][] = []
      for (let step = 0; step < steps; step += 1) {
        history.push(assistant())
        history.push(createUserMessage({
          content: [{ type: 'tool-result', toolCallId: CallId(`c${step}`), content: [image(raw)] }],
          source,
        }))
        const fitted = ratio === undefined
          ? offloadRequestImages(history, max)
          : offloadRequestImages(history, max, ratio)
        requests.push(fitted.map(message => JSON.stringify(message.content.map(block => block.type === 'tool-result'
          ? block.content.map(inner => inner.type)
          : block.type))))
      }
      return requests
    }

    /** Number of steps whose request rewrites a message the previous request already sent. */
    function mutatingSteps(requests: readonly (readonly string[])[]): number {
      let count = 0
      for (let step = 1; step < requests.length; step += 1) {
        const previous = requests[step - 1] as readonly string[]
        const current = requests[step] as readonly string[]
        if (previous.some((entry, index) => entry !== current[index])) count += 1
      }
      return count
    }

    it('slide-by-one (ratio 1) rewrites an earlier message on every step past the bound', () => {
      const requests = growth(30, 1)
      expect(mutatingSteps(requests)).toBe(30 - 5)
    })

    it('the default low watermark rewrites earlier messages only on overflow steps', () => {
      const requests = growth(30)
      // Overflow every ~3 images (trim 5 -> 2 of 5), not every step.
      expect(mutatingSteps(requests)).toBeLessThanOrEqual(9)
      expect(mutatingSteps(requests)).toBeGreaterThan(0)
    })

    it('never exceeds the bound and keeps the newest images', () => {
      const history: Message[] = [createUserMessage({ content: [image(raw)], source })]
      for (let step = 0; step < 12; step += 1) {
        history.push(assistant(), createUserMessage({ content: [image(raw)], source }))
        const fitted = offloadRequestImages(history, max)
        const kept = fitted.filter(message => message.content.some(block => block.type === 'image')).length
        expect(kept).toBeLessThanOrEqual(5)
        expect(fitted.at(-1)?.content[0]?.type).toBe('image')
      }
    })

    it('trims only as far as needed when the newest step alone overflows', () => {
      const history = [
        createUserMessage({ content: [image(raw), image(raw)], source }),
        assistant(),
        createUserMessage({ content: Array.from({ length: 5 }, () => image(raw)), source }),
      ]
      const fitted = offloadRequestImages(history, max)
      // Older group fully dropped to reach the watermark; the newest five all fit the bound and survive.
      expect(fitted[0]?.content.every(block => block.type === 'text')).toBe(true)
      expect(fitted[2]?.content.every(block => block.type === 'image')).toBe(true)
    })

    it('an image offloaded for a history prefix stays offloaded as the history grows', () => {
      const history: Message[] = [createUserMessage({ content: [image(raw)], source })]
      for (let step = 0; step < 8; step += 1) history.push(assistant(), createUserMessage({ content: [image(raw)], source }))
      const full = offloadRequestImages(history, max)
      for (let length = 1; length <= history.length; length += 1) {
        const prefix = offloadRequestImages(history.slice(0, length), max)
        prefix.forEach((message, index) => {
          if (message.content.some(block => block.type === 'text' && block.text === OFFLOADED_IMAGE_TEXT)) {
            expect(full[index]?.content.some(block => block.type === 'text' && block.text === OFFLOADED_IMAGE_TEXT)).toBe(true)
          }
        })
      }
    })
  })
})
