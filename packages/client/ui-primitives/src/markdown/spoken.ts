/**
 * Shared spoken-tag recognition for presentation and voice playback.
 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Root, RootContent } from 'mdast'

/** Half-open UTF-16 source offsets; content excludes markers only for spoken segments. */
export interface SpokenSegment {
  kind: 'text' | 'spoken'
  start: number
  end: number
  contentStart: number
  contentEnd: number
  /** Whitespace-normalized spoken content with code removed; empty for ordinary text. */
  speechText: string
}

/**
 * Partition source around complete, case-insensitive spoken pairs outside Markdown code.
 * Unclosed tags remain literal until completed. Nested tags retain the legacy first-close
 * behavior. Offsets always address the original string, not the code-masked projection.
 * @param text - Raw assistant Markdown, unchanged by this function.
 * @returns Ordered segments covering the entire input (empty input yields no segments).
 */
export function parseSpokenSegments(text: string): SpokenSegment[] {
  if (!/<spoken>/i.test(text)) return text ? [plain(0, text.length)] : []
  // HTML must not hide Markdown code inside a spoken block.
  const tree = fromMarkdown(text, { extensions: [{ disable: { null: ['htmlFlow', 'htmlText'] } }] })
  const ranges: Array<[number, number]> = []
  function visit(node: Root | RootContent): void {
    if (node.type === 'code' || node.type === 'inlineCode') {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start !== undefined && end !== undefined) ranges.push([start, end])
    } else if ('children' in node) {
      for (const child of node.children) visit(child)
    }
  }
  visit(tree)
  let masked = ''
  let cursor = 0
  for (const [start, end] of ranges) {
    masked += text.slice(cursor, start) + ' '.repeat(end - start)
    cursor = end
  }
  masked += text.slice(cursor)
  const segments: SpokenSegment[] = []
  cursor = 0
  for (const match of masked.matchAll(/<spoken>([\s\S]*?)<\/spoken>/gi)) {
    const start = match.index
    const end = start + match[0].length
    if (start > cursor) segments.push(plain(cursor, start))
    segments.push({
      kind: 'spoken', start, end, contentStart: start + 8, contentEnd: end - 9,
      speechText: (match[1] ?? '').replace(/\s+/g, ' ').trim(),
    })
    cursor = end
  }
  if (cursor < text.length) segments.push(plain(cursor, text.length))
  return segments
}

function plain(start: number, end: number): SpokenSegment {
  return { kind: 'text', start, end, contentStart: start, contentEnd: end, speechText: '' }
}
