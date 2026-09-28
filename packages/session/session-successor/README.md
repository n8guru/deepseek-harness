# @deepseek-ai/dsh-session-successor

English | [中文](README.zh.md)

Durable old→successor session lineage for cadence hand-forward. When a new generation takes over, the old session's log gets exactly one log-only `session/successor` event carrying `{successorSessionId, successorGeneration, handoffId}`. The `successor` projection key serves that fact, so `session.list` rows, the history tail page and mux `session/projection` frames carry it with no bespoke wire path. It stays visible after the old session is archived and after reload or reconnect.

## Service: `SessionSuccessorService` (ctx key: `sessionSuccessor`)

- `get(session)` folds the first `session/successor` event, or `null`.
- `record(old, request, options?)` appends the fact only when the successor is ready. Readiness has two parts. First, the successor's log holds a committed `turn/end` whose reason is `completed`; the successor is flushed before this check. Creating the session, accepting a prompt, or having a turn running is not enough. Second, the current-pointer resolve names exactly that successor. That value is either `request.pointerSessionId`, which the caller resolved from the Forage conductor pointer, or `options.resolvePointer()` when a deployment supplies a live resolver. After appending, the old log is flushed before `record` returns, so the fact is durable before any archive.
- Claims are serialized per old session and are idempotent by `handoffId`: the same hand-off returns `status: 'existing'`. Every refusal throws `SessionSuccessorError` and leaves the old log unchanged, so the old session stays selected and unarchived. The refusal codes are `invalid`, `old-not-live`, `self-link`, `conflict` (a different successor or hand-off already exists), `cycle` (the successor's live lineage leads back to the old session), `wrong-workspace` (header cwd differs, or the optional `sameWorkspace` hook says no), `successor-not-live`, `successor-not-ready` and `pointer-mismatch`.

The invariant companion rejects a second `session/successor` event and a self-link, whichever writer produced them.

## Composition

Mounted by the base bundle beside `session-title`. The projection unit activates only when a projection registry is composed. The agent-callable writer is the opt-in `record_successor` tool of `@deepseek-ai/dsh-command-compact`, mounted with `handForward`. It archives the old session after the durable append. The Web client follower lives in `@deepseek-ai/dsh-client-ui-conversation` (`successor/follow.ts`).

## Model Experience

None, as the plugin only appends and folds a log-only `session/successor` event and touches no prompt, message, schema, stream, or tool result; the opt-in `record_successor` tool that writes it is documented by `@deepseek-ai/dsh-command-compact`.

#### KV Cache effect

None; the plugin never assembles or sends provider requests.

## Known Limitations and Deferred Work

- The cycle check walks live sessions only. A lineage link held only by a cold, unloaded session is not followed.
- The host does not call Forage. The pointer claim is the caller's resolve unless a deployment supplies `resolvePointer`.
- The Hub slide-in (studio-dashboard 35) follows the Forage conductor pointer itself and never reads this lineage.
