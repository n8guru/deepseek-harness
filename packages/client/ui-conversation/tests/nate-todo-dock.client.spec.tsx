// @vitest-environment jsdom
/** Nate section of the pinned dock: feed coercion, two-section render, polling. */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { TodoItem } from '@deepseek-ai/dsh-client-runtime/client'
import { readNateTodos, TodoPanel, useNateTodos, type NateTodoItem } from '../src/client/skeleton/TodoPanel.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh, commonZh) as never
const CADENCE: TodoItem[] = [{ content: '写组件', status: 'in_progress' }]
const NATE: NateTodoItem[] = [{ id: 'n1', content: '批准原型', explained_at: 'tools/a.md', status: 'pending' }]

afterEach(cleanup)

describe('readNateTodos', () => {
  it('reads only open canonical JSON rows', () => {
    expect(readNateTodos({ items: [{ id: 'a', question: 'a', explained_at: 'tools/a.md', status: 'open' }, { id: 'b', question: 'b', explained_at: 'tools/b.md', status: 'closed' }] }))
      .toEqual([{ id: 'a', content: 'a', explained_at: 'tools/a.md', status: 'pending' }])
  })

  it('drops junk instead of throwing', () => {
    expect(readNateTodos(null)).toEqual([])
    expect(readNateTodos({ items: [null, 7, { content: '' }] })).toEqual([])
  })
})

describe('TodoPanel sections', () => {
  it('shows the dock for a Nate-only feed and counts both lists', () => {
    render(<TodoPanel todos={[]} nate={NATE} t={t} />)
    expect(screen.getByTestId('todo-panel')).toBeTruthy()
    expect(screen.getByText('1 待处理')).toBeTruthy()
  })

  it('labels both sections once the Nate feed is present', () => {
    render(<TodoPanel todos={CADENCE} nate={NATE} t={t} />)
    expect(screen.getByText('Nate')).toBeTruthy()
    expect(screen.getByText('Cadence')).toBeTruthy()
    expect(screen.getAllByRole('list')).toHaveLength(2)
  })

  it('stays visible while both lists are empty', () => {
    render(<TodoPanel todos={[]} nate={[]} t={t} />)
    expect(screen.getByText('Nate')).toBeTruthy()
    expect(screen.getByText('Cadence')).toBeTruthy()
  })
})

describe('useNateTodos', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('polls the feed and survives a failed fetch', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [{ id: 'n1', question: '批准原型', explained_at: 'tools/a.md', status: 'open' }] }) })
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    function Probe() {
      const items = useNateTodos('/local/nate-todo.json', 1000)
      return <span data-testid="count">{items.length}</span>
    }
    render(<Probe />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByTestId('count').textContent).toBe('1')
    await act(async () => { vi.advanceTimersByTime(1000); await Promise.resolve() })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('count').textContent).toBe('1') // failure keeps the last good list
  })
})
