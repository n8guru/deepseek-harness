---
description: "Host-side tailnet session directory: polls peer DSH Hosts' own session/list server-to-server and publishes a merged read-only view."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory

English

## Summary

`DshHostDirectoryService` runs inside a `dsh web` Host and polls a static list of
configured peer Hosts' own `session/list` Typert Remote method, server-to-server,
over the existing shared `/api` channel — the exact same wire endpoint a peer's
own browser Client calls. It merges the results into one snapshot, tagged with
each peer's declared `machine` label, and publishes that snapshot as its own
Typert Remote method, `dshHostDirectory/list`, for a Client plugin to poll over
the existing `ctx.connection.rpc`. No new wire protocol, no relay, no writes to
any peer session, `ClaudeSession`, `mesh-pump`, or `mesh-pull-dispatch` tables.

This is the R2 read side of dsh-mesh-session-view (Studio project 1479605, step
2), scoped by the Fable 5.1 architecture review's required redesign (R1–R6) and
Nate's 2026-09-03 decision (option A).

## Use this package

Mount alongside `plugin-inventory`, before the API gateway:

```yaml
- id: dsh-host-directory
  name: '@deepseek-ai/dsh-host-directory'
  config:
    machine: forge          # optional; defaults to os.hostname()
    pollIntervalMs: 5000    # optional; floor 1000ms
    peers:
      - machine: n8razer
        authority: 100.102.77.86:3080
        sessionCookie: 'dsh-auth-<hash>=<signed-value>'   # see below
```

`peers`, `pollIntervalMs`, and `machine` are ordinary `.volatile()` Config
fields (ships live-referenced through `this.config.<field>.get()`, exactly like
`dsh-bash-local`'s `timeoutMs`) — editing them through the profile's Cordis
patch, or the generic Settings form (`@deepseek-ai/dsh-settings`), takes effect
on the next poll tick with no Host restart, per `loader/volatile-update`. A
Host restart is required only once, to mount this plugin the first time.

### The `sessionCookie` bootstrap (read this before wiring a peer)

**Ground truth as of this build, later than the Fable 5.1 review this step
re-scopes from:** every `/api` request — including a server-to-server one —
now requires the peer's signed browser-session cookie (Agent Note
`2026-08-24-browser-token-authentication`, which landed *before* the review;
the review's Q3 answer, "the Host has no authentication layer to consume a
token," was already stale when it was written). There is **no non-browser
bearer** by design — that note explicitly declined a persistent launch-token
bearer as an alternative. This package invents no second credential: it sends
the exact same cookie a browser holds.

To authorize this Host to poll a peer:

1. Start (or already have running) `dsh web` on the peer. Its stdout prints
   `dsh web: http://<peer-authority>/?token=<one-time-token>` once per process
   start.
2. Exchange that token for a signed cookie once, from *any* machine that can
   reach the peer (a laptop browser, or `curl -i` from this Host itself):
   ```sh
   curl -i "http://<peer-authority>/?token=<one-time-token>"
   ```
   The response's `Set-Cookie` header carries `dsh-auth-<sha256(authority)>=<value>; ...`.
3. Copy the full `name=value` pair (just those two fields, not the `Max-Age`/
   `Path`/etc. attributes) into that peer's `sessionCookie` config field on
   *this* Host.
4. The cookie is authority-bound and durable (default 30-day lifetime,
   survives peer restarts) — this is a one-time bootstrap per peer pair, not a
   per-poll ceremony. It stops working only if the peer's operator deletes its
   `client-connection/browser-session` credential record (global revocation)
   or the 30-day lifetime elapses; either surfaces immediately as a `401` in
   that peer's `DshHostPeerStatus`.

An absent or expired `sessionCookie` fails closed and visibly: the peer's row
in `list()` reports `status: { state: 'unreachable', message: '...' }`
naming the cause (missing cookie vs. `401`/`403`) — it is never silently
skipped, and no session for that peer is ever fabricated or guessed.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`syncPeers()` runs once at construction and again on every `loader/volatile-update`
(a live Config edit), reconciling the tracked peer map against the current
`peers.get()` value — added peers start `never-polled`, removed peers are
dropped, and an updated peer's cookie/scheme takes effect on its next tick
without losing its last-known sessions. `rearmTimer()` only restarts the
`setInterval` when `pollIntervalMs` actually changed, so an unrelated Config
edit never resets the phase of an already-running poll loop.

`pollOnePeer` sends a plain `fetch()` `POST <scheme>://<authority>/api/session/list`
with the exact wire envelope shape browsers use
(`{ type: 'client-request', rpcId, method: 'session/list', payload: {} }`,
`Cookie: <sessionCookie>`), and maps `SessionSummary` rows into
`DshHostRemoteSession`, tagging each with the peer's declared `machine`. A
failure (network error, non-2xx, `result.ok === false`) never throws out of
the poll loop — it's captured into that peer's `DshHostPeerStatus.unreachable`
with the causing message, and that peer's session rows are cleared (a session
this Host cannot currently confirm is never shown as live). `list()` never
performs I/O itself; it always returns the last poll's result, so a Client
reading it is never blocked on network latency.

No invariant companion beyond the standard no-op registration: this package
owns no durable cross-request state — the peer map is an in-memory poll cache,
rebuilt from Config and live network reads on every tick.

</details>

## Further Exploration

- [`@deepseek-ai/dsh-host-plugin-inventory`](../plugin-inventory/README.md) — the sibling package this one's Typert Remote shape mirrors.
- [`@deepseek-ai/dsh-api-session-controller`](../../api/session-controller/README.md) — owns the `session/list` endpoint this package polls on every peer.
- Agent Note [`2026-08-24-browser-token-authentication`](../../../.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.md) — the auth layer `sessionCookie` satisfies.
- `/home/n8/forge-agent-os/tools/fleet-fix/results/dmsv-2.md` — this step's deploy procedure per host.

## Model Experience

None, as this Host-only directory poller registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Static peer list, no auto-discovery** — per the Fable 5.1 review's R2, peers are operator-declared, not discovered via `tailscale status --json`. Adding that discovery is future work, not required for R2.
- **No push, only poll** — a session started/ended on a peer is reflected within one `pollIntervalMs` window on this Host, never instantly; pushing via `host/remote-event` would need a core allowlist entry the review flagged as out of scope for a plugin.
- **Cookie rotation is manual** — if a peer's operator revokes its `client-connection/browser-session` credential record, every configured cookie for that peer goes stale simultaneously and must be re-bootstrapped by hand; there is no automatic re-exchange (the launch token is one-shot and only printed at peer process start).
- **No write path** — this package never opens, steers, or answers a peer's session; that is out of scope for R2 and belongs to the deep-link (row 4) and allow-remote-steer (row 5) steps.
