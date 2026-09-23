# Agent Note: Deferred self-compaction

Status: implemented

## Problem

A model calling compaction inside its own tool turn cannot synchronously wait for idle: the turn cannot end until the tool returns. Public idle status also covers maintenance, so a status check alone cannot admit compaction.

## Decision

The command-compact plugin has an explicit opt-in handForward configuration. Its tool validates the baton, records a generation, and returns before waiting on Agent.whenIdle. It then invokes existing compactNow, whose runMaintenance owns atomic admission, and submits one bootstrap through ordinary followup. No Agent, inbox, session storage or replay semantics change. This preserves durable parent identity rather than replacing the conductor.

Context accounting uses the exact latest request route and tokenMeter, not the display projection or billing. A missing capacity fails closed. The generic JSON result is model-visible; no custom UI or button is installed.

The generation journal is host audit state under DSH_HOME/hand-forward, separated by a hash of the session id. It remains outside compaction and outside session replay. A proper-lockfile renewable lease spans acceptance through audit completion. The baton-state.json snapshot holds both audit history and pending ownership; each transition uses temporary-file fsync, atomic rename and directory fsync. Expired crash leases self-heal on the next invocation after the configured staleMs bound, recording interrupted pending recovery without replay.

## Tradeoffs

The work waits for whole-agent idle, not every turn/end. Existing queued inputs can postpone compaction and retain their original order. A racing driver can win admission; the backend then refuses and the audit records failure rather than compacting live work. No automatic compaction retry, bootstrap replay, priority bootstrap, inactivity policy or transactional coupling of audit and inbox is provided. The recorded baton hash identifies accepted bytes; the later bootstrap reads the then-current file.

## Validation

Fixtures compose the real tool registry, ReactLoopAgent, token meter, BasicCompactionEngine, session persistence, workspace registry, sandbox policy, approval service and subagent continuation/spawn producer. A real fixture child starts before hand-forward and reports through reportFrom after compaction with quiet delivery; its report enters the bootstrap request. Assertions compare workspace membership, cwd, file policy, approval mode and selected request model before and after. Audit fixtures cover failed replacement, expired crash recovery, live-owner exclusion and minimum recovery age. A runnable-application snapshot remains outside these package fixtures.
