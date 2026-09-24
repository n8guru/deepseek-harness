---
description: "R2 client half: polls this Host's own dshHostDirectory/list Remote over the existing ctx.connection.rpc and keeps a peer-session snapshot store."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-peer-sessions

English

## Summary

Polls `ctx.remote.dshHostDirectory.list()` — the Typert Remote published by
`@deepseek-ai/dsh-host-directory` over the existing `/api` channel, no new
wire protocol — on a fixed interval and keeps a `SnapshotStore` fed with the
latest merged peer-session directory. Registers no slot and renders nothing:
this is the R2 read side of dsh-mesh-session-view (Studio project 1479605,
step 2). Grouping peer rows into `sidebar.workspaces` with `machine` labels
and status dots is step 4's scope (deep-link open-on-click), which reads
`createDshPeerSessionsStore`'s handle through ordinary store sharing rather
than duplicating the poll.

## Use this package

Mount after `@deepseek-ai/dsh-host-directory` (Host side) and the Remote
assembly:

```yaml
- id: ui-peer-sessions
  name: '@deepseek-ai/dsh-client-ui-peer-sessions'
```

No configuration. A consumer that needs the live snapshot shares this
plugin's store handle through the same registration mechanism the store
stack already uses (`AGENTS.md` "Stores" rule) — it does not construct a
second `createDshPeerSessionsStore()` and does not poll `ctx.remote` a
second time.

### `pendingInput` (dsh-mesh-session-view step 6)

When a peer's `dsh-host-directory` has `pollPendingInput` enabled for it,
some `snapshot.sessions[]` rows may carry a read-only `pendingInput: {
kind: 'question' | 'approval', toolName?, summary? }` — that session's
most recent unresolved `ask_user_question` or `approval/asked`, passed
through verbatim from the Host's snapshot; this package computes nothing
about it. A future consumer (step 4's sidebar rows, or any other read-only
surface reading this store) should render a plain notice naming the owning
host plus a deep link the operator opens themselves — matching
`app/session_inspector.py` / `hub-session-inspector.js`'s Hub-side pattern —
**never** a form control that answers, decides, or steers from here. This
package/store owns no write path into any peer session (R2/R6 invariant),
and `pendingInput` does not change that.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`startDshPeerSessionsPoll` calls `list()` immediately on mount, then on a
5-second interval (test seam: `options.pollIntervalMs`). A successful poll
replaces the store's `snapshot` wholesale and clears `lastPollFailed`. A
failed poll (RPC error, not a peer-level failure — those already live inside
`snapshot.peers[].status` from the Host) sets `lastPollFailed` without
touching the last good `snapshot`, so a single transient RPC hiccup never
blanks an otherwise-current directory. `dispose()` is idempotent-safe: it
flips a closure-local flag checked before every state write, so an in-flight
`list()` call that resolves after disposal is silently dropped instead of
writing into a torn-down store.

</details>

## Further Exploration

- [`@deepseek-ai/dsh-host-directory`](../../host/dsh-host-directory/README.md) — the Host-side poller and Remote this package consumes.
- [`@deepseek-ai/dsh-client-store`](../store/README.md) — `createSnapshotStore`, the store primitive this package builds on.
- `/home/n8/forge-agent-os/tools/fleet-fix/results/dmsv-2.md` — this step's deploy procedure per host.

## Model Experience

None, as this Client-only directory poller registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **No sidebar rendering** — deliberately out of scope for this row; a consumer plugin (step 4) reads the store this package publishes.
- **No backoff** — a persistently failing Host-side directory (e.g. every peer down) polls at the same fixed interval rather than backing off; acceptable because the Host side already rate-limits itself per peer and this poll only reads this Host's own already-computed snapshot.
