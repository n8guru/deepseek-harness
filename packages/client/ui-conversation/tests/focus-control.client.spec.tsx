// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { FocusControl, type FocusOperation } from '../src/client/queue/FocusControl.tsx'

afterEach(() => { cleanup(); sessionStorage.clear() })

it('passes the original control event before async operation and never records inspection', async () => {
  const operation = vi.fn<FocusOperation>().mockResolvedValue({ enabled: false, queued: 1 })
  const recordActivity = vi.fn()
  const screen = render(<FocusControl sessionId="one" operation={operation} revision={0} running={false}
    notify={vi.fn()} recordActivity={recordActivity} />)
  await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('1 held') })
  expect(recordActivity).not.toHaveBeenCalled()
  const event = new MouseEvent('click', { bubbles: true })
  fireEvent(screen.getByText('Focus off'), event)
  expect(recordActivity).toHaveBeenCalledExactlyOnceWith(event)
  expect(recordActivity.mock.invocationCallOrder[0]).toBeLessThan(operation.mock.invocationCallOrder[1]!)
})

it('shows authoritative state and forbids Check during foreground work', async () => {
  const operation = vi.fn<FocusOperation>().mockResolvedValue({ enabled: true, queued: 2 })
  const props = { sessionId: 'one', operation, revision: 1, running: true, notify: vi.fn() }
  const screen = render(<FocusControl {...props} />)
  await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('2 held') })
  expect((screen.getByText('Check now') as HTMLButtonElement).disabled).toBe(true)
  expect(operation.mock.calls).toEqual([[{ action: 'inspect' }]])
  screen.rerender(<FocusControl {...props} running={false} revision={2} />)
  await waitFor(() => { expect(operation).toHaveBeenCalledTimes(2) })
  fireEvent.click(screen.getByText('Focus on'))
  await waitFor(() => { expect(operation).toHaveBeenCalledWith({ action: 'set', enabled: false }) })
})

it('never fabricates available Focus state when the native driver refuses inspection', async () => {
  const operation = vi.fn<FocusOperation>().mockRejectedValue(new Error('unsupported driver'))
  const screen = render(<FocusControl sessionId="alternate" operation={operation} revision={0} running={false} notify={vi.fn()} />)
  await waitFor(() => { expect(operation).toHaveBeenCalledOnce() })
  expect(screen.getByRole('status').textContent).toBe('Focus unavailable')
  expect((screen.getByText('Focus off') as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByText('Check now') as HTMLButtonElement).disabled).toBe(true)
})

it('retains ambiguous Check identity across reload without crossing sessions', async () => {
  let fail = true
  const checks: string[] = []
  const operation: FocusOperation = async (input) => {
    if (input.action === 'check') {
      checks.push(input.checkId!)
      if (fail) throw new Error('lost ACK')
    }
    return { enabled: true, queued: 0 }
  }
  sessionStorage.setItem('dsh:focus-check:one', 'snapshot-original')
  const props = { sessionId: 'one', operation, revision: 1, running: false, notify: vi.fn() }
  const first = render(<FocusControl {...props} />)
  await waitFor(() => { expect((first.getByText('Check now') as HTMLButtonElement).disabled).toBe(false) })
  fireEvent.click(first.getByText('Check now'))
  await waitFor(() => { expect(props.notify).toHaveBeenCalled() })
  first.unmount()
  fail = false
  const second = render(<FocusControl {...props} />)
  await waitFor(() => { expect((second.getByText('Check now') as HTMLButtonElement).disabled).toBe(false) })
  fireEvent.click(second.getByText('Check now'))
  await waitFor(() => { expect(checks).toEqual(['snapshot-original', 'snapshot-original']); expect(sessionStorage.getItem('dsh:focus-check:one')).toBeNull() })
  second.unmount()
  sessionStorage.setItem('dsh:focus-check:one', 'pending-other-session')
  const other = render(<FocusControl {...props} sessionId="two" />)
  await waitFor(() => { expect(other.getByRole('status').textContent).toBe('0 held') })
  expect((other.getByText('Check now') as HTMLButtonElement).disabled).toBe(true)
})
