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

The tool returns `{ scheduled: true, generation, at_context_pct, context_tokens, context_capacity, provider, model }` after validation and audit, without waiting for compaction. Percentage uses tokenMeter request pressure and the exact logged request model's resolved capacity (agent options before a request); it is an estimate, not billing or an automatic threshold. Unknown capacity and concurrent route changes refuse scheduling.

At whole-agent idle, the existing `compactNow` reserves maintenance on the same Agent and Session. Successful compaction, including no compactable history, queues exactly one ordinary next-turn prompt: “Baton generation start. Read <baton_path> and Studio slug=conductor-relay, then give Nate one short state update.” Existing pending input retains ordinary ordering; this is not a bootstrap-priority queue or a fresh empty context. Child routing, configuration and replay are unchanged.

Audit records live in `<DSH_HOME>/hand-forward/<sha256(session-id)>/baton-generations.jsonl` (default home `~/.dsh`), overridable only by deployment `auditDirectory`. This host-owned location survives conversation compaction without extending session storage/replay. Each fsynced record includes generation, session, timestamp, provider/model, original-byte baton SHA256 and reason, plus scheduled/bootstrap-queued/failed status. A per-session exclusive lock rejects competing processes. A crash leaves the lock for manual inspection; scheduling is not replayed, and bootstrap exactly-once across crashes is not promised. Never delete a lock until its owning host has stopped and session/audit evidence has been reconciled.

The agent chooses cadence; no button, timer, inactivity policy or model switch is installed. The bootstrap costs one normal turn and compaction may cost a summarization request. Failures are recorded in the audit, not retried. Compaction failure never queues bootstrap; a failure after enqueue may leave that prompt delivered. Baton contents can change after acceptance; the hash identifies the version accepted, not a frozen copy. Continuous queued activity can postpone whole-agent idle.

## Known Limitations and Deferred Work

- **Idle-only** — `/compact` reports `busy` when a turn or already accepted waking prompt has right of way; the command itself is not queued.
- **No range or policy arguments** — the argument-free form keeps behavior stable across command adapters. Explicit ranges remain the programmatic `compactRegion()` path.
- **Command adapters only** — surfaces without `ctx.commands` cannot invoke it and rely on automatic pressure compaction.
