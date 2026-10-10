# @deepseek-ai/dsh-client-ui-peer-sessions

English | [中文](README.zh.md)

Client plugin that polls `ctx.remote.dshHostDirectory.list()`, the Typert Remote published by [`@deepseek-ai/dsh-host-directory`](../../host/dsh-host-directory/README.md) over the existing `/api` channel, and keeps the latest merged peer-session directory in a store. The store is provided as the Context service `ctx.dshPeerSessions`, a `SnapshotStore<DshPeerSessionsState>` built with `createSnapshotStore` from [`@deepseek-ai/dsh-client-runtime`](../runtime/README.md). The plugin registers no slot and renders nothing; [`@deepseek-ai/dsh-client-ui-workspace`](../ui-workspace/README.md) reads the store to render peer machine groups in the sidebar.

## Configuration

Mount the plugin after `@deepseek-ai/dsh-host-directory` (Host side) and the Remote assembly:

```yaml
- id: ui-peer-sessions
  name: '@deepseek-ai/dsh-client-ui-peer-sessions'
```

The plugin has no configuration and injects `remote` and `remote.dshHostDirectory`. A consumer shares the store through `ctx.dshPeerSessions`; it does not construct a second `createDshPeerSessionsStore()` or poll the Remote again, and a build without this plugin simply shows no peer groups.

## Store state and polling

`DshPeerSessionsState` holds `snapshot`, the last successfully read `DshHostDirectorySnapshot` (`undefined` before the first poll settles), and `lastPollFailed`.

`startDshPeerSessionsPoll` calls `list()` on mount and then every 5 seconds (`options.pollIntervalMs` is a test seam). A successful poll replaces `snapshot` wholesale and clears `lastPollFailed`. A failed RPC sets `lastPollFailed` without touching the last good `snapshot`, so one transient failure never blanks the directory. Peer-level failures are not RPC failures: they arrive inside `snapshot.peers[].status` from the Host. `dispose()` aborts an in-flight poll so a late result is dropped instead of written into a torn-down store.

## Pending input

When a peer enables `pollPendingInput` in `dsh-host-directory`, some `snapshot.sessions[]` rows carry a read-only `pendingInput` of kind `question` or `approval`, passed through verbatim from the Host snapshot. A consumer renders it as a notice that names the owning Host plus a deep link the operator opens; this package has no write path into any peer session.

## Model Experience

None, as this Client-only directory poller registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **No rendering** — the package only publishes the store; grouping and deep-link opening belong to the consumer.
- **No backoff** — a persistently failing directory polls at the same fixed 5-second interval, which is acceptable because each poll only reads this Host's already-computed snapshot.
- **Fixed interval** — the Client interval is not configurable; actual freshness is governed by the Host's `pollIntervalMs`.
- **Read-only** — the store offers no steer, answer, or approve operation; steering a peer session happens only by opening the owning Host's own origin.
