# Agent Note: Operator activity custody and final entry

Status: proposed

English | [中文](2026-10-09-operator-activity-transport-checkpoint.zh.md)

## Problem

The reviewed operator-activity/v1 specification requires socket-authenticated activity, authoritative native holds, durable gated receipts and checks at final model entry. A producer snapshot cannot survive an intervening Stop, Focus, goal, maintenance, foreground or transport change as release authority.

## Proposal

Connection supplies authenticated observations and current control revisions to the native driver. A diagnostic snapshot reports current eligibility without waking input. Fresh admission, a qualifying interaction or an authenticated hold-clear action can request native release; reads, Pong, reconnect and exact receipt retries cannot. No poller, second queue or runtime installation is introduced. The socket reader does not await the native-owned release flush: subsequent same-socket leave/Stop frames must invalidate the in-flight selection before that flush completes.

The existing native maintenance reservation selects at most ten ordered identities before flushing custody. The driver rechecks live eligibility and revisions after the flush, after claim observers and asynchronous preparation, before user acceptance, and at final adapter dispatch. An intervening log change across an await conservatively defers the selection. Internal synchronous log writes do not invalidate their own control check. The existing exact request marker carries the process-local final callback through stream middleware; no recorded tuple restores it. Pre-step middleware must preserve the exact ordered gated message objects: removal, rejection, reordering, duplication, replacement or injection defers custody instead of retiring it.

## Custody persistence

The required-on-read custody event retains complete ordered receipts before ordinary inbox insertion. It lets restart reconstruct interrupted insertion without a second queue and makes incompatible readers refuse execution. Staging alone is not durable custody; a participating successful Session flush is required before acknowledgement. Exact retries return the same ordered identities without mutation or wake, while conflicting payloads and ineligible mixed batches refuse new insertion.

The existing user/message commit remains native acceptance, not proof that a model or user saw the input. A pre-acceptance deferral restores receipt order ahead of late arrivals and does not cancel racing foreground input. A hold after native acceptance can still prevent adapter dispatch, but cannot retract or duplicate accepted history. No delivered ACK is emitted: eligible is only a current diagnostic, and held also covers a hold observed after a release attempt. Foreground insertion invalidates the selection even if that input is removed again; a foreground claim cannot absorb gated input. Maintenance retires an armed selection if no driver starts. Empty tool-continuation steps are not mistaken for unentered custody. Drivers retire process-local selections when they end; restart begins held with unknown Stop until explicit operator resume and fresh activity.

No persistence type or accepted history is changed. The inherited canonical persistence-history compatibility finding remains an explicit qualification obligation.

## Alternatives considered

Persisting release permission would revive obsolete activity after restart. Treating a snapshot as an irrevocable capability would miss post-flush and preparation races. A second inbox would duplicate native custody and idempotence. The implementation instead uses existing receipt, claim and user/message identities plus a disposable live selection.

## Acceptance criteria

The complete requirements remain in the reviewed specification, `2026-10-09-operator-activity-snapshot.md`. Deterministic HTTP/WS and native tests cover positive entry, hold races, ordered retry, bounded selection and fresh-process acceptance. These producer checks are not independent verification, whole-contract GUI/profile qualification or step70 acceptance. Existing installation owners retain exclusive activation authority.

## Risks

Raw authenticated socket tests do not prove trusted GUI DOM input. Native acceptance can precede middleware failure or a later hold, so custody and accepted history must never be labeled actual delivery. Persisted Stop/history qualification and assembled whole-contract review remain separate obligations. Old runtimes without v1 remain unsupported; no fallback inference or backport is implied.
