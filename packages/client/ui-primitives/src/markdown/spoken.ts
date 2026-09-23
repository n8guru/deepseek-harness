/**
 * Shared prose-only spoken-tag recognition for presentation and voice playback.
 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Root, RootContent, Text, Html } from 'mdast'
import { decodeString } from 'micromark-util-decode-string'
import { parseGfmWithMath } from './parse.ts'

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
 * behavior. Quoted mentions require matching straight/curly quotes immediately
 * around a marker token or complete inline pair, never arbitrary surrounding prose.
 * @param text - Raw assistant Markdown.
 * @returns Ordered segments covering the original source.
 */
function recognizeSpokenSegments(text: string): SpokenSegment[] {
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
  // Literal bracket wrappers include a single marker and a complete marked pair.
  for (const match of masked.matchAll(/\[(?:<\/?spoken>|<spoken>[^\r\n]*?<\/spoken>)\]/gi)) {
    quotes.push({ start: match.index, end: match.index + match[0].length })
  }
  // Quotes must directly wrap one marker token or one complete inline pair.
  // Never pair arbitrary prose/URL/title quotes around intervening bare speech.
  const quotePattern = new RegExp([
    /"(?:<\/?spoken>|<spoken>[^"\r\n]*?<\/spoken>)"/,
    /'(?:<\/?spoken>|<spoken>[^'\r\n]*?<\/spoken>)'/,
    /“(?:<\/?spoken>|<spoken>[^”\r\n]*?<\/spoken>)”/,
    /‘(?:<\/?spoken>|<spoken>[^’\r\n]*?<\/spoken>)’/,
  ].map(pattern => pattern.source).join('|'), 'gi')
  for (const match of masked.matchAll(quotePattern)) {
    const start = match.index
    const end = start + match[0].length
    // Wrapper markers themselves must be prose, not URL/title data.
    const firstMarkerEnd = start + 1 + (masked[start + 2] === '/' ? 9 : 8)
    if (prose.some(range => start + 1 >= range.start && firstMarkerEnd <= range.end)) {
      quotes.push({ start, end })
    }
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
        speechText: '',
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
  for (const segment of recognizeSpokenSegments(text)) {
    const start = projected.length
    projected += text.slice(segment.contentStart, segment.contentEnd)
    if (segment.kind === 'spoken') ranges.push({ start, end: projected.length })
  }
  return { text: projected, ranges }
}

/** A rendered text fragment and its spoken-region index (null means ordinary text). */
export interface SpokenTextPart {
  text: string
  region: number | null
}

/**
 * Map one displayed text/HTML leaf to the shared spoken regions.
 * @param node - Parsed leaf; HTML stays inert literal text, never HTML elements.
 * @param source - Marker-free full Markdown and its projected ranges.
 * @returns Display text fragments shared by speech extraction and React highlighting.
 */
export function spokenTextParts(
  node: Text | Html,
  source: { text: string; ranges: readonly SpokenRange[] },
): SpokenTextPart[] {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined) return [{ text: node.value, region: null }]
  const parts: SpokenTextPart[] = []
  let cursor = 0
  const decode = (text: string): string => node.type === 'html' ? text : decodeString(text)
  const sourceLines = decode(source.text.slice(start, end)).split('\n')
  const valueLines = node.value.split('\n')
  const decodedOffset = (offset: number): number => {
    const prefixLines = decode(source.text.slice(start, offset)).split('\n')
    const line = prefixLines.length - 1
    const indentation = Math.max(0, (sourceLines[line] ?? '').indexOf(valueLines[line] ?? ''))
    return valueLines.slice(0, line).reduce((length, value) => length + value.length + 1, 0)
      + Math.max(0, (prefixLines[line]?.length ?? 0) - indentation)
  }
  for (const [region, range] of source.ranges.entries()) {
    if (range.start >= end || range.end <= start) continue
    const left = decodedOffset(Math.max(start, range.start))
    const right = decodedOffset(Math.min(end, range.end))
    if (cursor < left) parts.push({ text: node.value.slice(cursor, left), region: null })
    parts.push({ text: node.value.slice(left, right), region })
    cursor = right
  }
  if (cursor < node.value.length) parts.push({ text: node.value.slice(cursor), region: null })
  return parts
}

/**
 * Recognize source ranges and derive speech from the same displayed AST leaves as highlights.
 * Links contribute labels, never destinations/titles; code, math and images contribute no speech.
 * @param text - Original assistant Markdown.
 * @returns Source segments with normalized displayed prose for each spoken region.
 */
export function parseSpokenSegments(text: string): SpokenSegment[] {
  const segments = recognizeSpokenSegments(text)
  const spoken = segments.filter(segment => segment.kind === 'spoken')
  if (!spoken.length) return segments
  const projection = projectSpokenMarkdown(text)
  const values = spoken.map(() => '')
  function visit(node: Root | RootContent): void {
    if (node.type === 'definition' || node.type === 'footnoteDefinition') return
    if (node.type === 'text' || node.type === 'html') {
      for (const part of spokenTextParts(node, projection)) {
        if (part.region !== null) values[part.region] += part.text
      }
    } else if ('children' in node) {
      for (const child of node.children) visit(child)
    }
    if (['paragraph', 'heading', 'listItem', 'tableCell', 'break', 'code', 'inlineCode'].includes(node.type)) {
      for (let i = 0; i < values.length; i++) values[i] += ' '
    }
  }
  visit(parseGfmWithMath(projection.text))
  for (const [i, segment] of spoken.entries()) segment.speechText = (values[i] ?? '').replace(/\s+/g, ' ').trim()
  return segments
}

function escaped(text: string, offset: number): boolean {
  let slashes = 0
  while (offset > 0 && text[--offset] === '\\') slashes++
  return slashes % 2 === 1
}

function plain(start: number, end: number): SpokenSegment {
  return { kind: 'text', start, end, contentStart: start, contentEnd: end, speechText: '' }
}
