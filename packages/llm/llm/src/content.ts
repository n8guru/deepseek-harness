/** Content-block structure helpers. @module @deepseek-ai/dsh-llm/content */

import type { ContentBlock } from './types.ts'
import type { Message } from './message.ts'

/** Model-facing stand-in for an image removed to fit a provider request bound. */
export const OFFLOADED_IMAGE_TEXT
  = '[image omitted to keep the request within its image limit; older images are omitted first. If this image is still needed, read its file again when a path is available; otherwise ask the user to attach it again.]'

/**
 * True when typed model content contains an image block, walking nested
 * tool-result content. This is the one recursive image walk shared by every
 * image policy (capability gating, text-only serialization, compaction
 * survey), so a consumer cannot silently diverge on nesting depth.
 * @param content - typed model content blocks.
 * @returns whether any nested block is an image.
 */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'image'
    || (block.type === 'tool-result' && contentHasImage(block.content)))
}

/** Base64 length of raw image bytes, including padding. */
function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/**
 * Collect base64 payload lengths in request and nested-block order, tagging
 * each image with its turn group: the number of assistant messages that
 * precede it. Images only occur in non-assistant messages, so one group is one
 * step's worth of user/tool-result content.
 */
function collectImageSlots(messages: readonly Message[]): { lengths: number[]; groups: number[] } {
  const lengths: number[] = []
  const groups: number[] = []
  let group = 0
  const walk = (blocks: readonly ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'image') {
        lengths.push(base64Length(block.attachment.bytes))
        groups.push(group)
      } else if (block.type === 'tool-result') {
        walk(block.content)
      }
    }
  }
  for (const message of messages) {
    if (message.role === 'assistant') group += 1
    else walk(message.content)
  }
  return { lengths, groups }
}

/**
 * How many of the oldest images to replace. The history is replayed group by
 * group, the way it grew: nothing is dropped while the running payload fits
 * `max`; the step that first overflows drops older groups' images down to
 * `max * lowWatermarkRatio` (and the newest group's own images only as far as
 * needed to fit `max`). The result for any history prefix is therefore
 * independent of later steps, so the replaced set only changes at overflow
 * steps. A strict slide-by-one would rewrite the oldest image on EVERY step
 * once the bound is reached, which invalidates the provider prompt cache from
 * that early position onward on every request.
 */
function offloadCount(
  lengths: readonly number[],
  groups: readonly number[],
  max: number,
  lowWatermarkRatio: number,
): number {
  const low = Math.floor(max * lowWatermarkRatio)
  let total = 0
  let dropped = 0
  let index = 0
  while (index < lengths.length) {
    const group = groups[index]
    const groupStart = index
    while (index < lengths.length && groups[index] === group) {
      total += lengths[index] as number
      index += 1
    }
    if (total <= max) continue
    while (dropped < groupStart && total > low) {
      total -= lengths[dropped] as number
      dropped += 1
    }
    while (dropped < index && total > max) {
      total -= lengths[dropped] as number
      dropped += 1
    }
  }
  return dropped
}

/** Replace the first `remaining.count` image occurrences without mutating durable messages. */
function replaceOldestImages(
  blocks: readonly ContentBlock[],
  remaining: { count: number },
): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'image' && remaining.count > 0) {
      remaining.count -= 1
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: OFFLOADED_IMAGE_TEXT })
      continue
    }
    if (block.type === 'tool-result') {
      const content = replaceOldestImages(block.content, remaining)
      if (content !== block.content) {
        next ??= blocks.slice(0, index)
        next.push({ ...block, content })
        continue
      }
    }
    next?.push(block)
  }
  return next ?? blocks as ContentBlock[]
}

/**
 * Fraction of `maxRequestImageBytes` an overflow trims the history down to.
 * Offloading to the bare bound would replace one more old image on every
 * subsequent step, mutating the request prefix each time and defeating the
 * provider prompt cache (observed: every step a full-context cache write in a
 * 2000-step image-review session). Trimming to a lower watermark makes the
 * replaced set change only once per several new images.
 */
export const OFFLOAD_LOW_WATERMARK_RATIO = 0.5

/**
 * Return transient request messages whose oldest images are replaced until
 * their accumulated base64 payload fits the configured bound. The selection
 * is deterministic from durable message order and attachment metadata, and
 * stable across consecutive steps of one conversation (see
 * {@link OFFLOAD_LOW_WATERMARK_RATIO}); a provider can serialize the returned
 * messages without reading omitted bytes.
 * @param messages - complete request history, oldest first.
 * @param maxRequestImageBytes - positive bound on total base64 image payload; undefined preserves every image.
 * @param lowWatermarkRatio - fraction of the bound an overflow trims older turns down to; 1 restores strict slide-by-one offloading.
 * @returns the original messages when they already fit, otherwise shallow message copies with replaced content trees.
 */
export function offloadRequestImages(
  messages: readonly Message[],
  maxRequestImageBytes: number | undefined,
  lowWatermarkRatio: number = OFFLOAD_LOW_WATERMARK_RATIO,
): readonly Message[] {
  if (maxRequestImageBytes === undefined) return messages
  const { lengths, groups } = collectImageSlots(messages)
  const count = offloadCount(lengths, groups, maxRequestImageBytes, lowWatermarkRatio)
  if (count === 0) return messages
  const remaining = { count }
  return messages.map((message) => {
    const content = replaceOldestImages(message.content, remaining)
    return content === message.content ? message : { ...message, content }
  })
}
