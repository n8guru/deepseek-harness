// @vitest-environment jsdom
/**
 * Stage dock panel: what it renders for each binding state, and that the iframe
 * it produces points at the bound conversation with only the capabilities the
 * Stage page needs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { StageDockPanel, type StageDockPanelProps } from '../src/client/StageDockPanel.tsx'
import type { StageDockState } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const SESSION = 'session-1' as SessionId
const t: StageDockPanelProps['t'] = makeTranslate(zh)

interface Harness {
  props: StageDockPanelProps
  toggle: ReturnType<typeof vi.fn>
  attach: ReturnType<typeof vi.fn>
}

/**
 * Props over a fixed dock snapshot.
 * @param dock - the dock state the hook reads.
 * @param current - the current session; null for a shell with no session.
 * @returns the composed props plus the injected spies.
 */
function harness(dock: StageDockState, currentOrNone: SessionId | null = SESSION): Harness {
  const current = currentOrNone ?? undefined
  const toggle = vi.fn()
  const attach = vi.fn()
  const props = {
    useSessions: (select: (state: { current: SessionId | undefined }) => unknown) => select({ current }),
    useStageDock: (select: (state: StageDockState) => unknown) => select(dock),
    toggle,
    attach,
    t,
  } as unknown as StageDockPanelProps
  return { props, toggle, attach }
}

describe('StageDockPanel visibility', () => {
  it('renders nothing while no session is current', () => {
    const { props } = harness({ bySession: { [SESSION]: { open: true, conversationId: 7 } } }, null)
    const { container } = render(<StageDockPanel {...props} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing while this session\'s dock is hidden', () => {
    const { props } = harness({ bySession: { [SESSION]: { open: false, conversationId: 7 } } })
    const { container } = render(<StageDockPanel {...props} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('StageDockPanel binding states', () => {
  it('asks for a conversation id while the session has no binding', () => {
    const { props } = harness({ bySession: { [SESSION]: { open: true, conversationId: null } } })
    render(<StageDockPanel {...props} />)
    expect(screen.getByText(zh['panel.unbound'])).toBeTruthy()
    expect(screen.getByText(zh.empty)).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('iframes the bound conversation with only the capabilities the stage needs', () => {
    const { props } = harness({ bySession: { [SESSION]: { open: true, conversationId: 7 } } })
    render(<StageDockPanel {...props} />)
    const frame = document.querySelector('iframe')
    expect(frame?.getAttribute('src')).toBe('https://forage.ink/stage/7')
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin')
    expect(screen.getByText('会话 7')).toBeTruthy()
  })
})

describe('StageDockPanel controls', () => {
  it('attaches the typed id and clears the field', () => {
    const { props, attach } = harness({ bySession: { [SESSION]: { open: true, conversationId: null } } })
    render(<StageDockPanel {...props} />)
    const field = screen.getByLabelText(zh['field.aria']) as HTMLInputElement
    fireEvent.change(field, { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: zh.attach }))
    expect(attach).toHaveBeenCalledWith(SESSION, '12')
    expect(field.value).toBe('')
  })

  it('Enter in the field attaches too; other keys type normally', () => {
    const { props, attach } = harness({ bySession: { [SESSION]: { open: true, conversationId: null } } })
    render(<StageDockPanel {...props} />)
    const field = screen.getByLabelText(zh['field.aria'])
    fireEvent.change(field, { target: { value: '12' } })
    fireEvent.keyDown(field, { key: 'a' })
    expect(attach).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(attach).toHaveBeenCalledWith(SESSION, '12')
  })

  it('the close control hides this session\'s dock', () => {
    const { props, toggle } = harness({ bySession: { [SESSION]: { open: true, conversationId: 7 } } })
    render(<StageDockPanel {...props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['toggle.close'] }))
    expect(toggle).toHaveBeenCalledWith(SESSION)
  })
})
