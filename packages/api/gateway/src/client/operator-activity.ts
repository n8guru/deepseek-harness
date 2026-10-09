/** Trusted-GUI reports, not compromised-browser or biological-presence attestation. */
import type { ConnectionGenerationState } from '@deepseek-ai/dsh-client-connection/client'
import type { RemoteStreamMuxClient } from './stream-client.ts'

/** GUI gesture categories reported only from trusted, current-session event handlers. */
export type OperatorInteraction = 'input' | 'submit' | 'focus-control' | 'stop'

interface Binding {
  abort: AbortController
  epoch?: string
  send?: (value: unknown) => boolean
  sequence: number
}

interface View {
  sessionId: string
  record(event: Event, interaction: OperatorInteraction): void
  dispose(): void
}

/** Gateway owns the physical carrier; mounted conversation views own gesture lifetimes. */
export class GuiOperatorActivity {
  private readonly views = new Set<View>()
  private disposed = false

  constructor(
    private readonly streams: RemoteStreamMuxClient,
    private readonly generation: ConnectionGenerationState,
  ) {}

  /**
   * Bind a session occurrence without recording mount/focus/reconnect as activity.
   * @param sessionId - exact session rendered by the occurrence.
   * @param root - mounted conversation element carrying that session id.
   * @returns disposer sending leave and removing all observers.
   */
  mount(sessionId: string, root: HTMLElement): () => void {
    if (this.disposed) return () => {}
    const doc = root.ownerDocument
    const win = doc.defaultView
    if (win === null) return () => {}
    let binding: Binding | undefined
    let disposed = false
    const visible = (): boolean => !disposed && root.isConnected
      && root.dataset.conversationSession === sessionId
      && root.getClientRects().length > 0 && root.closest('[hidden], [inert]') === null
      && win.getComputedStyle(root).visibility === 'visible'
      && doc.visibilityState === 'visible' && doc.hasFocus()
    const leave = (): void => {
      const old = binding
      binding = undefined
      if (old === undefined) return
      if (old.epoch !== undefined) {
        try { old.send?.({ version: 1, bindingEpoch: old.epoch, sequence: ++old.sequence, interaction: 'leave' }) }
        catch (_error) { /* A lost carrier is already invalidated by the Host. */ }
      }
      old.abort.abort()
    }
    const open = (): void => {
      if (binding !== undefined || !visible() || this.generation.getSnapshot() === undefined) return
      const capturedGeneration = this.generation.getSnapshot()
      const current: Binding = { abort: new AbortController(), sequence: 0 }
      binding = current
      void (async () => {
        try {
          for await (const frame of this.streams.open(
            'session.operatorActivity', { version: 1, sessionId }, current.abort.signal, undefined,
            (send) => { current.send = send },
          )) {
            if (binding !== current || capturedGeneration !== this.generation.getSnapshot() || !visible()) break
            if (current.epoch === undefined) {
              if (frame === null || typeof frame !== 'object' || !('version' in frame) || frame.version !== 1
                || !('bindingEpoch' in frame) || typeof frame.bindingEpoch !== 'string' || frame.bindingEpoch.length === 0) break
              current.epoch = frame.bindingEpoch
            } else if (frame === null || typeof frame !== 'object' || !('version' in frame) || frame.version !== 1
              || !('accepted' in frame) || frame.accepted !== true) break
          }
        } catch (_error) { /* Unsupported/closed/auth-expired streams never qualify a gesture. */ }
        finally {
          current.abort.abort()
          if (binding === current) binding = undefined
        }
      })()
    }
    const record = (event: Event, interaction: OperatorInteraction): void => {
      // Read every fence synchronously, before any prompt upload, RPC, or other await.
      const target = event.target
      const eventMatches = interaction === 'input' ? ['keydown', 'pointerdown', 'input'].includes(event.type)
        : interaction === 'focus-control' ? event.type === 'click' : event.type === 'click' || event.type === 'keydown'
      if (!eventMatches || !event.isTrusted || event.eventPhase === 0 || !visible() || !(target instanceof win.Element)
        || !root.contains(target) || target.closest('[data-conversation-session]') !== root
        || target.closest('[hidden], [inert]') !== null || target.getClientRects().length === 0) return
      const current = binding
      if (current?.epoch === undefined) { open(); return } // Drop pre-handshake gestures; no replay.
      try {
        if (!current.send?.({ version: 1, bindingEpoch: current.epoch, sequence: ++current.sequence, interaction })) leave()
      } catch (_error) { leave() }
    }
    const input = (event: Event): void => { record(event, 'input') }
    const visibility = (): void => { if (visible()) open(); else leave() }
    const focusOut = (event: FocusEvent): void => {
      if (!(event.relatedTarget instanceof win.Node) || !root.contains(event.relatedTarget)) leave()
    }
    const generationChanged = (): void => { leave(); open() }
    const offGeneration = this.generation.subscribe(generationChanged)
    root.addEventListener('keydown', input, true)
    root.addEventListener('pointerdown', input, true)
    root.addEventListener('input', input, true)
    root.addEventListener('focusin', open)
    root.addEventListener('focusout', focusOut)
    win.addEventListener('blur', leave)
    win.addEventListener('focus', open)
    doc.addEventListener('visibilitychange', visibility)
    // View hiding/session replacement also withdraws activity without waiting for another gesture.
    const observer = new win.MutationObserver(visibility)
    for (let element: HTMLElement | null = root; element !== null; element = element.parentElement) {
      observer.observe(element, { attributes: true, attributeFilter: ['hidden', 'inert', 'style', 'class', 'data-conversation-session'] })
    }
    const view: View = { sessionId, record, dispose: () => {
      disposed = true
      leave()
      offGeneration()
      observer.disconnect()
      root.removeEventListener('keydown', input, true)
      root.removeEventListener('pointerdown', input, true)
      root.removeEventListener('input', input, true)
      root.removeEventListener('focusin', open)
      root.removeEventListener('focusout', focusOut)
      win.removeEventListener('blur', leave)
      win.removeEventListener('focus', open)
      doc.removeEventListener('visibilitychange', visibility)
      this.views.delete(view)
    } }
    this.views.add(view)
    open()
    return view.dispose
  }

  /**
   * Record during DOM dispatch, never from a generic prompt API or delayed callback.
   * @param sessionId - session addressed by the handler before async work.
   * @param event - original DOM event, not React's wrapper or reconstructed gesture fields.
   * @param interaction - handler action; none grants native release authority.
   */
  record(sessionId: string, event: Event, interaction: OperatorInteraction): void {
    for (const view of this.views) if (view.sessionId === sessionId) view.record(event, interaction)
  }

  /** Withdraw all GUI bindings when the Gateway plugin unloads. */
  dispose(): void {
    this.disposed = true
    for (const view of this.views) view.dispose()
  }
}
