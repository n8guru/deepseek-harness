# @deepseek-ai/dsh-client-ui-stage-dock

English | [中文](README.zh.md)

The Stage dock: a panel pinned to the frame's right edge holding an iframe of a [Forage](https://forage.ink) Stage page, plus the session-header control that shows and hides it. The Stage page — a dark, full-bleed visual board whose cards pop in, drag, link, and pulse over one ordered SSE feed — is entirely its own; this package contributes the binding, the visibility, and nothing else. The behavior is specified by the [DSH Stage dock Agent Note](../../../.agents/notes/implemented/feature/2026-09-26-dsh-stage-dock.md).

The panel is an entry in [`shell.overlay`](../ui-layout/README.md), the frame-wide floating layer above every column and outside their scroll containers. That seat, not a stylesheet, is what makes the dock unaffected by transcript scroll: the panel is never inside the scrolling conversation container, so there is no scroll position it can inherit. The overlay layer is click-through and grants pointer events to its direct children, so the dock's own chrome is interactive while the rest of the layer leaves the app underneath reachable. It orders at 100, behind the command popup, because a persistent dock must not paint over a shell the operator just opened.

A DSH session id does not determine a Forage conversation id, and nothing on the wire relates them, so the binding is operator-supplied: a numeric field and an `attach` action in the panel's own header, mirroring what `stage open` does for an agent. Re-attaching with a different id is how a binding is edited. A value that does not denote a conversation — blank, a word, a decimal, zero — is ignored and leaves the current binding standing. Attaching shows the dock in the same step, and hiding the dock keeps the binding, so reopening never re-asks.

The binding and the visibility are per session, because two sessions legitimately watch two different stages, and both persist: the toggle state a reload drops is a dock that silently detached. Storage is one `localStorage` record under `dsh.stage-dock.v1`, rehydrated without validation by the store engine — so the reader normalizes, and a row that no longer matches the current shape reads as a hidden, unbound dock rather than becoming a malformed iframe URL. Known Limitations below records why this is browser-local rather than a host-side sidecar.

The iframe keeps exactly the two capabilities the Stage page needs: `allow-scripts`, because the board runs its own renderer, and `allow-same-origin`, because it reads its own `forage.ink` feed. It gets no popups, no top-level navigation, and no form submission. The dock points at the live Forage deployment rather than anything this repository serves: the charter keeps the stage independent of its host, so the dock is a viewer.

Both entries share one controller instance, so the header toggle and the panel read and move the same fact. Styling uses tokens only, asserted against the theme sheets by `tests/styles.client.spec.ts`; copy goes through the package's own `stageDock` locale namespace.

## Model Experience

None. This package renders an operator-chosen external page for a human and touches no prompt, message, schema, stream, or tool result. The model's route onto the same stage is the Forage write endpoint it already calls; nothing about this dock is visible to it, and turning the dock off changes no model input.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **The binding is browser-local, not a host-side session sidecar.** The step called for DSH session metadata, and the durable host route exists — a settings namespace registered by this package's node half, written from the browser through `ctx.settingsScope`. It was rejected on a functional ground, not on effort: `SettingsScopeBinder` constructs its controller with `connection.isLoopback ? 'host' : 'memory'`, and in `'memory'` mode every write resolves immediately without reaching the wire. This deployment is reached over Tailscale and LAN authorities (`dsh web --trusted-host …`), so a settings-backed binding would silently fail to persist on exactly the access path in use, while reporting success. A `localStorage` record persists on every authority. The cost is that the binding does not follow the operator to another browser or device, and the host cannot read it; a per-Session storage-domain sidecar behind a Remote service — the [`message-feedback`](../../feedback/message-feedback/README.md) shape — is the upgrade path when either becomes a requirement.
- **Nothing reconciles a dead conversation.** An id whose Forage conversation was deleted still renders: the dock does not probe the Stage URL before iframing it, so the operator sees whatever `forage.ink` serves for that id. Validating a binding would make the dock depend on the stage's availability, which is the coupling the charter's "the stage never depends on its host" is the other half of.
- **One stage per session.** A session binds at most one conversation, and the panel width is fixed by the stylesheet rather than draggable.
- **The Stage origin is a constant.** A second Forage deployment would make it a `DSH_CLIENT_*` build value; today there is one.
