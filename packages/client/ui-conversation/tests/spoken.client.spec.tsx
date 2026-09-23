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
it('hides only real markers and renders Markdown and code inside the highlighted body', () => {
  const text = 'Before\n\n<spoken>**Hello** [link](https://example.com)\n\n- first\n- second\n\n`code`</spoken>\n\nAfter `<spoken>`'
  const view = render(<AssistantMarkdown {...props} blocks={[{ kind: 'text', text }]} />)
  const spoken = view.container.querySelector('[data-spoken]')!
  expect(spoken.querySelector('strong')?.textContent).toBe('Hello')
  expect(spoken.querySelector('a')?.getAttribute('href')).toBe('https://example.com')
  expect(spoken.querySelectorAll('li')).toHaveLength(2)
  expect(spoken.querySelector('code')?.textContent).toBe('code')
  expect(spoken.textContent).not.toContain('<spoken>')
  expect(view.container.textContent).toContain('After <spoken>')
  expect(view.container.innerHTML).toMatchSnapshot()
})
it('keeps incomplete streaming markers literal until the pair closes', () => {
  const view = render(<AssistantMarkdown {...props} streaming blocks={[{ kind: 'text', text: '<spoken>Hello' }]} />)
  expect(view.container.querySelector('[data-spoken]')).toBeNull()
  view.rerender(<AssistantMarkdown {...props} blocks={[{ kind: 'text', text: '<spoken>Hello</spoken>' }]} />)
  expect(view.container.querySelector('[data-spoken]')?.textContent).toBe('Hello')
})
