// @vitest-environment jsdom
/**
 * Stage-dock header toggle: it reports the dock's state and moves it, and it is
 * present whether or not the session has a binding yet.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { StageDockToggle, type StageDockToggleProps } from '../src/client/StageDockToggle.tsx'
import type { StageDockState } from '../src/client/store.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const SESSION = 'session-1' as SessionId
const t: StageDockToggleProps['t'] = makeTranslate(zh)

/**
 * Props over a fixed dock snapshot.
 * @param dock - the dock state the hook reads.
 * @returns the composed props plus the toggle spy.
 */
function harness(dock: StageDockState): { props: StageDockToggleProps; toggle: ReturnType<typeof vi.fn> } {
  const toggle = vi.fn()
  const props = {
    sessionId: SESSION,
    useStageDock: (select: (state: StageDockState) => unknown) => select(dock),
    toggle,
    attach: vi.fn(),
    t,
  } as unknown as StageDockToggleProps
  return { props, toggle }
}

describe('StageDockToggle', () => {
  it('offers the way in for a session that has no binding yet', () => {
    const { props } = harness({ bySession: {} })
    render(<StageDockToggle {...props} />)
    const button = screen.getByRole('button', { name: zh['toggle.open'] })
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.textContent).toBe(zh['toggle.label'])
  })

  it('reports a showing dock as pressed, and offers to close it', () => {
    const { props } = harness({ bySession: { [SESSION]: { open: true, conversationId: 7 } } })
    render(<StageDockToggle {...props} />)
    expect(screen.getByRole('button', { name: zh['toggle.close'] }).getAttribute('aria-pressed')).toBe('true')
  })

  it('clicking moves this session\'s dock', () => {
    const { props, toggle } = harness({ bySession: {} })
    render(<StageDockToggle {...props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['toggle.open'] }))
    expect(toggle).toHaveBeenCalledWith(SESSION)
  })
})
