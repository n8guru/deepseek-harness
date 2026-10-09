/** Browser fixture: shipped composer, Focus control, and Gateway activity adapter. */
import { useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { InputBar, type InputBarProps } from '../../src/client/skeleton/InputBar.tsx'
import { FocusControl } from '../../src/client/queue/FocusControl.tsx'
import { SessionInputShell } from '../../src/client/input/facade.ts'
import { RemoteStreamMuxClient } from '../../../../api/gateway/src/client/stream-client.ts'
import { GuiOperatorActivity } from '../../../../api/gateway/src/client/operator-activity.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'

const streams = new RemoteStreamMuxClient()
let generation: { id: number; host: { home: string } } | undefined = { id: 1, host: { home: '/' } }
const listeners = new Set<() => void>()
const activity = new GuiOperatorActivity(streams, {
  getSnapshot: () => generation,
  subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
})
streams.start()
const host = document.createElement('main')
document.body.append(host)
const root = createRoot(host)
let sessionId = 'activity-browser' as SessionId
let shell: SessionInputShell
let running = false
let submits = 0, stops = 0
let holdSubmit = false
let releaseSubmit: (() => void) | undefined
const inbox: InboxState = { 'next-turn': [], 'next-step': [] }
function render(): void {
  const activeId = sessionId
  shell = new SessionInputShell({
    actx: {} as Context,
    defaultSink: async () => {
      submits++
      if (holdSubmit) await new Promise<void>((resolve) => { releaseSubmit = resolve })
      return { kind: 'success' }
    },
    inbox: createSnapshotStore(inbox),
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => '' },
  })
  const useInput: InputBarProps['useInput'] = selector =>
    selector(useSyncExternalStore(shell.state.subscribe, shell.state.getSnapshot))
  const state = { running, removed: false, subagent: null, promptError: null } as SessionSnapshot
  const props = {
    sessionId: activeId,
    operatorActivity: activity,
    useInput, keyboard: shell, inputActions: shell.actions,
    useSession: (selector: (value: SessionSnapshot) => unknown) => selector(state),
    useProjection: (_key: string, selector?: (value: undefined) => unknown) => selector?.(undefined),
    useNotices: () => null,
    useBusyEnter: () => 'queue',
    useFileUploads: () => ({}),
    useLexicon: () => new Map(),
    useMenuLauncher: () => null,
    useStopShortcut: () => [],
    resolveDraftAttachments: () => [],
    t: (key: string) => key,
    stop: () => { stops++ },
    variant: 'composer',
    renderSlot: (key: string) => key === 'conversation.composer.dock'
      ? <FocusControl sessionId={activeId} operation={async (input) => {
        const response = await fetch('/api/session.focus', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: activeId, ...input }),
        })
        if (!response.ok) throw new Error('Focus refused')
        return response.json()
      }} recordActivity={event => activity.record(activeId, event, 'focus-control')}
      running={false} revision={0} notify={() => {}} /> : null,
  } as InputBarProps
  root.render(<div data-conversation-session={activeId}><InputBar key={activeId + running} {...props} /></div>)
}
render()
Object.assign(window, {
  activityFixture: {
    counts: () => ({ submits, stops }),
    hold: () => { holdSubmit = true },
    release: () => { holdSubmit = false; releaseSubmit?.() },
    draft: (text: string) => { shell.setDraft(text) },
    programmaticSubmit: () => { shell.submit('queue', 'click') },
    switch: (id: string) => { sessionId = id as SessionId; render() },
    running: () => { running = true; render() },
    reconnect: () => {
      generation = undefined
      for (const listener of listeners) listener()
      streams.reconnect()
      generation = { id: 2, host: { home: '/' } }
      for (const listener of listeners) listener()
    },
    // An event saved by a consumer and invoked after dispatch must not qualify again.
    replay: () => { if (saved) activity.record(sessionId, saved, 'submit') },
    wrongSession: (event: Event) => activity.record('other-session', event, 'submit'),
  },
})
let saved: Event | undefined
document.addEventListener('click', (event) => { saved = event })
