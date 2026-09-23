# @deepseek-ai/dsh-command-compact

English | [中文](README.zh.md)

Human-facing `/compact` control over [`ctx.compaction`](../compaction/README.md). The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md), so every composed command adapter discovers and executes it without a model turn. The [queued manual compaction Agent Note](../../../.agents/notes/implemented/feature/2026-07-30-queued-manual-compaction.md) owns the admission, lock, and durability decisions.

## Command contract

| Input | Result |
|---|---|
| `/compact` | Summarize one useful balanced older span even below automatic pressure, then report the replaced history-item count and estimated tokens after the standalone bracket is flushed. |
| `/compact` with no compactable history | `No compactable history yet.` — no marker or surface mutation is written. |
| `/compact <anything>` | `Usage: /compact (no arguments)` — the command takes no arguments and calls no compaction backend. |

The command is backend-independent: it depends only on `compactNow(agent, signal)`. The invoking agent is the exact target, and the dispatching UI's cancellation signal is forwarded through the seam. Every resolved invocation records the executor-owned log-only pair `command/run` / `command/done`; neither event joins model history. On success, `command/done.sourceEventSeq` names the transaction's `compaction/summary` event so a presentation can fold the command lifecycle into its checkpoint without parsing result text or assuming adjacent rows.

Expected `ManualCompactionError` codes become stable direct errors:

| Code | Direct result |
|---|---|
| `busy` | `Compaction is unavailable because this process has an active compaction, or the agent is not idle.` |
| `changed` | `The history selected for compaction changed before it could be replaced. The conversation is unchanged; the attempt is recorded in the session log.` |
| `summary` | `Compaction could not produce a useful summary. The conversation is unchanged; the attempt is recorded in the session log.` |
| `commit` | `Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.` |
| `persistence` | `Compaction finished, but the session could not be saved.` |

The busy result is intentionally process-scoped: a live unmatched marker blocks, while a marker older than the newest `session/end-seed` is stale and does not. Unexpected implementation failures reject dispatch. Cancellation remains authoritative; the backend completes its required close/flush cleanup, and the command settles internally as `Compaction cancelled.` while the command executor stops waiting with its cancellation error. Plugin disposal first unregisters `/compact`, then drains every handler that already started, so root teardown cannot pass an aborted command's close or flush boundary.

Prompts submitted while compaction runs remain accepted in the agent's ordinary FIFO with the same identity and wakeup facts. They start only after the compaction's explicit durability checkpoint and admission release. Idle injected context is not held: it may be logged between `compaction/start` and `compaction/end`, and positional replacement leaves it visible after the checkpoint.

## Composition

The producer injects `commands` and `compact`. Mount the command registry, one backend, and this plugin:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
- id: command-compact
  name: '@deepseek-ai/dsh-command-compact'
```

The shipped `dsh` base mounts it beside `compaction-basic`, and the Web client provides the command adapter. Automation surfaces that compose no command adapter keep automatic compaction only.

## Model Experience

### Human `/compact` control

#### What the model sees

The slash input and direct result never enter a model request. An accepted compaction separately replaces an older span with the backend's user-role checkpoint inside a standalone `compaction/* { turn: null }` bracket.

#### Token effect

The command lifecycle adds no model tokens. A successful compaction reduces later requests by replacing the selected span with one framed summary; summarization itself is one auxiliary request.

#### KV Cache effect

Discovery and command bookkeeping do not affect the cache. The accepted surface replacement invalidates reuse from the first shadowed history token.

## Opt-in hand_forward tool

Set `config.handForward: {}` on this plugin only in the intended conductor composition, with `tools`, `agents`, `sessions`, `llm`, `tokenMeter`, and `fs` available. No shipped composition enables it. The generic-rendered tool accepts `{ reason, baton_path? }`; `batonPath` config defaults to `/home/n8/forge-agent-os/tools/CONDUCTOR-BATON.md`. `maxBatonBytes` defaults to one MiB. Missing, nonregular, empty, invalid UTF-8, oversized batons and duplicate pending calls are refused.

The tool returns `{ scheduled: true, generation, at_context_pct, context_tokens, context_capacity, provider, model }` after validation and audit, without waiting for compaction. Percentage uses tokenMeter request pressure and the exact logged request model's resolved capacity (agent options before a request); it is an estimate, not billing or an automatic threshold. Unknown capacity and concurrent route changes refuse scheduling. Read-only preflight (resolve, stat, read, and model lookup) shares one `idleTimeoutMs` deadline from invocation, separate from the later scheduled idle deadline. Each await races timeout, caller cancellation, and plugin shutdown, even if the backend ignores cancellation. Expiry returns the visible tool error `hand_forward abandoned: preflight timed out` and logs it; no generation or audit file is created. Admission is tracked from entry and its local pending slot is released on rejection. Late backend fulfillment/rejection is observed but cannot proceed to another validation step, claim ownership, or act after timeout/disposal. Audit acquisition/publication is deliberately outside that read-only race: outstanding writes must settle before unlocking.

At whole-agent idle, the existing `compactNow` reserves maintenance on the same Agent and Session. Successful compaction, including no compactable history, queues exactly one ordinary next-turn prompt: “Baton generation start. Read <baton_path> and Studio slug=conductor-relay, then give Nate one short state update.” Existing pending input retains ordinary ordering; this is not a bootstrap-priority queue or a fresh empty context. Child routing, configuration and replay are unchanged.

Audit history and pending ownership share `<DSH_HOME>/hand-forward/<sha256(session-id)>/baton-state.json` (default home `~/.dsh`), overridable by deployment `auditDirectory`. Each transition writes a private temporary file, fsyncs it, atomically renames it and fsyncs the directory: a crash cannot expose half a journal record or mismatched pending state. Records contain generation, session, timestamp, provider/model, original-byte baton SHA256, reason and status. A `node:sqlite` BEGIN IMMEDIATE writer reservation on adjacent `baton-mutex.sqlite` excludes other owners across the entire operation, including idle waits and snapshot renames. It is a kernel-backed mutex, not session storage. A delayed or suspended live owner is never displaced by age; process death releases its reservation. Snapshot version 2 persists a monotonically increasing `owner_epoch`, also carried in pending and journal entries. Every publication re-reads and compares the persisted epoch under that reservation; the same check runs immediately before compaction and bootstrap. Thus the comparison and rename cannot race a conforming successor. `staleMs` defaults to 120000 (minimum 5000) and only bounds the age of abandoned pending work: after acquiring the reservation, an older interrupted pending record is cleared with a logged reason, never replayed. Unknown/legacy snapshot versions fail closed; there is no live migration. Use a local filesystem with reliable SQLite locking; never delete/replace the mutex file while a host may own it. Audit and session inbox are separate transactions: bootstrap exactly-once across crashes is not promised. This is host audit storage, not a session format/replay change.

The agent chooses cadence; no button, cadence timer, inactivity policy or model switch is installed. The bootstrap costs one normal turn and compaction may cost a summarization request. Post-admission failures are recorded in the audit, not retried. Compaction failure never queues bootstrap; a failure after enqueue may leave that prompt delivered. Baton contents can change after acceptance; the hash identifies the version accepted, not a frozen copy. `idleTimeoutMs` (default 600000) bounds the scheduled idle wait. Expiry records abandonment, emits `hand_forward abandoned: session never idle` as a visible plugin-source transcript notice without waking a turn, and releases the reservation after its audit write settles. A late idle resolution cannot compact. `watchdogMs` (default 300000) warns once per compaction/bootstrap phase, including bootstrap drain to whole-agent idle. It logs an error, a durable audit entry, and the same visible notice; it NEVER expires ownership or races a running side effect against unlock. `disposeTimeoutMs` (default 10000) bounds this plugin's drain: abort cooperatively, then warn and return while an unresponsive effect retains its reservation. All three durations must be positive safe integer milliseconds within Node's timer range. Notices add ordinary plugin-source context tokens; they do not create a new event/replay format. These deadlines require a responsive event loop; stalled filesystem I/O cannot safely be unlocked while a publication is outstanding.

Supervised recovery: stop new admission externally; identify the exact owning DSH host and record session ID, audit path, epoch/generation and watchdog phase. With explicit operator authorization (other sessions may be interrupted), restart that host using its existing supervisor and confirm the old PID has exited. Never unlink the mutex or clear pending manually. Inspect the atomic snapshot and session compaction/bootstrap events after restart; interrupted pending work may be abandoned only after `staleMs` under a newly acquired reservation. Verify the next epoch strictly increases and all old generation records survive. Do not blindly replay a bootstrap that may already have been delivered. Root shutdown can still wait on other plugins; the bounded guarantee here is this plugin's disposal only.

## Opt-in context nudge

Set `config.contextNudge: {}` on this plugin only in the intended conductor composition, with `systemPrompt` and `sessionProjections` available. No shipped composition enables it. The plugin registers one dynamic prompt-context entry (`compaction:context-nudge`) that runs on every pre-step assembly for the composed scope and contributes at most one short line:

- below `warnPct` (default 25): nothing — zero tokens, no notice;
- at or above `warnPct`: `context 26% — look for a natural break; hand_forward at 30%`;
- at or above `actPct` (default 30): `context 31% — call hand_forward at the end of this turn (baton: tools/CONDUCTOR-BATON.md)`;
- 40 turns (`maxTurnsWithoutForward`) without a `hand_forward` call: a staleness line naming the turn count;
- an idle gap before the current turn longer than 90 minutes (`idleGapMs`): `resuming after idle; re-read baton state first`.

Pressure is `pressureTokens / contextWindow` from the host's own `contextPressure` projection — the same source the Web client reads — never a recount. Turn position, forwarding staleness, and the idle gap fold from committed session events only. The nudge never compacts and never calls `hand_forward`; `handForward` (above) remains the only actor. All thresholds are validated config fields: `warnPct`, `actPct`, `maxTurnsWithoutForward`, `idleGapMs`, and `batonPath`.

Conductor opt-in (preset or profile patch layer; replaces the row's whole config):

```yaml
- id: command-compact
  name: '@deepseek-ai/dsh-command-compact'
  config:
    handForward: {}
    contextNudge: {}
```

## Known Limitations and Deferred Work

- **Idle-only** — `/compact` reports `busy` when a turn or already accepted waking prompt has right of way; the command itself is not queued.
- **No range or policy arguments** — the argument-free form keeps behavior stable across command adapters. Explicit ranges remain the programmatic `compactRegion()` path.
- **Command adapters only** — surfaces without `ctx.commands` cannot invoke it and rely on automatic pressure compaction.
