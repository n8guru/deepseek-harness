# Agent Note: Deferred self-compaction

Status: implemented

## Problem

A model calling compaction inside its own tool turn cannot synchronously wait for idle: the turn cannot end until the tool returns. Public idle status also covers maintenance, so a status check alone cannot admit compaction.

## Decision

The command-compact plugin has an explicit opt-in handForward configuration. Its tool validates the baton, records a generation, and returns before waiting on Agent.whenIdle. It then invokes existing compactNow, whose runMaintenance owns atomic admission, and submits one bootstrap through ordinary followup. No Agent, inbox, session storage or replay semantics change. This preserves durable parent identity rather than replacing the conductor.

Context accounting uses the exact latest request route and tokenMeter, not the display projection or billing. A missing capacity fails closed. The generic JSON result is model-visible; no custom UI or button is installed.

The generation journal is host audit state under DSH_HOME/hand-forward, separated by a hash of the session id. It remains outside compaction and outside session replay. An adjacent SQLite BEGIN IMMEDIATE reservation spans acquisition through audit completion, including all awaited work. Time cannot displace a potentially live owner; process death releases the kernel lock. Snapshot version 2 carries a monotonic owner_epoch in addition to history and pending state. Every write re-reads that epoch while retaining the reservation through temporary-file fsync, rename and directory fsync. Compaction and bootstrap perform the same synchronous persisted fence check immediately before admission. This is not a check-then-unlocked-rename lease scheme. After exclusive acquisition, old interrupted pending work is recovered with a reason rather than replayed. Unsupported old audit versions fail closed; session persistence/replay is untouched.

## Tradeoffs

The work waits for whole-agent idle, not every turn/end. Existing queued inputs can postpone compaction and retain their original order. A racing driver can win admission; the backend then refuses and the audit records failure rather than compacting live work. No automatic compaction retry, bootstrap replay, priority bootstrap, inactivity policy or transactional coupling of audit and inbox is provided. The recorded baton hash identifies accepted bytes; the later bootstrap reads the then-current file.

## Validation

Fixtures compose the real tool registry, ReactLoopAgent, token meter, BasicCompactionEngine, session persistence, workspace registry, sandbox policy, approval service and subagent continuation/spawn producer. A real fixture child starts before hand-forward and reports through reportFrom after compaction with quiet delivery; its report enters the bootstrap request. Assertions compare workspace membership, cwd, file policy, approval mode and selected request model before and after. Audit fixtures cover failed replacement, delayed-heartbeat live-owner refusal, stale-handle and persisted-epoch rejection preserving generation 2, actual subprocess death recovery and minimum recovery age. Integration fault fixtures prove a mismatched authoritative epoch prevents compaction and bootstrap. A runnable-application snapshot remains outside these package fixtures.
