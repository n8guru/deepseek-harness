import { describe, expect, it } from 'vitest'
import { parseSpokenSegments, projectSpokenMarkdown } from '../src/markdown/spoken.ts'

const speech = (text: string) => parseSpokenSegments(text).filter(s => s.kind === 'spoken' && s.speechText).map(s => s.speechText)
// Frozen legacy extraction: parity applies to bare prose, not the explicitly approved exclusions.
const legacy = (text: string) => Array.from(text.replace(/\x60\x60\x60[\s\S]*?(\x60\x60\x60|$)/g, ' ').replace(/\x60[^\x60\n]*\x60/g, ' ').matchAll(/<spoken>([\s\S]*?)<\/spoken>/gi), m => (m[1] ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean)

describe('unrelated quotes cannot suppress bare prose', () => {
  it.each([
    '[a](https://example.com/") <spoken>yes</spoken> [b](https://example.com/")',
    'It is 6" tall. <spoken>yes</spoken> The next is 8".',
    "[a](https://example.com/'x) <spoken>yes</spoken> [b](https://example.com/'x)",
    '[a](https://example.com "one") <spoken>yes</spoken> [b](https://example.com "two")',
    "[a](https://example.com 'one\"') <spoken>yes</spoken> [b](https://example.com 'two\"')",
    "Don't worry. <spoken>yes</spoken> It's fine.",
    "James' book. <spoken>yes</spoken> Chris' pen.",
    '"unrelated prose <spoken>yes</spoken> more prose"',
    '"&lt;spoken&gt;" mention <spoken>yes</spoken> "&lt;/spoken&gt;"',
    "[a][r] <spoken>yes</spoken> [b][s]\n\n[r]: https://example.com/'x \"one\"\n[s]: https://example.com/'x \"two\"",
  ])('retains speech despite surrounding punctuation: %j', (text) => {
    expect(legacy(text)).toEqual(['yes'])
    expect(speech(text)).toEqual(['yes'])
  })
})

describe('bare-prose parity', () => {
  it.each([
    '', 'plain', '<spoken> x  y </spoken>', '<SPOKEN>UP</SPOKEN>',
    'before <spoken>one</spoken> after <spoken>two</spoken>', '<spoken> </spoken>',
    '<spoken>unfinished', '<spoken>hi</spo', '<spoken>outer <spoken>inner</spoken> tail</spoken>',
    '<spoken>**bold** [link][r]</spoken>\n\n[r]: https://example.com',
    '<spoken>one\n\ntwo</spoken>', '<spoken>Don\'t stop. "Hello."</spoken>',
  ])('retains exact legacy output for %j', text => expect(speech(text)).toEqual(legacy(text)))
})

// Operator-approved differences, including the three independently reproduced review findings.
// Assert BOTH sides explicitly so a changed contract cannot be mistaken for global parity.
describe('approved semantic differences from legacy', () => {
  it.each([
    ['tilde fence', '~~~\n<spoken>silent</spoken>\n~~~', ['silent']],
    ['indented code', '    <spoken>silent</spoken>', ['silent']],
    ['multiline code span', '``multi\n<spoken>silent</spoken>``', ['silent']],
    ['double-quoted pair', '"<spoken>silent</spoken>"', ['silent']],
    ['single-quoted pair', "'<spoken>silent</spoken>'", ['silent']],
    ['curly-quoted pair', '“<spoken>silent</spoken>”', ['silent']],
    ['escaped pair', '\\<spoken>silent\\</spoken>', ['silent\\']],
  ] as const)('%s is now literal and silent', (_name, text, previous) => {
    expect(legacy(text)).toEqual(previous)
    expect(speech(text)).toEqual([])
    expect(projectSpokenMarkdown(text)).toEqual({ text, ranges: [] })
  })
})

describe('literal mentions and code exclusions', () => {
  it.each([
    '`<spoken>silent</spoken>`',
    '```js\n<spoken>silent</spoken>\n```',
    '````\n```\n<spoken>silent</spoken>\n````',
    '`` <spoken>silent ` still silent</spoken> ``',
    '&lt;spoken&gt;silent&lt;/spoken&gt;', '[spoken]silent[/spoken]',
    '"<spoken>" mention "</spoken>"', '‘<spoken>silent</spoken>’',
    '> <spoken>silent</spoken>',
    'Don\'t say "<spoken>silent</spoken>" then don\'t stop',
    '[r]: https://example.com "<spoken>silent</spoken>"',
  ])('retains literal %j before a real block', (literal) => {
    const text = literal + '\n\n<spoken>yes</spoken>'
    expect(speech(text)).toEqual(['yes'])
    expect(projectSpokenMarkdown(text).text).toBe(literal + '\n\nyes')
  })
  it('does not let quoted or escaped mentions capture later bare speech', () => {
    for (const prefix of ['"<spoken>"', '\\<spoken>', '&lt;spoken&gt;', '[spoken]', "don't `<spoken>`"]) {
      expect(speech(prefix + ' mention <spoken>yes</spoken>')).toEqual(['yes'])
    }
  })
  it('keeps incomplete fences and multiline spans silent', () => {
    expect(speech('~~~\n<spoken>no</spoken>')).toEqual([])
    expect(speech('```js\n<spoken>no</spoken>')).toEqual([])
  })
  it('keeps original ranges while removing code only from speech', () => {
    const text = '🙂before <spoken>**hi** `code`</spoken> after'
    const segments = parseSpokenSegments(text)
    const s = segments[1]!
    expect(s.start).toBe(9)
    expect(text.slice(s.contentStart, s.contentEnd)).toBe('**hi** `code`')
    expect(s.speechText).toBe('**hi**')
    expect(segments.map(part => text.slice(part.start, part.end)).join('')).toBe(text)
  })
})
