# @deepseek-ai/dsh-host-directory

English | [中文](README.zh.md)

`DshHostDirectoryService` runs inside a `dsh web` Host and polls a static list of configured peer Hosts server-to-server. Each poll POSTs `/api/session.list` (API Proxy method `session.list`, payload `{}`) to the peer, the same wire endpoint the peer's own browser Client calls, and merges the rows into one snapshot tagged with each peer's declared `machine` label. The snapshot is published as the Typert Remote `dshHostDirectory/list`, which a Client plugin reads over the existing shared `/api` channel. The package adds no wire protocol, no relay, and no write to any peer session.

## Configuration

Mount the plugin alongside [`plugin-inventory`](../plugin-inventory/README.md) before the API gateway:

```yaml
- id: dsh-host-directory
  name: '@deepseek-ai/dsh-host-directory'
  config:
    machine: forge
    pollIntervalMs: 5000
    peers:
      - machine: n8razer
        authority: 100.102.77.86:3080
        pollPendingInput: false
```

`machine` labels this Host in the directory and defaults to `os.hostname()`. `pollIntervalMs` defaults to 5000 and is floored at 1000. Each peer takes `machine`, `authority`, an optional `scheme` (`http` by default), an optional `sessionCookie`, and an optional `pollPendingInput`. All three top-level fields are plain plugin config: changing an entry reloads the plugin, which rebuilds the peer table from the new values, and no Host restart is needed.

## Peer access

The rc.8 `/api` route is guarded by a Host-header check against the peer's trusted hosts (loopback, LAN literals, or a declared `--trusted-host`), not by an auth layer. A peer admits the poll when this Host's authority is among its trusted hosts, so the poll sends no credential. `sessionCookie` is an optional pass-through that is forwarded verbatim as a `Cookie` header and is normally omitted; it is marked secret so configuration UIs never read it back.

An unreachable peer is reported, never hidden. Its row in `list()` carries `status: { state: 'unreachable', message }` naming the cause (network error, a `401`/`403` rejection, a non-2xx status, or an error result), and its session rows are cleared so a session this Host cannot confirm is never shown as live. One peer's failure does not block another's poll. `list()` itself performs no I/O and returns the result of the last poll.

## Pending-input classification

Setting `peers[].pollPendingInput: true` costs one extra `POST /api/session.history` per session per tick (`maxMessages: 20`). `classifyPendingInput` then reports the most recent unresolved human-input request as `pendingInput` on that session row: an open `ask_user_question` tool call, or an open `approval/asked` with no `approval/decided`. A question takes precedence over an approval. A session with nothing pending carries no `pendingInput` key. A failed history read omits that one session's classification for the tick and never marks the peer unreachable. The option is off by default.

## allow-remote-steer gate

Steering a peer session means opening it on its owning Host's own origin, where the composer issues the normal write RPCs. This package adds a per-session opt-in on that owning Host, default OFF, enforced through `ctx.connection.rpc.guard('/api', ...)`.

- **Remote versus owner.** A request whose `Host` authority is not loopback is remote and must hold the opt-in. A loopback request is the owner at the keyboard and is never gated.
- **Gated verbs.** `session.prompt`, `session.updateQueue`, `session.cancel`, `session.selectModel`, `session.fork`, and `session.rename` (the `session/...` spellings are also listed), plus the opt-in setter itself. Reads and the approval and question answer channel are not gated.
- **Opt-in.** The Remotes `dshHostDirectory/allowRemoteSteer({ sessionId })` and `dshHostDirectory/setAllowRemoteSteer({ sessionId, allow })` read and change it. A remote origin cannot call the setter. State is in memory, so a Host restart returns every session to OFF.
- **Mesh-pump sessions are never eligible.** A `session-mesh-` session id, or a prompt whose rpcId starts with `mesh-dispatch-`, marks the session pump-owned: the setter refuses it and any existing opt-in is revoked.
- **Refusals.** A denied steer reaches the caller as an `internal` RPC error whose message starts `dsh-host/steer-denied:`.

## Model Experience

None, as this Host-only directory poller registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Static peer list** — peers are operator-declared; there is no discovery, for example from `tailscale status --json`.
- **Poll only** — a session started or ended on a peer appears within one `pollIntervalMs` window, never instantly, and the poll reads only the first page of `session.list`.
- **Generic error code** — rc.8 folds any thrown error into the closed `internal` RPC code, so `dsh-host/steer-denied` travels only as the message prefix.
- **Read-only listing** — this package never opens, steers, or answers a peer session; steering happens only by opening the owning Host's own origin, under the allow-remote-steer gate.
- **Pending-input is best-effort** — only the latest 20 history messages are inspected, and the summary text is not truncated or sanitized, so a consumer on an untrusted surface should bound what it displays.
- **Peer must trust this Host** — a peer whose trusted hosts omit this Host's authority rejects the poll, and the row shows `unreachable`.
