# Agent Note: Deferred self-compaction

Status: implemented

## Problem

A model calling compaction inside its own tool turn cannot synchronously wait for idle: the turn cannot end until the tool returns. Public idle status also covers maintenance, so a status check alone cannot admit compaction.

## Decision

The command-compact plugin has an explicit opt-in handForward configuration. Its tool validates the baton, records a generation, and returns before waiting on Agent.whenIdle. It then invokes existing compactNow, whose runMaintenance owns atomic admission, and submits one bootstrap through ordinary followup. No Agent, inbox, session storage or replay semantics change. This preserves durable parent identity rather than replacing the conductor.

Context accounting uses the exact latest request route and tokenMeter, not the display projection or billing. A missing capacity fails closed. The generic JSON result is model-visible; no custom UI or button is installed.

The generation journal is host audit state under DSH_HOME/hand-forward, separated by a hash of the session id. It remains outside compaction and outside session replay. An exclusive pending.lock spans acceptance through audit completion and detects competing host processes. The journal uses fsync; a stale lock after a crash requires inspection, not automatic replay.

## Tradeoffs

The work waits for whole-agent idle, not every turn/end. Existing queued inputs can postpone compaction and retain their original order. A racing driver can win admission; the backend then refuses and the audit records failure rather than compacting live work. No automatic retry, crash recovery, priority bootstrap, inactivity policy or transactional coupling of audit and inbox is provided. The recorded baton hash identifies accepted bytes; the later bootstrap reads the then-current file.

## Validation

Fixture tests exercise the real tool registry, ReactLoopAgent, token meter and BasicCompactionEngine with a scripted model and deterministic summary. They cover mid-turn deferral, same-instance maintenance, one queued bootstrap, duplicate/missing/empty refusal, cwd/model/header preservation and a late report-shaped message routed through durable parent identity. This last fixture is not a full subagent continuation integration test. Workspace/policy service preservation and a keyless application snapshot remain review gaps.
