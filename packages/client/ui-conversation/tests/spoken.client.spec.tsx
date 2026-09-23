// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { AssistantMarkdown } from '../src/client/chat/AssistantMarkdown.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const t = makeTranslate(zh, commonZh)
const props = { t, streaming: false, renderMessageImages: () => null }
function show(text: string, streaming = false) {
  return render(<AssistantMarkdown {...props} streaming={streaming} blocks={[{ kind: 'text', text }]} />)
}
it.each([false, true])('keeps inline prose, references and cross-boundary formatting in one document (streaming=%s)', (streaming) => {
  const view = show('**before <spoken>[hello][r]</spoken> after**\n\n[r]: https://example.com', streaming)
  expect(view.container.querySelectorAll('p')).toHaveLength(1)
  expect(view.container.querySelector('strong')?.textContent).toBe('before hello after')
  expect(view.container.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
  expect(view.container.querySelector('a [data-spoken]')?.textContent).toBe('hello')
  expect(view.container.querySelectorAll('[data-spoken]')).toHaveLength(1)
  expect(view.container.querySelector('p > div')).toBeNull()
})
it.each([false, true])('does not pair URL/title/prose quotes across bare speech (streaming=%s)', (streaming) => {
  const cases = [
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
  ]
  for (const text of cases) {
    const view = show(text, streaming)
    expect(view.container.querySelector('[data-spoken]')?.textContent).toBe('yes')
    if (text === cases[0]) {
      expect(Array.from(view.container.querySelectorAll('a'), a => a.getAttribute('href'))).toEqual([
        'https://example.com/%22', 'https://example.com/%22',
      ])
    }
    view.unmount()
  }
})

it('preserves a link whose label spans a spoken boundary', () => {
  const view = show('[before <spoken>hello</spoken> after](https://example.com)')
  expect(view.container.querySelector('a')?.textContent).toBe('before hello after')
  expect(view.container.querySelector('a [data-spoken]')?.textContent).toBe('hello')
})
it('renders lists and code normally with inline prose highlights', () => {
  const view = show('Before\n\n<spoken>**Hello** [link](https://example.com)\n\n- first\n- second\n\n`code`</spoken>\n\nAfter `<spoken>`')
  expect(view.container.querySelector('strong [data-spoken]')?.textContent).toBe('Hello')
  expect(view.container.querySelector('a [data-spoken]')?.textContent).toBe('link')
  expect(view.container.querySelectorAll('li [data-spoken]')).toHaveLength(2)
  expect(view.container.querySelector('code')?.textContent).toBe('code')
  expect(view.container.querySelector('code [data-spoken]')).toBeNull()
  expect(view.container.textContent).toContain('After <spoken>')
  expect(view.container.innerHTML).toMatchSnapshot()
})
it.each([
  '~~~\n<spoken>silent</spoken>\n~~~', '    <spoken>silent</spoken>',
  '``multi\n<spoken>silent</spoken>``', '"<spoken>silent</spoken>"',
  '\\<spoken>silent\\</spoken>', '&lt;spoken&gt;silent&lt;/spoken&gt;', '[spoken]silent[/spoken]',
])('does not highlight or hide literal mentions: %j', (text) => {
  const view = show(text)
  expect(view.container.querySelector('[data-spoken]')).toBeNull()
  expect(view.container.textContent).toContain(text.includes('[spoken]') ? '[spoken]' : '<spoken>')
})
it.each([
  ['before &amp; <spoken>A &amp; B</spoken> after', 'A & B'],
  ['before \\* <spoken>hello</spoken> after', 'hello'],
  ['- first\n  before <spoken>hello</spoken> after', 'hello'],
  ['first\r\nbefore <spoken>hello</spoken> after', 'hello'],
])('maps decoded text offsets without shifting highlight: %j', (text, expected) => {
  const view = show(text)
  expect(view.container.querySelector('[data-spoken]')?.textContent).toBe(expected)
})
it('retains multiple precise regions in a single text leaf', () => {
  const view = show('before <spoken>one &amp; two</spoken> between <spoken>three</spoken> after')
  expect(view.container.querySelectorAll('p')).toHaveLength(1)
  expect(Array.from(view.container.querySelectorAll('[data-spoken]'), span => span.textContent)).toEqual(['one & two', 'three'])
  expect(view.container.textContent).toBe('before one & two between three after')
})
it('keeps incomplete streaming markers literal until the pair closes', () => {
  const view = show('<spoken>Hello', true)
  expect(view.container.querySelector('[data-spoken]')).toBeNull()
  view.rerender(<AssistantMarkdown {...props} streaming blocks={[{ kind: 'text', text: '<spoken>Hello</spoken>' }]} />)
  expect(view.container.querySelector('[data-spoken]')?.textContent).toBe('Hello')
})
