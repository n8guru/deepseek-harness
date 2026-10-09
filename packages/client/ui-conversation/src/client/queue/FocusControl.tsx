/** Focus controls use inbox/status events for refresh, never a background poller. */
import { useEffect, useRef, useState } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

/** Shared native Focus operation invoked by the session-scoped dock. */
export type FocusOperation = (input: { action: 'inspect' | 'set' | 'check'; enabled?: boolean; checkId?: string }) => Promise<{ enabled: boolean; queued: number }>

/** Explicit operator Focus/Check controls; ambiguous Check retry retains its exact snapshot identity. */
export function FocusControl({ operation, revision, running, notify, sessionId, recordActivity }: {
  recordActivity?: ((event: Event) => void) | undefined
  sessionId: string
  operation: FocusOperation
  revision: unknown
  running: boolean
  notify: (level: 'info' | 'error', text: string) => void
}) {
  const [state, setState] = useState<{ enabled: boolean; queued: number }>()
  const [busy, setBusy] = useState(false)
  const storageKey = `dsh:focus-check:${sessionId}`
  const pendingCheck = useRef<string | undefined>(sessionStorage.getItem(storageKey) ?? undefined)
  useEffect(() => {
    let active = true
    void operation({ action: 'inspect' }).then((value) => { if (active) setState(value) }, () => { if (active) setState(undefined) })
    return () => { active = false }
  }, [operation, revision, running])
  const act = async (check: boolean) => {
    setBusy(true)
    try {
      let input: Parameters<FocusOperation>[0]
      if (check) {
        const checkId = pendingCheck.current ?? randomUUID()
        pendingCheck.current = checkId
        // Persist before sending: an ambiguous ACK must retry the same snapshot after reload.
        sessionStorage.setItem(storageKey, checkId)
        input = { action: 'check', checkId }
      } else input = { action: 'set', enabled: !state?.enabled }
      const value = await operation(input)
      setState(value)
      if (check) {
        sessionStorage.removeItem(storageKey)
        pendingCheck.current = undefined
      }
    } catch {
      notify('error', check ? 'Check deferred or unacknowledged; retry at a safe boundary.' : 'Focus change unacknowledged.')
    } finally { setBusy(false) }
  }
  return <div data-focus-control="">
    <button type="button" aria-pressed={state?.enabled ?? false} disabled={busy || state === undefined} onClick={(event) => { recordActivity?.(event.nativeEvent); void act(false) }}>Focus {state?.enabled ? 'on' : 'off'}</button>
    <span role="status" aria-live="polite">{state === undefined ? 'Focus unavailable' : `${state.queued} held`}</span>
    <button type="button" disabled={busy || running || state === undefined || (state.queued === 0 && pendingCheck.current === undefined)} onClick={(event) => { recordActivity?.(event.nativeEvent); void act(true) }}>Check now</button>
  </div>
}
