# Agent Note: DSH Stage dock

Status: implemented

English | [中文](2026-09-26-dsh-stage-dock.zh.md)

## Problem

Forage serves a Stage page at `/stage/<conversation_id>`: a dark, full-bleed visual board of objects that pop in, drag, link, and pulse, driven by one write endpoint and one ordered SSE feed so renderers patch in place and never refresh. An agent can put a picture on that board mid-reply. The operator watching the DSH chat could not see it without leaving the conversation for a browser tab, and a tab is the wrong place: the point of the board is that it stays put while the thread keeps scrolling. A panel that scrolls away with the transcript would be no better than the tab.

Two facts made this more than "add an iframe". The stage is addressed by a Forage conversation id, and no DSH session determines one — nothing on the wire relates them, so the mapping is operator knowledge that has to be captured and kept. And the panel must be provably outside the conversation's scroll container, not merely styled to look fixed.

## Decision

One client plugin package, `packages/client/ui-stage-dock`, contributing two slot entries over one controller.

The panel is an entry in `shell.overlay` — the frame-wide floating layer ui-layout declares above every column and outside their scroll containers. That seat *is* the scroll-independence property: the panel is never a descendant of the scrolling conversation container, so there is no scroll position it can inherit, and the claim is asserted by a registration test rather than by a stylesheet. The layer is click-through and grants pointer events to its direct children, so the dock's chrome is interactive while the rest of the layer leaves the app underneath reachable. The entry orders at 100, behind ui-commands' popup at 1: a persistent dock must not paint over a shell the operator just opened.

The toggle is an entry in `conversation.session.header.actions`, beside the background-job list at 20 and ordered after it — process work reads before view controls. It renders unconditionally, because a session with no binding yet is exactly the session that needs the way in.

The binding is operator-supplied, through a numeric field and an `attach` action in the panel's own header — the same act `stage open` performs for an agent. Re-attaching with a different id edits the binding. A value denoting no conversation (blank, a word, a decimal, zero, a non-safe integer) is ignored and leaves the current binding standing. Attaching shows the dock in the same step; hiding keeps the binding, so reopening never re-asks.

Both the binding and the visibility are per session — two sessions legitimately watch two stages — and both persist, since a toggle state a reload drops is a dock that silently detached. State is one `createSnapshotStore` record persisted to `localStorage` under `dsh.stage-dock.v1`. The engine rehydrates without validation, so `entryOf` normalizes on read: a row that no longer matches the current shape reads as a hidden, unbound dock rather than becoming a malformed iframe URL.

One `StageDockController` instance serves both registrations, handed to each through the inject face's reserved `hooks` compartment, so the toggle and the panel read and move one fact. The plugin issues no RPC and its node half is the usual empty `apply`.

The iframe points at `https://forage.ink/stage/<id>` and carries `sandbox="allow-scripts allow-same-origin"`: the board runs its own renderer and reads its own feed, and needs nothing else — no popups, no top-level navigation, no form submission. The dock targets the live Forage deployment rather than anything this repository serves, because the charter keeps the stage independent of its host. The dock is a viewer, and it replicates no part of the board's rendering.

## Where the binding lives, and why not session metadata

The step called for the binding to live in DSH session metadata, and that route exists and is cheap: this package's node half registers a settings namespace (the `ui-settings-general`/`ui-theme` pattern, about twenty lines), and the browser half writes it through `ctx.settingsScope`. It was rejected on a functional ground rather than on effort.

`SettingsScopeBinder.bind` constructs its controller with `connection.isLoopback ? 'host' : 'memory'`, and in `'memory'` mode `SettingsScopeController.enqueue` resolves every write immediately without reaching the wire. `isLoopback` is computed from `window.location.hostname`. The deployment this feature exists for is reached over Tailscale and LAN authorities (`dsh web --trusted-host …`), so a settings-backed binding would silently fail to persist on exactly the access path in use while reporting success — a worse outcome than not claiming durability at all. A `localStorage` record persists on every authority.

The cost is recorded in the package README: the binding does not follow the operator to another browser or device, and the host cannot read it. The upgrade path when either becomes a requirement is a per-Session storage-domain sidecar behind a Remote service, the shape `message-feedback` already ships.

## Alternatives considered

**A seat in `sidebar`, `conversation`, or `details`.** Each is `kind: 'single'` and already occupied, and a second entry shadows rather than joins: registering would delete the navigation column, the whole conversation surface, or the details column, and take every seat that occupant declares with it. `shell.overlay` is the additive seat and is the one that carries the scroll-independence property for free.

**A seat inside the conversation column (a composer dock or message-list region).** This is where a "panel beside the chat" naively goes, and it is the failure the step names: anything inside the scrolling container scrolls, and a sticky rule inside a scroll parent still moves when that parent reflows. Rejected on the requirement, not on effort.

**A host-side Remote service for the binding.** The `message-feedback` shape — `defineDomain`/`domainTable` behind a `TypertRemoteService` — is the canonical durable per-Session sidecar and would put the binding on disk where the host can read it. It costs a new host package, typert codegen, and an edit to the hard-coded mount list in `packages/api/remotes/src/client/index.ts`. It buys nothing the settings namespace would not have bought, and the settings namespace was already rejected for a reason that has nothing to do with which durable store is used. Kept as the recorded upgrade path.

**Proxying or re-serving the Stage page from DSH.** Rejected by the charter: the stage never depends on its host, and a proxy makes the host a participant in the board's transport. The dock holds a URL.

**Validating a conversation id against Forage before iframing it.** This would catch a deleted or mistyped conversation, but it makes the dock's behavior a function of `forage.ink` reachability — the coupling the independence rule exists to prevent. The operator sees whatever the Stage URL serves, which for a bad id is Forage's own answer.

**A conversation picker instead of a numeric field.** A picker needs a Forage listing endpoint and a selection model, and it would be the only part of this package that is not thin. The field plus `attach` is the whole interaction the binding needs.

## Consequences

The scroll-independence requirement is structural rather than stylistic, so it cannot regress by a CSS edit: it would take moving the registration to a different slot, which the plugin test would catch. Nothing in ui-layout, ui-sidebar, or ui-conversation changed, so the existing layout carries zero risk from this feature.

The dock is browser-local state, which means it is invisible to the host, to other devices, and to the model. That is deliberate three times over: the model's route onto the board is the Forage write endpoint it already calls, so the dock has no model-facing effect at all, and a second browser opening the same session simply sees a closed dock rather than a wrong one.

The package's node half is inert, so the plugin is activated purely by its Loader row. The canonical row lives in `packages/bundle/web-app/cordis.patch.yml`, which is a startup-only layer; activating the row in a *running* host goes through a `$DSH_HOME` patch file, which `watchUserPatches` watches and recomposes transactionally. Both routes must not carry the row at once — `insert` appends unconditionally, so the same id would appear twice in the entry list.

## Testing

`tests/browser-plugin.client.spec.ts` boots the browser half over a real `SlotRegistry` and asserts the overlay seat, the header seat, that fiber teardown removes both (HMR safety), that both entries receive one store, and that a verb called on either face is observed through the other. `tests/store.client.spec.ts` covers the controller's per-session independence, the normalization of every rejected value, and a fresh controller rehydrating a persisted dock — the reload case. The two component specs feed props directly and assert the rendered iframe's `src` and `sandbox`, the unbound state, and both controls. `tests/styles.client.spec.ts` asserts every `--dsw-*` name against the theme sheets (an undeclared token drops its whole declaration silently, as a sibling sheet shipped) and that the panel is positioned out of flow.

Per-file coverage is 100% on statements, branches, functions, and lines with no `v8 ignore`.
