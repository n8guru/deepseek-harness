/**
 * Shared prose-only spoken-tag recognition for presentation and voice playback.
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

/** Half-open offsets into a marker-free Markdown document. */
export interface SpokenRange {
  start: number
  end: number
}

/**
 * Partition source around complete, case-insensitive bare prose pairs.
 * Code, quoted mentions, escaped tags, definitions and link destinations cannot
 * supply markers. Unclosed pairs stay literal; nested pairs retain first-close
 * behavior. Quoted mentions use paired straight or curly quotes; apostrophes
 * within words are not quotation delimiters.
 * @param text - Raw assistant Markdown.
 * @returns Ordered segments covering the original source.
 */
export function parseSpokenSegments(text: string): SpokenSegment[] {
  if (!/<spoken>/i.test(text)) return text ? [plain(0, text.length)] : []
  // Treat tags as prose, not opaque HTML blocks that conceal nested code.
  const tree = fromMarkdown(text, { extensions: [{ disable: { null: ['htmlFlow', 'htmlText'] } }] })
  const code: SpokenRange[] = []
  const prose: SpokenRange[] = []
  function visit(node: Root | RootContent, quoted = false): void {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (node.type === 'code' || node.type === 'inlineCode') {
      if (start !== undefined && end !== undefined) code.push({ start, end })
    } else if (node.type === 'text') {
      if (!quoted && start !== undefined && end !== undefined) prose.push({ start, end })
    } else if ('children' in node) {
      for (const child of node.children) visit(child, quoted || node.type === 'blockquote')
    }
  }
  visit(tree)
  let masked = ''
  let cursor = 0
  for (const { start, end } of code) {
    masked += text.slice(cursor, start) + ' '.repeat(end - start)
    cursor = end
  }
  masked += text.slice(cursor)
  const quotes: SpokenRange[] = []
  for (const match of masked.matchAll(/"(?:\\.|[^"\\])*"|“[^”]*”|‘[^’]*’|(?<!\w)'(?:\\.|[^'\\])*'(?!\w)/g)) {
    const start = match.index
    const end = start + match[0].length
    quotes.push({ start, end })
  }
  const segments: SpokenSegment[] = []
  let opening: number | undefined
  cursor = 0
  for (const token of masked.matchAll(/<\/?spoken>/gi)) {
    const start = token.index
    const end = start + token[0].length
    if (!prose.some(range => start >= range.start && end <= range.end)
      || quotes.some(range => start >= range.start && start < range.end)
      || escaped(text, start)) continue
    if (token[0][1] !== '/') {
      opening ??= start
    } else if (opening !== undefined) {
      if (opening > cursor) segments.push(plain(cursor, opening))
      segments.push({
        kind: 'spoken', start: opening, end, contentStart: opening + 8, contentEnd: start,
        speechText: masked.slice(opening + 8, start).replace(/\s+/g, ' ').trim(),
      })
      cursor = end
      opening = undefined
    }
  }
  if (cursor < text.length) segments.push(plain(cursor, text.length))
  return segments
}

/**
 * Remove only recognized markers while mapping highlights into one Markdown source.
 * @param text - Original assistant source.
 * @returns Marker-free text and inline highlight ranges for a single full-document parse.
 */
export function projectSpokenMarkdown(text: string): { text: string; ranges: SpokenRange[] } {
  let projected = ''
  const ranges: SpokenRange[] = []
  for (const segment of parseSpokenSegments(text)) {
    const start = projected.length
    projected += text.slice(segment.contentStart, segment.contentEnd)
    if (segment.kind === 'spoken') ranges.push({ start, end: projected.length })
  }
  return { text: projected, ranges }
}

function escaped(text: string, offset: number): boolean {
  let slashes = 0
  while (offset > 0 && text[--offset] === '\\') slashes++
  return slashes % 2 === 1
}

function plain(start: number, end: number): SpokenSegment {
  return { kind: 'text', start, end, contentStart: start, contentEnd: end, speechText: '' }
}
