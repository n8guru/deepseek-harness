import { describe, expect, it } from 'vitest'
import { parseSpokenSegments } from '../src/markdown/spoken.ts'

const speech = (text: string) => parseSpokenSegments(text).filter(s => s.kind === 'spoken' && s.speechText).map(s => s.speechText)
const legacy = (text: string) => Array.from(text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ').matchAll(/<spoken>([\s\S]*?)<\/spoken>/gi), m => (m[1] ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean)
const fixtures = [
  '', 'plain', '<spoken> x  y </spoken>', '<SPOKEN>UP</SPOKEN>',
  'a <spoken>one</spoken> b <spoken>two</spoken>', '<spoken> </spoken>',
  'carried a `<spoken>` mention. <spoken>real</spoken>',
  '```js\n<spoken>silent</spoken>\n```\n<spoken>yes</spoken>',
  'text\n```js\n<spoken>no</spoken>', '<spoken>one `</spoken>` two</spoken>',
  '<spoken>unfinished', '<spoken>outer <spoken>inner</spoken> tail</spoken>',
  '<spoken>one\n\n```js\nconst x = 1\n```\n\ntwo</spoken>',
]

describe('spoken ranges and playback', () => {
  it.each(fixtures)('preserves legacy speech for %j', (text) => {
    expect(speech(text)).toEqual(legacy(text))
    const segments = parseSpokenSegments(text)
    expect(segments.map(s => text.slice(s.start, s.end)).join('')).toBe(text)
  })
  it.each([
    '~~~js\n<spoken>silent</spoken>\n~~~\n',
    '`` <spoken>silent ` still silent</spoken> ``\n',
    '``multi\n<spoken>silent</spoken>``\n',
    '````\n```\n<spoken>silent</spoken>\n````\n',
    '> ```\n> <spoken>silent</spoken>\n> ```\n',
    '    <spoken>silent</spoken>\n\n',
  ])('ignores CommonMark code: %j', code => expect(speech(code + '<spoken>yes</spoken>')).toEqual(['yes']))
  it('returns original UTF-16 offsets and preserves code for display', () => {
    const text = '🙂before <spoken>**hi** `code`</spoken> after'
    const s = parseSpokenSegments(text)[1]!
    expect(s.start).toBe(9)
    expect(text.slice(s.contentStart, s.contentEnd)).toBe('**hi** `code`')
    expect(s.speechText).toBe('**hi**')
  })
})
