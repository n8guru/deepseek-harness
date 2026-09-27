// Fenced ```decision-card blocks inside assistant prose. Parsing lives apart
// from the renderer so both the chat body and the tests can split text without
// pulling React in. A block that is unterminated (still streaming) or whose
// JSON is malformed stays ordinary markdown — the fence then shows as a code
// block, which is the honest fallback.

/** One selectable answer. `id` defaults to the label when omitted. */
export interface DecisionCardOption {
  readonly id?: string
  readonly label: string
  readonly detail?: string
  readonly recommended?: boolean
}

/**
 * Scratchboard S5: the Forage card painted as a sealed board. `url` opens the
 * board host page (https only); `thumbnail` is an inline SVG/PNG data URI so it
 * renders in the DSH origin without any cross-site request or cookie.
 */
export interface DecisionCardBoard {
  readonly url: string
  readonly thumbnail: string
}

/** Decision payload carried by one fenced block. */
export interface DecisionCardSpec {
  readonly id: string
  readonly question: string
  readonly options: readonly DecisionCardOption[]
  /** File reference supplied by the assistant. */
  readonly context_link?: string
  /** Allow a free-text answer beside the options (default true). */
  readonly allowCustom?: boolean
  /** Optional board thumbnail that opens the card as a board. */
  readonly board?: DecisionCardBoard
}

/** Assistant text split into prose runs and decision cards, in source order. */
export type MarkdownSegment =
  | { readonly kind: 'markdown'; readonly text: string }
  | { readonly kind: 'card'; readonly card: DecisionCardSpec }

// Closing fence required: a half-streamed card must not flash as a live form.
const FENCE = /^```decision-card[^\n]*\n([\s\S]*?)\n```[ \t]*$/gm

/** The composer tag that binds a user message back to the card it answers. */
export function decisionTag(id: string): string {
  return `[decision-card ${id}]`
}

/** Option identity: explicit id, else the label itself. */
export function optionId(option: DecisionCardOption): string {
  return option.id ?? option.label
}

const BOARD_THUMB = /^data:image\/(?:svg\+xml|png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/

/** A malformed board is dropped, never fatal: the card still renders without it. */
function toBoard(raw: unknown): DecisionCardBoard | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { url, thumbnail } = raw as Record<string, unknown>
  if (typeof url !== 'string' || url.length > 500 || !/^https:\/\/[^\s"'<>]+$/.test(url)) return undefined
  if (typeof thumbnail !== 'string' || thumbnail.length > 60_000 || !BOARD_THUMB.test(thumbnail)) return undefined
  return { url, thumbnail }
}

function toCard(json: string): DecisionCardSpec | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { id, question, context_link, options, allow_free_text, allowCustom, board } = parsed as Record<string, unknown>
  if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,96}$/.test(id)) return undefined
  if (typeof question !== 'string' || question.trim() === '' || question.length > 1000) return undefined
  if (context_link !== undefined && (typeof context_link !== 'string' || context_link.length > 500)) return undefined
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) return undefined
  const clean: DecisionCardOption[] = []
  for (const raw of options) {
    if (typeof raw !== 'object' || raw === null) continue
    const option = raw as Record<string, unknown>
    if (typeof option.label !== 'string' || option.label.trim() === '' || option.label.length > 300) return undefined
    clean.push({
      label: option.label,
      ...typeof option.id === 'string' ? { id: option.id } : {},
      ...typeof option.detail === 'string' ? { detail: option.detail } : {},
      ...option.recommended === true ? { recommended: true } : {},
    })
  }
  if (clean.length !== options.length || clean.filter(option => option.recommended).length !== 1) return undefined
  if (new Set(clean.map(option => option.id ?? option.label)).size !== clean.length) return undefined
  const cleanBoard = toBoard(board)
  return {
    id, question, options: clean,
    ...cleanBoard !== undefined ? { board: cleanBoard } : {},
    ...typeof context_link === 'string' ? { context_link } : {},
    ...allow_free_text === false || allowCustom === false ? { allowCustom: false } : {},
  }
}

/**
 * Split one assistant text block into prose and decision cards.
 * @param text - raw markdown of a `text` block.
 * @returns ordered segments; a single markdown segment when no card parses.
 */
export function splitDecisionCards(text: string): readonly MarkdownSegment[] {
  const segments: MarkdownSegment[] = []
  let cursor = 0
  FENCE.lastIndex = 0
  for (let match = FENCE.exec(text); match !== null; match = FENCE.exec(text)) {
    const card = toCard(match[1] ?? '')
    if (card === undefined) continue // malformed: leave the fence in the prose run
    const before = text.slice(cursor, match.index)
    if (before.trim() !== '') segments.push({ kind: 'markdown', text: before })
    segments.push({ kind: 'card', card })
    cursor = match.index + match[0].length
  }
  const rest = text.slice(cursor)
  if (segments.length === 0) return [{ kind: 'markdown', text }]
  if (rest.trim() !== '') segments.push({ kind: 'markdown', text: rest })
  return segments
}
